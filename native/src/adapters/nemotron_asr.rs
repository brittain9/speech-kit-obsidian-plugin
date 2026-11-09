//! Cache-aware Nemotron English and multilingual RNNT adapter.
//!
//! The graph contract and inference behavior follow the pinned Apache-2.0
//! sherpa-onnx exporter/runtime and NVIDIA NeMo frontend recorded in the Stage
//! A artifact document. This is a native Rust implementation over this
//! project's existing ONNX Runtime, not a sherpa-onnx or NeMo binding.

use std::collections::HashMap;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

use ort::session::Session;
use ort::value::{TensorElementType, ValueType};

use super::nemo_rnnt::{
    NemoTokenizer, OnlineNemoFeatures, dimension, graph_shape_error, output_at, tensor_f32,
    tensor_f32_exact, tensor_i64_exact, tensor_ref,
};

use crate::engine::capabilities::{
    LanguageSupport, ModelFamilyCapabilities, ModelFamilyId, ModelTask, RuntimeId,
};
use crate::engine::traits::{
    LoadedModel, ModelFamilyAdapter, StreamingModel, StreamingPartialCadence,
};
use crate::protocol::{TimestampGranularity, TimestampSource, TranscriptSegment};
use crate::runtimes::onnx::build_session;
use crate::transcription::{
    AUTOMATIC_LANGUAGE_TAG, EngineTranscriptOutput, GpuConfig, TranscriptionError,
    validate_model_path,
};

const SAMPLE_RATE: usize = 16_000;
const FEATURE_DIM: usize = 128;
const MAX_SYMBOLS_PER_FRAME: usize = 10;
const EN_US_PROMPT_INDEX: i64 = 0;
const AUTO_PROMPT_INDEX: usize = 101;
const EXPECTED_WINDOW_SIZE: usize = 65;
const EXPECTED_SUBSAMPLING_FACTOR: usize = 8;
const EXPECTED_ENCODER_DIM: usize = 1_024;
const EXPECTED_CACHE_CHANNEL_LAYERS: usize = 24;
const EXPECTED_CACHE_TIME_WIDTH: usize = 8;
const EXPECTED_PREDICTOR_LAYERS: usize = 2;
const EXPECTED_PREDICTOR_HIDDEN: usize = 640;

const ENCODER_FILENAME: &str = "encoder.int8.onnx";
const DECODER_FILENAME: &str = "decoder.int8.onnx";
const JOINER_FILENAME: &str = "joiner.int8.onnx";
const TOKENS_FILENAME: &str = "tokens.txt";
const MODEL_TYPE: &str = "EncDecRNNTBPEModelWithPrompt";
const ENGLISH_MODEL_TYPE: &str = "EncDecHybridRNNTCTCBPEModel";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NemotronVariant {
    English,
    Multilingual,
}

#[derive(Clone, Copy)]
struct LanguagePrompt {
    product_tag: &'static str,
    metadata_key: &'static str,
    index: i64,
}

const SUPPORTED_LANGUAGE_PROMPTS: &[LanguagePrompt] = &[
    LanguagePrompt {
        product_tag: "auto",
        metadata_key: "auto",
        index: 101,
    },
    LanguagePrompt {
        product_tag: "en",
        metadata_key: "en-US",
        index: 0,
    },
    LanguagePrompt {
        product_tag: "es",
        metadata_key: "es-US",
        index: 3,
    },
    LanguagePrompt {
        product_tag: "de",
        metadata_key: "de-DE",
        index: 9,
    },
    LanguagePrompt {
        product_tag: "fr",
        metadata_key: "fr-FR",
        index: 8,
    },
    LanguagePrompt {
        product_tag: "pt",
        metadata_key: "pt-PT",
        index: 13,
    },
    LanguagePrompt {
        product_tag: "it",
        metadata_key: "it-IT",
        index: 15,
    },
    LanguagePrompt {
        product_tag: "nl",
        metadata_key: "nl-NL",
        index: 16,
    },
    LanguagePrompt {
        product_tag: "ja",
        metadata_key: "ja-JP",
        index: 10,
    },
    LanguagePrompt {
        product_tag: "hr",
        metadata_key: "hr-HR",
        index: 29,
    },
];

/// The prompt table is the authority on what this model can transcribe: an
/// index here is a real entry in the pinned `processor_config.json`
/// `prompt_dictionary`. Deriving advertised support from it means the two can
/// never disagree.
fn supported_language_tags() -> Vec<String> {
    SUPPORTED_LANGUAGE_PROMPTS
        .iter()
        .filter(|prompt| prompt.product_tag != AUTOMATIC_LANGUAGE_TAG)
        .map(|prompt| prompt.product_tag.to_string())
        .collect()
}

static CAPABILITIES: LazyLock<ModelFamilyCapabilities> =
    LazyLock::new(|| ModelFamilyCapabilities {
        task: ModelTask::Stt,
        // ORT partitions the int8 encoder across CUDA and CPU with hundreds of
        // inserted copies; the resulting hybrid session is slower than CPU.
        supports_hardware_acceleration: false,
        available_voices: Vec::new(),
        supports_speed_control: false,
        output_sample_rate: None,
        supports_segment_timestamps: false,
        supports_word_timestamps: false,
        supports_initial_prompt: false,
        supports_streaming: true,
        supports_language_selection: true,
        supports_automatic_language_detection: true,
        supported_languages: LanguageSupport::List {
            tags: supported_language_tags(),
        },
        max_audio_duration_secs: None,
        produces_punctuation: true,
    });

fn prompt_index_for_language(language: &str) -> Option<i64> {
    SUPPORTED_LANGUAGE_PROMPTS
        .iter()
        .find_map(|prompt| (prompt.product_tag == language).then_some(prompt.index))
}

fn validate_language_prompts(
    prompt_dictionary: &HashMap<String, usize>,
) -> Result<(), TranscriptionError> {
    for prompt in SUPPORTED_LANGUAGE_PROMPTS {
        let expected = usize::try_from(prompt.index).map_err(|_| {
            TranscriptionError::invalid_model_with_details(format!(
                "invalid negative prompt index {} for {}",
                prompt.index, prompt.product_tag
            ))
        })?;
        let actual = prompt_dictionary.get(prompt.metadata_key).copied();
        if actual != Some(expected) {
            return Err(TranscriptionError::invalid_model_with_details(format!(
                "encoder prompt metadata for {} must define {}={expected}, found {actual:?}",
                prompt.product_tag, prompt.metadata_key
            )));
        }
    }
    Ok(())
}

#[derive(Default)]
pub struct NemotronAsrAdapter;

impl ModelFamilyAdapter for NemotronAsrAdapter {
    fn runtime_id(&self) -> RuntimeId {
        RuntimeId::OnnxRuntime
    }

    fn family_id(&self) -> ModelFamilyId {
        ModelFamilyId::NemotronAsr
    }

    fn capabilities(&self) -> &ModelFamilyCapabilities {
        &CAPABILITIES
    }

    fn probe_model(&self, path: &Path) -> Result<(), TranscriptionError> {
        ValidatedNemotronGraphs::load(path, GpuConfig { use_gpu: false })?;
        Ok(())
    }

    fn probe_model_and_language_support(
        &self,
        path: &Path,
    ) -> Result<LanguageSupport, TranscriptionError> {
        let graphs = ValidatedNemotronGraphs::load(path, GpuConfig { use_gpu: false })?;
        Ok(match graphs.config.variant {
            NemotronVariant::English => LanguageSupport::EnglishOnly,
            NemotronVariant::Multilingual => LanguageSupport::List {
                tags: supported_language_tags(),
            },
        })
    }

    fn load(
        &self,
        _path: &Path,
        _gpu: GpuConfig,
    ) -> Result<Box<dyn LoadedModel>, TranscriptionError> {
        Err(TranscriptionError::unsupported_engine(
            "Nemotron ASR requires the streaming session path".to_string(),
        ))
    }

    fn load_streaming(
        &self,
        path: &Path,
        gpu: GpuConfig,
    ) -> Result<Box<dyn StreamingModel>, TranscriptionError> {
        Ok(Box::new(LoadedNemotronModel::load(path, gpu)?))
    }
}

struct ValidatedNemotronGraphs {
    config: NemotronConfig,
    decoder: Session,
    encoder: Session,
    joiner: Session,
    tokenizer: NemoTokenizer,
}

impl ValidatedNemotronGraphs {
    fn load(path: &Path, encoder_gpu: GpuConfig) -> Result<Self, TranscriptionError> {
        let paths = resolve_model_paths(path)?;
        let encoder =
            build_session(&paths.encoder, encoder_gpu).map_err(invalid_session("encoder"))?;
        let config = NemotronConfig::from_encoder(&encoder)?;
        let decoder = build_session(&paths.decoder, GpuConfig { use_gpu: false })
            .map_err(invalid_session("decoder"))?;
        let joiner = build_session(&paths.joiner, GpuConfig { use_gpu: false })
            .map_err(invalid_session("joiner"))?;
        verify_graph_topology(&encoder, &decoder, &joiner, &config)?;
        let tokenizer = NemoTokenizer::load(&paths.tokens)?;
        tokenizer.validate(config.vocab_size)?;
        Ok(Self {
            config,
            decoder,
            encoder,
            joiner,
            tokenizer,
        })
    }
}

fn invalid_session(graph: &'static str) -> impl FnOnce(TranscriptionError) -> TranscriptionError {
    move |error| {
        TranscriptionError::invalid_model_with_details(format!(
            "{graph} session failed to load: {}",
            error.details.unwrap_or_else(|| error.message.to_string())
        ))
    }
}

struct ModelPaths {
    encoder: PathBuf,
    decoder: PathBuf,
    joiner: PathBuf,
    tokens: PathBuf,
}

fn resolve_model_paths(path: &Path) -> Result<ModelPaths, TranscriptionError> {
    validate_model_path(path)?;
    if path.file_name() != Some(OsStr::new(ENCODER_FILENAME)) {
        return Err(TranscriptionError::invalid_model_with_details(format!(
            "Nemotron ASR external models must be selected via {ENCODER_FILENAME}; received {}",
            path.display()
        )));
    }

    let directory = path.parent().ok_or_else(|| {
        TranscriptionError::invalid_model_with_details(
            "cannot determine the Nemotron ASR model directory".to_string(),
        )
    })?;
    let paths = ModelPaths {
        encoder: path.to_path_buf(),
        decoder: directory.join(DECODER_FILENAME),
        joiner: directory.join(JOINER_FILENAME),
        tokens: directory.join(TOKENS_FILENAME),
    };

    for required in [&paths.decoder, &paths.joiner, &paths.tokens] {
        validate_model_path(required).map_err(|_| {
            TranscriptionError::invalid_model_with_details(format!(
                "required Nemotron ASR asset missing: {}",
                required.display()
            ))
        })?;
    }
    Ok(paths)
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NemotronConfig {
    variant: NemotronVariant,
    chunk_size_ms: usize,
    vocab_size: usize,
    feature_dim: usize,
    window_size: usize,
    chunk_shift: usize,
    subsampling_factor: usize,
    encoder_dim: usize,
    cache_channel_layers: usize,
    cache_channel_time: usize,
    cache_time_width: usize,
    predictor_layers: usize,
    predictor_hidden: usize,
}

impl NemotronConfig {
    fn from_encoder(encoder: &Session) -> Result<Self, TranscriptionError> {
        let metadata = encoder.metadata().map_err(|error| {
            TranscriptionError::invalid_model_with_details(format!(
                "failed to read Nemotron ASR encoder metadata: {error}"
            ))
        })?;
        let model_type = metadata.custom("model_type").ok_or_else(|| {
            TranscriptionError::invalid_model_with_details(
                "encoder metadata is missing model_type".to_string(),
            )
        })?;
        let variant = match model_type.as_str() {
            MODEL_TYPE => NemotronVariant::Multilingual,
            ENGLISH_MODEL_TYPE => NemotronVariant::English,
            _ => {
                return Err(TranscriptionError::invalid_model_with_details(format!(
                    "unsupported Nemotron model_type={model_type}"
                )));
            }
        };
        let normalization = metadata.custom("normalize_type").unwrap_or_default();
        if !normalization.is_empty() {
            return Err(TranscriptionError::invalid_model_with_details(format!(
                "unsupported Nemotron ASR normalization {normalization:?}; expected no normalization"
            )));
        }

        if variant == NemotronVariant::Multilingual {
            let prompt_dictionary = metadata.custom("prompt_dictionary").ok_or_else(|| {
                TranscriptionError::invalid_model_with_details(
                    "encoder metadata is missing prompt_dictionary".to_string(),
                )
            })?;
            let prompt_dictionary: HashMap<String, usize> =
                serde_json::from_str(&prompt_dictionary).map_err(|error| {
                    TranscriptionError::invalid_model_with_details(format!(
                        "invalid encoder prompt_dictionary: {error}"
                    ))
                })?;
            validate_language_prompts(&prompt_dictionary)?;
            if metadata_usize(&metadata, "auto_prompt_id")? != AUTO_PROMPT_INDEX {
                return Err(TranscriptionError::invalid_model_with_details(
                    "encoder auto_prompt_id must be 101".to_string(),
                ));
            }
        }

        let decoder_vocab_size = metadata_usize(&metadata, "vocab_size")?;
        let config = Self {
            variant,
            chunk_size_ms: metadata_usize(&metadata, "chunk_size_ms")?,
            vocab_size: decoder_vocab_size.checked_add(1).ok_or_else(|| {
                TranscriptionError::invalid_model_with_details(
                    "Nemotron ASR vocabulary size overflow".to_string(),
                )
            })?,
            feature_dim: metadata_usize(&metadata, "feat_dim")?,
            window_size: metadata_usize(&metadata, "window_size")?,
            chunk_shift: metadata_usize(&metadata, "chunk_shift")?,
            subsampling_factor: metadata_usize(&metadata, "subsampling_factor")?,
            encoder_dim: metadata_usize(&metadata, "cache_last_channel_dim3")?,
            cache_channel_layers: metadata_usize(&metadata, "cache_last_channel_dim1")?,
            cache_channel_time: metadata_usize(&metadata, "cache_last_channel_dim2")?,
            cache_time_width: metadata_usize(&metadata, "cache_last_time_dim3")?,
            predictor_layers: metadata_usize(&metadata, "pred_rnn_layers")?,
            predictor_hidden: metadata_usize(&metadata, "pred_hidden")?,
        };
        let cache_time_layers = metadata_usize(&metadata, "cache_last_time_dim1")?;
        let cache_time_dim = metadata_usize(&metadata, "cache_last_time_dim2")?;
        if cache_time_layers != config.cache_channel_layers || cache_time_dim != config.encoder_dim
        {
            return Err(TranscriptionError::invalid_model_with_details(
                "encoder metadata contains an unsupported chunk or cache layout".to_string(),
            ));
        }
        config.validate()?;
        Ok(config)
    }

    fn validate(&self) -> Result<(), TranscriptionError> {
        let (window_size, chunk_shift) = match (self.variant, self.chunk_size_ms) {
            (_, 560) => (EXPECTED_WINDOW_SIZE, 56),
            (NemotronVariant::Multilingual, 160) => (25, 16),
            _ => {
                return Err(TranscriptionError::invalid_model_with_details(format!(
                    "unsupported Nemotron {:?} chunk size {} ms",
                    self.variant, self.chunk_size_ms
                )));
            }
        };
        let (vocab_size, cache_channel_time) = match self.variant {
            NemotronVariant::English => (1_025, 70),
            NemotronVariant::Multilingual => (13_088, 56),
        };
        let actual = (
            self.vocab_size,
            self.feature_dim,
            self.window_size,
            self.chunk_shift,
            self.subsampling_factor,
            self.encoder_dim,
            self.cache_channel_layers,
            self.cache_channel_time,
            self.cache_time_width,
            self.predictor_layers,
            self.predictor_hidden,
        );
        let expected = (
            vocab_size,
            FEATURE_DIM,
            window_size,
            chunk_shift,
            EXPECTED_SUBSAMPLING_FACTOR,
            EXPECTED_ENCODER_DIM,
            EXPECTED_CACHE_CHANNEL_LAYERS,
            cache_channel_time,
            EXPECTED_CACHE_TIME_WIDTH,
            EXPECTED_PREDICTOR_LAYERS,
            EXPECTED_PREDICTOR_HIDDEN,
        );
        if actual != expected {
            return Err(TranscriptionError::invalid_model_with_details(format!(
                "unsupported Nemotron ASR metadata dimensions: {actual:?}"
            )));
        }
        Ok(())
    }
}

fn metadata_usize(
    metadata: &ort::session::ModelMetadata<'_>,
    key: &str,
) -> Result<usize, TranscriptionError> {
    let value = metadata.custom(key).ok_or_else(|| {
        TranscriptionError::invalid_model_with_details(format!("encoder metadata is missing {key}"))
    })?;
    value.parse::<usize>().map_err(|error| {
        TranscriptionError::invalid_model_with_details(format!(
            "invalid encoder metadata {key}={value:?}: {error}"
        ))
    })
}

fn verify_graph_topology(
    encoder: &Session,
    decoder: &Session,
    joiner: &Session,
    config: &NemotronConfig,
) -> Result<(), TranscriptionError> {
    let encoder_inputs = [
        "audio_signal",
        "length",
        "cache_last_channel",
        "cache_last_time",
        "cache_last_channel_len",
        "prompt_index",
    ];
    let encoder_input_count = match config.variant {
        NemotronVariant::English => 5,
        NemotronVariant::Multilingual => 6,
    };
    verify_session_io(
        encoder,
        "encoder",
        &encoder_inputs[..encoder_input_count],
        &[
            "outputs",
            "encoded_lengths",
            "cache_last_channel_next",
            "cache_last_time_next",
            "cache_last_channel_next_len",
        ],
    )?;
    verify_session_io(
        decoder,
        "decoder",
        &["targets", "target_length", "states.1", "onnx::Slice_3"],
        &["outputs", "prednet_lengths", "states", "162"],
    )?;
    verify_session_io(
        joiner,
        "joiner",
        &["encoder_outputs", "decoder_outputs"],
        &["outputs"],
    )?;

    verify_tensor(
        encoder.inputs()[0].dtype(),
        "encoder input 0",
        TensorElementType::Float32,
        3,
    )?;
    verify_tensor(
        encoder.inputs()[1].dtype(),
        "encoder input 1",
        TensorElementType::Int64,
        1,
    )?;
    verify_tensor(
        encoder.inputs()[2].dtype(),
        "encoder cache_last_channel input",
        TensorElementType::Float32,
        4,
    )?;
    verify_tensor(
        encoder.inputs()[3].dtype(),
        "encoder cache_last_time input",
        TensorElementType::Float32,
        4,
    )?;
    verify_tensor(
        encoder.inputs()[4].dtype(),
        "encoder cache_last_channel_len input",
        TensorElementType::Int64,
        1,
    )?;
    if config.variant == NemotronVariant::Multilingual {
        verify_tensor(
            encoder.inputs()[5].dtype(),
            "encoder prompt_index input",
            TensorElementType::Int64,
            1,
        )?;
    }
    verify_tensor(
        encoder.outputs()[0].dtype(),
        "encoder output",
        TensorElementType::Float32,
        3,
    )?;
    verify_tensor(
        encoder.outputs()[1].dtype(),
        "encoder encoded_lengths output",
        TensorElementType::Int64,
        1,
    )?;
    for (index, output) in encoder.outputs()[2..4].iter().enumerate() {
        verify_tensor(
            output.dtype(),
            &format!("encoder cache output {index}"),
            TensorElementType::Float32,
            4,
        )?;
    }
    verify_tensor(
        encoder.outputs()[4].dtype(),
        "encoder cache length output",
        TensorElementType::Int64,
        1,
    )?;
    verify_tensor(
        decoder.inputs()[0].dtype(),
        "decoder input 0",
        TensorElementType::Int32,
        2,
    )?;
    verify_tensor(
        decoder.inputs()[1].dtype(),
        "decoder input 1",
        TensorElementType::Int32,
        1,
    )?;
    for (index, input) in decoder.inputs()[2..].iter().enumerate() {
        verify_tensor(
            input.dtype(),
            &format!("decoder state input {index}"),
            TensorElementType::Float32,
            3,
        )?;
        if let ValueType::Tensor { shape, .. } = input.dtype() {
            validate_model_dimension(shape, 0, config.predictor_layers, "decoder state layers")?;
            validate_model_dimension(shape, 2, config.predictor_hidden, "decoder state hidden")?;
        }
    }
    verify_tensor(
        decoder.outputs()[0].dtype(),
        "decoder output",
        TensorElementType::Float32,
        3,
    )?;
    verify_tensor(
        decoder.outputs()[1].dtype(),
        "decoder length output",
        TensorElementType::Int32,
        1,
    )?;
    for (index, output) in decoder.outputs()[2..].iter().enumerate() {
        verify_tensor(
            output.dtype(),
            &format!("decoder state output {index}"),
            TensorElementType::Float32,
            3,
        )?;
        if let ValueType::Tensor { shape, .. } = output.dtype() {
            validate_model_dimension(shape, 0, config.predictor_layers, "decoder state layers")?;
            validate_model_dimension(shape, 2, config.predictor_hidden, "decoder state hidden")?;
        }
    }
    verify_tensor(
        joiner.inputs()[0].dtype(),
        "joiner input 0",
        TensorElementType::Float32,
        3,
    )?;
    verify_tensor(
        joiner.inputs()[1].dtype(),
        "joiner input 1",
        TensorElementType::Float32,
        3,
    )?;
    verify_tensor(
        joiner.outputs()[0].dtype(),
        "joiner output",
        TensorElementType::Float32,
        4,
    )?;

    if let ValueType::Tensor { shape, .. } = encoder.inputs()[0].dtype() {
        validate_model_dimension(shape, 1, config.feature_dim, "encoder feature dimension")?;
    }
    if let ValueType::Tensor { shape, .. } = encoder.outputs()[0].dtype() {
        validate_model_dimension(shape, 1, config.encoder_dim, "encoder output dimension")?;
    }
    for (value_type, dimensions, label) in [
        (
            encoder.inputs()[2].dtype(),
            [
                config.cache_channel_layers,
                config.cache_channel_time,
                config.encoder_dim,
            ],
            "encoder channel cache",
        ),
        (
            encoder.inputs()[3].dtype(),
            [
                config.cache_channel_layers,
                config.encoder_dim,
                config.cache_time_width,
            ],
            "encoder time cache",
        ),
        (
            encoder.outputs()[2].dtype(),
            [
                config.cache_channel_layers,
                config.cache_channel_time,
                config.encoder_dim,
            ],
            "encoder next channel cache",
        ),
        (
            encoder.outputs()[3].dtype(),
            [
                config.cache_channel_layers,
                config.encoder_dim,
                config.cache_time_width,
            ],
            "encoder next time cache",
        ),
    ] {
        if let ValueType::Tensor { shape, .. } = value_type {
            for (offset, expected) in dimensions.into_iter().enumerate() {
                validate_model_dimension(shape, offset + 1, expected, label)?;
            }
        }
    }
    if let ValueType::Tensor { shape, .. } = joiner.inputs()[0].dtype() {
        validate_model_dimension(shape, 1, config.encoder_dim, "joiner encoder dimension")?;
    }
    if let ValueType::Tensor { shape, .. } = joiner.inputs()[1].dtype() {
        validate_model_dimension(
            shape,
            1,
            config.predictor_hidden,
            "joiner decoder dimension",
        )?;
    }
    if let ValueType::Tensor { shape, .. } = decoder.outputs()[0].dtype() {
        validate_model_dimension(
            shape,
            1,
            config.predictor_hidden,
            "decoder output dimension",
        )?;
    }
    if let ValueType::Tensor { shape, .. } = joiner.outputs()[0].dtype() {
        validate_model_dimension(shape, 3, config.vocab_size, "joiner vocabulary dimension")?;
    }
    Ok(())
}

fn verify_session_io(
    session: &Session,
    graph: &str,
    expected_inputs: &[&str],
    expected_outputs: &[&str],
) -> Result<(), TranscriptionError> {
    let actual_inputs: Vec<&str> = session.inputs().iter().map(|input| input.name()).collect();
    let actual_outputs: Vec<&str> = session
        .outputs()
        .iter()
        .map(|output| output.name())
        .collect();
    if actual_inputs != expected_inputs || actual_outputs != expected_outputs {
        return Err(TranscriptionError::invalid_model_with_details(format!(
            "{graph} graph I/O mismatch: inputs {actual_inputs:?}, outputs {actual_outputs:?}"
        )));
    }
    Ok(())
}

fn verify_tensor(
    value_type: &ValueType,
    name: &str,
    expected_element: TensorElementType,
    expected_rank: usize,
) -> Result<(), TranscriptionError> {
    let ValueType::Tensor { ty, shape, .. } = value_type else {
        return Err(TranscriptionError::invalid_model_with_details(format!(
            "{name} is not a tensor"
        )));
    };
    if *ty != expected_element || shape.len() != expected_rank {
        return Err(TranscriptionError::invalid_model_with_details(format!(
            "{name} mismatch: expected {expected_element:?} rank {expected_rank}, found {ty:?} {shape:?}"
        )));
    }
    Ok(())
}

/// Validate a model-declared tensor dimension without rejecting symbolic axes.
///
/// ONNX Runtime exposes symbolic dimensions as negative values. The concrete
/// dimensions are still enforced on every tensor we create and every graph
/// output we consume; metadata validation can only reject a conflicting
/// positive declaration.
fn validate_model_dimension(
    shape: &[i64],
    index: usize,
    expected: usize,
    name: &str,
) -> Result<(), TranscriptionError> {
    let actual = shape.get(index).copied().ok_or_else(|| {
        TranscriptionError::invalid_model_with_details(format!(
            "{name} mismatch: expected dimension {index} to be {expected}, found shape {shape:?}"
        ))
    })?;
    if actual >= 0 && actual != expected as i64 {
        return Err(TranscriptionError::invalid_model_with_details(format!(
            "{name} mismatch: expected {expected}, found {actual}"
        )));
    }
    Ok(())
}

struct PredictorState {
    hidden: Vec<f32>,
    cell: Vec<f32>,
}

impl PredictorState {
    fn zeros(config: &NemotronConfig) -> Self {
        let length = config.predictor_layers * config.predictor_hidden;
        Self {
            hidden: vec![0.0; length],
            cell: vec![0.0; length],
        }
    }
}

struct DecoderStep {
    output: Vec<f32>,
    next_state: PredictorState,
}

struct EncoderState {
    channel: Vec<f32>,
    time: Vec<f32>,
    channel_len: i64,
}

impl EncoderState {
    fn zeros(config: &NemotronConfig) -> Self {
        Self {
            channel: vec![
                0.0;
                config.cache_channel_layers
                    * config.cache_channel_time
                    * config.encoder_dim
            ],
            time: vec![
                0.0;
                config.cache_channel_layers * config.encoder_dim * config.cache_time_width
            ],
            channel_len: 0,
        }
    }
}

struct LoadedNemotronModel {
    config: NemotronConfig,
    decoder: Session,
    encoder: Session,
    encoder_input: Vec<f32>,
    encoder_state: EncoderState,
    features: OnlineNemoFeatures,
    joiner: Session,
    last_token: Option<i32>,
    predictor_state_before_last: PredictorState,
    prompt_index: i64,
    processed_feature_frames: usize,
    sample_count: usize,
    tokenizer: NemoTokenizer,
    tokens: Vec<i32>,
}

impl LoadedNemotronModel {
    fn load(path: &Path, gpu: GpuConfig) -> Result<Self, TranscriptionError> {
        let ValidatedNemotronGraphs {
            config,
            decoder,
            encoder,
            joiner,
            tokenizer,
        } = ValidatedNemotronGraphs::load(path, gpu)?;
        let predictor_state_before_last = PredictorState::zeros(&config);
        let encoder_state = EncoderState::zeros(&config);
        let encoder_input = vec![0.0; config.feature_dim * config.window_size];
        Ok(Self {
            config,
            decoder,
            encoder,
            encoder_input,
            encoder_state,
            features: OnlineNemoFeatures::new(),
            joiner,
            last_token: None,
            predictor_state_before_last,
            prompt_index: EN_US_PROMPT_INDEX,
            processed_feature_frames: 0,
            sample_count: 0,
            tokenizer,
            tokens: Vec::new(),
        })
    }

    fn blank_id(&self) -> i32 {
        (self.config.vocab_size - 1) as i32
    }

    fn process_ready_chunks(&mut self, finalizing: bool) -> Result<(), TranscriptionError> {
        if finalizing {
            self.features.finish();
        }
        loop {
            let ready = self.features.len();
            let remaining = ready.saturating_sub(self.processed_feature_frames);
            let can_decode = if finalizing {
                remaining > 0
            } else {
                remaining >= self.config.window_size
            };
            if !can_decode {
                break;
            }

            let window = self
                .features
                .window(self.processed_feature_frames, self.config.window_size);
            let valid_frames = remaining.min(self.config.window_size);
            let encoder_frames = self.run_encoder_chunk(&window, valid_frames)?;
            self.decode_encoder_frames(&encoder_frames)?;
            self.processed_feature_frames += self.config.chunk_shift.min(remaining);
        }
        Ok(())
    }

    /// Run one encoder window. `valid_frames` is the number of real feature
    /// frames in the window; the finalize tail is shorter than the window and
    /// must be masked by the graph's `length` input so zero-padded frames are
    /// never decoded as audio.
    fn run_encoder_chunk(
        &mut self,
        window: &[f32],
        valid_frames: usize,
    ) -> Result<Vec<Vec<f32>>, TranscriptionError> {
        let time = self.config.window_size;
        self.encoder_input.fill(0.0);
        for frame in 0..time {
            for feature in 0..self.config.feature_dim {
                self.encoder_input[feature * time + frame] =
                    window[frame * self.config.feature_dim + feature];
            }
        }
        let features = tensor_ref(
            [1, self.config.feature_dim, time],
            &self.encoder_input,
            "Nemotron encoder features",
        )?;
        let length_data = [valid_frames as i64];
        let length = tensor_ref([1], &length_data, "Nemotron encoder length")?;
        let channel_cache = tensor_ref(
            [
                1,
                self.config.cache_channel_layers,
                self.config.cache_channel_time,
                self.config.encoder_dim,
            ],
            &self.encoder_state.channel,
            "Nemotron encoder channel cache",
        )?;
        let time_cache = tensor_ref(
            [
                1,
                self.config.cache_channel_layers,
                self.config.encoder_dim,
                self.config.cache_time_width,
            ],
            &self.encoder_state.time,
            "Nemotron encoder time cache",
        )?;
        let channel_cache_len_data = [self.encoder_state.channel_len];
        let channel_cache_len = tensor_ref(
            [1],
            &channel_cache_len_data,
            "Nemotron encoder channel cache length",
        )?;
        let prompt_index_data = [self.prompt_index];
        let prompt_index = tensor_ref([1], &prompt_index_data, "Nemotron encoder prompt index")?;
        let outputs = match self.config.variant {
            NemotronVariant::English => self.encoder.run(ort::inputs![
                features,
                length,
                channel_cache,
                time_cache,
                channel_cache_len
            ]),
            NemotronVariant::Multilingual => self.encoder.run(ort::inputs![
                features,
                length,
                channel_cache,
                time_cache,
                channel_cache_len,
                prompt_index
            ]),
        }
        .map_err(|error| TranscriptionError::transcription_failure("Nemotron encoder", &error))?;
        let (shape, encoded) = tensor_f32(output_at(&outputs, 0, "encoder output")?, "encoder")?;
        if shape.len() != 3
            || shape[0] != 1
            || shape[1] != self.config.encoder_dim as i64
            || shape[2] <= 0
        {
            return Err(graph_shape_error("encoder output", shape));
        }
        let encoder_time = dimension(shape, 2, "encoder output")?;
        let encoded_lengths = tensor_i64_exact(
            output_at(&outputs, 1, "encoder encoded lengths")?,
            &[1],
            "encoder encoded lengths",
        )?;
        let valid_encoder_frames = usize::try_from(encoded_lengths[0])
            .map_err(|_| graph_shape_error("encoder encoded lengths", &[encoded_lengths[0]]))?;
        // The graph is the authority on how many output frames a chunk yields:
        // finalize tails inside the encoder lookahead (8-9 feature frames)
        // legitimately encode to zero frames. Only an impossible overrun is a
        // graph-contract violation.
        let max_encoder_frames =
            encoder_time.min(valid_frames.div_ceil(self.config.subsampling_factor));
        if valid_encoder_frames > max_encoder_frames {
            return Err(graph_shape_error(
                "encoder encoded lengths",
                &[encoded_lengths[0]],
            ));
        }

        let next_channel = tensor_f32_exact(
            output_at(&outputs, 2, "encoder next channel cache")?,
            &[
                1,
                self.config.cache_channel_layers,
                self.config.cache_channel_time,
                self.config.encoder_dim,
            ],
            "encoder next channel cache",
        )?;
        let next_time = tensor_f32_exact(
            output_at(&outputs, 3, "encoder next time cache")?,
            &[
                1,
                self.config.cache_channel_layers,
                self.config.encoder_dim,
                self.config.cache_time_width,
            ],
            "encoder next time cache",
        )?;
        let next_channel_len = tensor_i64_exact(
            output_at(&outputs, 4, "encoder next channel cache length")?,
            &[1],
            "encoder next channel cache length",
        )?[0];
        if !(0..=self.config.cache_channel_time as i64).contains(&next_channel_len) {
            return Err(graph_shape_error(
                "encoder next channel cache length",
                &[next_channel_len],
            ));
        }

        let mut frames = Vec::with_capacity(valid_encoder_frames);
        for time_index in 0..valid_encoder_frames {
            let mut frame = Vec::with_capacity(self.config.encoder_dim);
            for column in 0..self.config.encoder_dim {
                frame.push(encoded[column * encoder_time + time_index]);
            }
            frames.push(frame);
        }
        self.encoder_state = EncoderState {
            channel: next_channel.to_vec(),
            time: next_time.to_vec(),
            channel_len: next_channel_len,
        };
        Ok(frames)
    }

    fn decode_encoder_frames(
        &mut self,
        encoder_frames: &[Vec<f32>],
    ) -> Result<(), TranscriptionError> {
        let decoder_input = self.last_token.unwrap_or_else(|| self.blank_id());
        let mut decoder_step = run_decoder(
            &mut self.decoder,
            &self.config,
            decoder_input,
            &self.predictor_state_before_last,
        )?;
        let blank_id = self.blank_id();

        for encoder_frame in encoder_frames {
            for _ in 0..MAX_SYMBOLS_PER_FRAME {
                let next_token = run_joiner(
                    &mut self.joiner,
                    self.config.vocab_size,
                    encoder_frame,
                    &decoder_step.output,
                )?;
                if next_token == blank_id {
                    break;
                }
                if next_token < 0 || next_token as usize >= self.config.vocab_size - 1 {
                    return Err(TranscriptionError::transcription_failure(
                        "Nemotron joiner",
                        format!("emitted invalid token id {next_token}"),
                    ));
                }

                self.tokens.push(next_token);
                self.last_token = Some(next_token);
                self.predictor_state_before_last = decoder_step.next_state;
                decoder_step = run_decoder(
                    &mut self.decoder,
                    &self.config,
                    next_token,
                    &self.predictor_state_before_last,
                )?;
            }
        }
        Ok(())
    }

    fn output(&self) -> Result<EngineTranscriptOutput, TranscriptionError> {
        let text = self.tokenizer.decode(&self.tokens)?;
        let segments = if text.is_empty() {
            Vec::new()
        } else {
            vec![TranscriptSegment {
                end_ms: (self.sample_count as u64 * 1_000) / SAMPLE_RATE as u64,
                speaker: None,
                start_ms: 0,
                text,
                timestamp_granularity: TimestampGranularity::Utterance,
                timestamp_source: TimestampSource::Vad,
                words: Vec::new(),
            }]
        };
        Ok(EngineTranscriptOutput {
            detected_language: None,
            segments,
            diagnostics: Vec::new(),
        })
    }
}

fn run_decoder(
    decoder: &mut Session,
    config: &NemotronConfig,
    token: i32,
    state: &PredictorState,
) -> Result<DecoderStep, TranscriptionError> {
    let targets_data = [token];
    let targets = tensor_ref([1, 1], &targets_data, "Nemotron decoder target")?;
    let target_length_data = [1_i32];
    let target_length = tensor_ref([1], &target_length_data, "Nemotron decoder target length")?;
    let state_shape = [config.predictor_layers, 1, config.predictor_hidden];
    let hidden = tensor_ref(state_shape, &state.hidden, "Nemotron decoder hidden state")?;
    let cell = tensor_ref(state_shape, &state.cell, "Nemotron decoder cell state")?;
    let outputs = decoder
        .run(ort::inputs![targets, target_length, hidden, cell])
        .map_err(|error| TranscriptionError::transcription_failure("Nemotron decoder", &error))?;
    let output = tensor_f32_exact(
        output_at(&outputs, 0, "decoder output")?,
        &[1, config.predictor_hidden, 1],
        "decoder output",
    )?
    .to_vec();
    let hidden = tensor_f32_exact(
        output_at(&outputs, 2, "decoder hidden state")?,
        &[config.predictor_layers, 1, config.predictor_hidden],
        "decoder hidden state",
    )?
    .to_vec();
    let cell = tensor_f32_exact(
        output_at(&outputs, 3, "decoder cell state")?,
        &[config.predictor_layers, 1, config.predictor_hidden],
        "decoder cell state",
    )?
    .to_vec();
    Ok(DecoderStep {
        output,
        next_state: PredictorState { hidden, cell },
    })
}

fn run_joiner(
    joiner: &mut Session,
    vocab_size: usize,
    encoder_frame: &[f32],
    decoder_output: &[f32],
) -> Result<i32, TranscriptionError> {
    let encoder = tensor_ref(
        [1, encoder_frame.len(), 1],
        encoder_frame,
        "Nemotron joiner encoder input",
    )?;
    let decoder = tensor_ref(
        [1, decoder_output.len(), 1],
        decoder_output,
        "Nemotron joiner decoder input",
    )?;
    let outputs = joiner
        .run(ort::inputs![encoder, decoder])
        .map_err(|error| TranscriptionError::transcription_failure("Nemotron joiner", &error))?;
    let logits = tensor_f32_exact(
        output_at(&outputs, 0, "joiner output")?,
        &[1, 1, 1, vocab_size],
        "joiner output",
    )?;
    logits
        .iter()
        .enumerate()
        .max_by(|(_, left), (_, right)| left.total_cmp(right))
        .map(|(index, _)| index as i32)
        .ok_or_else(|| {
            TranscriptionError::transcription_failure("Nemotron joiner", "logits were empty")
        })
}

impl StreamingModel for LoadedNemotronModel {
    fn partial_cadence(&self) -> StreamingPartialCadence {
        StreamingPartialCadence {
            min_audio_samples: 1_600,
            min_wall_time: Duration::from_millis(100),
        }
    }

    fn accept_audio(&mut self, samples: &[i16]) -> Result<(), TranscriptionError> {
        self.sample_count = self.sample_count.saturating_add(samples.len());
        self.features.accept(samples);
        Ok(())
    }

    fn set_language(&mut self, language: &str) -> Result<(), TranscriptionError> {
        if self.sample_count != 0 || !self.tokens.is_empty() {
            return Err(TranscriptionError::transcription_failure(
                "Nemotron language selection",
                "cannot change language during an open utterance",
            ));
        }
        if self.config.variant == NemotronVariant::English {
            return if language == "en" {
                Ok(())
            } else {
                Err(TranscriptionError::unsupported_language(
                    language,
                    "This Nemotron model supports English only.",
                ))
            };
        }
        self.prompt_index = prompt_index_for_language(language).ok_or_else(|| {
            TranscriptionError::unsupported_language(
                language,
                "Nemotron supports only the languages advertised by this build.",
            )
        })?;
        Ok(())
    }

    fn partial(&mut self) -> Result<EngineTranscriptOutput, TranscriptionError> {
        let result = self
            .process_ready_chunks(false)
            .and_then(|()| self.output());
        if result.is_err() {
            self.reset_utterance();
        }
        result
    }

    fn finalize_utterance(&mut self) -> Result<EngineTranscriptOutput, TranscriptionError> {
        let result = self.process_ready_chunks(true).and_then(|()| self.output());
        self.reset_utterance();
        result
    }

    fn reset_utterance(&mut self) {
        self.features.reset();
        self.encoder_state = EncoderState::zeros(&self.config);
        self.last_token = None;
        self.predictor_state_before_last = PredictorState::zeros(&self.config);
        self.processed_feature_frames = 0;
        self.sample_count = 0;
        self.tokens.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_dimensions_accept_symbolic_axes_but_reject_static_mismatches() {
        validate_model_dimension(&[1, -1, 1024], 1, 56, "encoder channel cache").unwrap();
        validate_model_dimension(&[1, 56, 1024], 1, 56, "encoder channel cache").unwrap();

        let error =
            validate_model_dimension(&[1, 55, 1024], 1, 56, "encoder channel cache").unwrap_err();
        assert_eq!(error.code, "invalid_model_file");
        assert!(
            error
                .details
                .as_deref()
                .is_some_and(|details| details.contains("expected 56, found 55")),
            "unexpected error details: {:?}",
            error.details
        );
    }
}
#[test]
fn supported_languages_map_to_the_pinned_prompt_indices() {
    assert_eq!(prompt_index_for_language("en"), Some(0));
    assert_eq!(prompt_index_for_language("es"), Some(3));
    assert_eq!(prompt_index_for_language("de"), Some(9));
    assert_eq!(prompt_index_for_language("fr"), Some(8));
    assert_eq!(prompt_index_for_language("pt"), Some(13));
    assert_eq!(prompt_index_for_language("it"), Some(15));
    assert_eq!(prompt_index_for_language("nl"), Some(16));
    assert_eq!(prompt_index_for_language("ja"), Some(10));
    assert_eq!(prompt_index_for_language("hr"), Some(29));
    assert_eq!(prompt_index_for_language("auto"), Some(101));
    assert_eq!(prompt_index_for_language("xx"), None);
}

/// Serbian is absent from the pinned `prompt_dictionary` entirely, so there is
/// no index to map it to and no neighbouring Slavic language it may fall back
/// to. Croatian shipping alongside it makes that an easy mistake to make later.
#[test]
fn languages_without_a_pinned_prompt_are_rejected() {
    for tag in ["sr", "sr-RS", "bs", "sl", "sk", "bg"] {
        assert_eq!(
            prompt_index_for_language(tag),
            None,
            "unexpected prompt for {tag}"
        );
    }
}

/// Advertised support is derived from the prompt table rather than restated, so
/// the adapter cannot claim a language it has no prompt index for.
#[test]
fn advertised_languages_match_the_prompt_table() {
    let tags = supported_language_tags();
    assert!(tags.contains(&"hr".to_string()));
    assert!(!tags.contains(&AUTOMATIC_LANGUAGE_TAG.to_string()));
    for tag in &tags {
        assert!(
            prompt_index_for_language(tag).is_some(),
            "advertised {tag} has no pinned prompt index"
        );
    }
}

#[test]
fn supported_prompt_metadata_uses_pinned_locale_aliases() {
    let dictionary = SUPPORTED_LANGUAGE_PROMPTS
        .iter()
        .map(|prompt| (prompt.metadata_key.to_string(), prompt.index as usize))
        .collect();
    validate_language_prompts(&dictionary).unwrap();

    let mut wrong_japanese_alias = dictionary;
    wrong_japanese_alias.remove("ja-JP");
    wrong_japanese_alias.insert("ja".to_string(), 10);
    let error = validate_language_prompts(&wrong_japanese_alias).unwrap_err();
    assert_eq!(error.code, "invalid_model_file");
    assert!(
        error
            .details
            .as_deref()
            .is_some_and(|details| details.contains("ja-JP=10")),
        "unexpected error details: {:?}",
        error.details
    );
}
