//! Parakeet Unified English buffered streaming over ONNX Runtime.

use crate::adapters::nemo_rnnt::{
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
    EngineTranscriptOutput, GpuConfig, TranscriptionError, validate_model_path,
};
use ort::session::Session;
use std::path::Path;
use std::sync::LazyLock;
use std::time::Duration;

const SAMPLE_RATE: usize = 16_000;
const FEATURE_DIM: usize = 128;
const LEFT: usize = 560 * 160;
const CHUNK: usize = 56 * 160;
const RIGHT: usize = 56 * 160;
const VOCAB: usize = 1025;
const HIDDEN: usize = 640;
const ENCODER_DIM: usize = 1024;
const LAYERS: usize = 2;

static CAPABILITIES: LazyLock<ModelFamilyCapabilities> =
    LazyLock::new(|| ModelFamilyCapabilities {
        task: ModelTask::Stt,
        supports_hardware_acceleration: false,
        available_voices: Vec::new(),
        supports_speed_control: false,
        output_sample_rate: None,
        supports_segment_timestamps: false,
        supports_word_timestamps: false,
        supports_initial_prompt: false,
        supports_streaming: true,
        supports_language_selection: false,
        supports_automatic_language_detection: false,
        supported_languages: LanguageSupport::EnglishOnly,
        max_audio_duration_secs: None,
        produces_punctuation: true,
    });

#[derive(Default)]
pub struct ParakeetUnifiedAdapter;
impl ModelFamilyAdapter for ParakeetUnifiedAdapter {
    fn runtime_id(&self) -> RuntimeId {
        RuntimeId::OnnxRuntime
    }
    fn family_id(&self) -> ModelFamilyId {
        ModelFamilyId::ParakeetUnified
    }
    fn capabilities(&self) -> &ModelFamilyCapabilities {
        &CAPABILITIES
    }
    fn probe_model(&self, path: &Path) -> Result<(), TranscriptionError> {
        Model::load(path).map(|_| ())
    }
    fn load(
        &self,
        _path: &Path,
        _gpu: GpuConfig,
    ) -> Result<Box<dyn LoadedModel>, TranscriptionError> {
        Err(TranscriptionError::unsupported_engine(
            "Parakeet Unified requires the streaming session path".to_owned(),
        ))
    }
    fn load_streaming(
        &self,
        path: &Path,
        _gpu: GpuConfig,
    ) -> Result<Box<dyn StreamingModel>, TranscriptionError> {
        Ok(Box::new(Model::load(path)?))
    }
}

fn verify_session_io(
    session: &Session,
    graph: &str,
    expected_inputs: &[&str],
    expected_outputs: &[&str],
) -> Result<(), TranscriptionError> {
    let inputs: Vec<&str> = session.inputs().iter().map(|input| input.name()).collect();
    let outputs: Vec<&str> = session
        .outputs()
        .iter()
        .map(|output| output.name())
        .collect();
    if inputs != expected_inputs || outputs != expected_outputs {
        return Err(TranscriptionError::invalid_model_with_details(format!(
            "{graph} graph I/O mismatch: {inputs:?}, {outputs:?}"
        )));
    }
    Ok(())
}

struct Model {
    encoder: Session,
    decoder: Session,
    joiner: Session,
    tokenizer: NemoTokenizer,
    frontend: OnlineNemoFeatures,
    audio: Vec<i16>,
    center: usize,
    sample_count: usize,
    tokens: Vec<i32>,
    state: PredictorState,
    last_token: Option<i32>,
}

impl Model {
    fn load(path: &Path) -> Result<Self, TranscriptionError> {
        validate_model_path(path)?;
        if path.file_name().and_then(|s| s.to_str()) != Some("encoder.int8.onnx") {
            return Err(TranscriptionError::invalid_model_with_details(
                "select encoder.int8.onnx for Parakeet Unified".into(),
            ));
        }
        let dir = path.parent().ok_or_else(|| {
            TranscriptionError::invalid_model_with_details("model directory is missing".into())
        })?;
        let cpu = GpuConfig { use_gpu: false };
        let encoder = build_session(path, cpu)?;
        let metadata = encoder
            .metadata()
            .map_err(|e| TranscriptionError::invalid_model_with_details(e.to_string()))?;
        for (key, expected) in [
            ("streaming_model_type", "nemo_parakeet_unified_streaming"),
            ("model_type", "EncDecRNNTBPEModel"),
            ("normalize_type", "per_feature"),
            ("vocab_size", "1024"),
            ("feat_dim", "128"),
            ("subsampling_factor", "8"),
            ("left_feature_frames", "560"),
            ("chunk_feature_frames", "56"),
            ("right_feature_frames", "56"),
            ("left_encoder_frames", "70"),
            ("chunk_encoder_frames", "7"),
            ("right_encoder_frames", "7"),
            ("pred_hidden", "640"),
            ("pred_rnn_layers", "2"),
        ] {
            if metadata.custom(key).as_deref() != Some(expected) {
                return Err(TranscriptionError::invalid_model_with_details(format!(
                    "unsupported Parakeet encoder metadata {key}; expected {expected}"
                )));
            }
        }
        drop(metadata);
        verify_session_io(
            &encoder,
            "encoder",
            &["audio_signal", "length"],
            &["outputs", "encoded_lengths"],
        )?;
        let decoder = build_session(&dir.join("decoder.int8.onnx"), cpu)?;
        let joiner = build_session(&dir.join("joiner.int8.onnx"), cpu)?;
        verify_session_io(
            &decoder,
            "decoder",
            &["targets", "target_length", "states.1", "onnx::Slice_3"],
            &["outputs", "prednet_lengths", "states", "162"],
        )?;
        verify_session_io(
            &joiner,
            "joiner",
            &["encoder_outputs", "decoder_outputs"],
            &["outputs"],
        )?;
        let tokenizer = NemoTokenizer::load(&dir.join("tokens.txt"))?;
        tokenizer.validate(VOCAB)?;
        Ok(Self {
            encoder,
            decoder,
            joiner,
            tokenizer,
            frontend: OnlineNemoFeatures::new(),
            audio: Vec::new(),
            center: 0,
            sample_count: 0,
            tokens: Vec::new(),
            state: PredictorState::zeros(),
            last_token: None,
        })
    }

    fn process(&mut self, finalizing: bool) -> Result<(), TranscriptionError> {
        loop {
            let remaining = self.audio.len().saturating_sub(self.center);
            if remaining == 0 || (!finalizing && remaining < CHUNK + RIGHT) {
                break;
            }
            let last = finalizing && remaining <= CHUNK + RIGHT;
            let start = self.center.saturating_sub(LEFT);
            let end = if last {
                self.audio.len()
            } else {
                self.center + CHUNK + RIGHT
            };
            let left = self.center - start;
            self.frontend.reset();
            self.frontend.accept(&self.audio[start..end]);
            self.frontend.finish();
            let n = self.frontend.len();
            if n == 0 {
                self.center = end;
                break;
            }
            let features = self.frontend.window(0, n);
            let time = n + 1;
            let mut normalized = vec![0.0_f32; FEATURE_DIM * time];
            for feature in 0..FEATURE_DIM {
                let mean = (0..n)
                    .map(|i| features[i * FEATURE_DIM + feature])
                    .sum::<f32>()
                    / n as f32;
                let variance = if n > 1 {
                    (0..n)
                        .map(|i| {
                            let d = features[i * FEATURE_DIM + feature] - mean;
                            d * d
                        })
                        .sum::<f32>()
                        / (n - 1) as f32
                } else {
                    0.0
                };
                let scale = variance.sqrt() + 1e-5;
                for i in 0..n {
                    normalized[feature * time + i] =
                        (features[i * FEATURE_DIM + feature] - mean) / scale;
                }
            }
            let length = [n as i64];
            let outputs = self
                .encoder
                .run(ort::inputs![
                    tensor_ref([1, FEATURE_DIM, time], &normalized, "Parakeet features")?,
                    tensor_ref([1], &length, "Parakeet length")?
                ])
                .map_err(|e| TranscriptionError::transcription_failure("Parakeet encoder", &e))?;
            let (shape, encoded) = tensor_f32(output_at(&outputs, 0, "encoder")?, "encoder")?;
            if shape.len() != 3 || shape[0] != 1 || shape[1] != ENCODER_DIM as i64 {
                return Err(graph_shape_error("encoder", shape));
            }
            let width = dimension(shape, 2, "encoder")?;
            let actual =
                tensor_i64_exact(output_at(&outputs, 1, "length")?, &[1], "encoder length")?[0];
            let actual = usize::try_from(actual)
                .map_err(|_| graph_shape_error("encoder length", &[actual]))?;
            if actual > width {
                return Err(graph_shape_error("encoder length", &[actual as i64]));
            }
            let from = left / (160 * 8);
            let until = if last {
                actual
            } else {
                (from + CHUNK / (160 * 8)).min(actual)
            };
            let frames: Vec<Vec<f32>> = (from..until)
                .map(|t| (0..ENCODER_DIM).map(|d| encoded[d * width + t]).collect())
                .collect();
            drop(outputs);
            self.decode(&frames)?;
            self.center += if last { remaining } else { CHUNK };
            let discard = self.center.saturating_sub(LEFT);
            if discard > 0 {
                self.audio.drain(..discard);
                self.center -= discard;
            }
        }
        Ok(())
    }

    fn decode(&mut self, frames: &[Vec<f32>]) -> Result<(), TranscriptionError> {
        let mut step = run_decoder(
            &mut self.decoder,
            self.last_token.unwrap_or((VOCAB - 1) as i32),
            &self.state,
        )?;
        for frame in frames {
            for _ in 0..10 {
                let token = run_joiner(&mut self.joiner, frame, &step.output)?;
                if token == (VOCAB - 1) as i32 {
                    break;
                }
                self.tokens.push(token);
                self.last_token = Some(token);
                self.state = step.next_state;
                step = run_decoder(&mut self.decoder, token, &self.state)?;
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
                end_ms: (self.sample_count as u64 * 1000) / SAMPLE_RATE as u64,
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

#[derive(Clone)]
struct PredictorState {
    hidden: Vec<f32>,
    cell: Vec<f32>,
}
impl PredictorState {
    fn zeros() -> Self {
        Self {
            hidden: vec![0.0; LAYERS * HIDDEN],
            cell: vec![0.0; LAYERS * HIDDEN],
        }
    }
}
struct DecoderStep {
    output: Vec<f32>,
    next_state: PredictorState,
}
fn run_decoder(
    decoder: &mut Session,
    token: i32,
    state: &PredictorState,
) -> Result<DecoderStep, TranscriptionError> {
    let target = [token];
    let length = [1_i32];
    let outputs = decoder
        .run(ort::inputs![
            tensor_ref([1, 1], &target, "decoder token")?,
            tensor_ref([1], &length, "decoder length")?,
            tensor_ref([LAYERS, 1, HIDDEN], &state.hidden, "decoder hidden")?,
            tensor_ref([LAYERS, 1, HIDDEN], &state.cell, "decoder cell")?
        ])
        .map_err(|e| TranscriptionError::transcription_failure("Parakeet decoder", &e))?;
    Ok(DecoderStep {
        output: tensor_f32_exact(
            output_at(&outputs, 0, "decoder output")?,
            &[1, HIDDEN, 1],
            "decoder output",
        )?
        .to_vec(),
        next_state: PredictorState {
            hidden: tensor_f32_exact(
                output_at(&outputs, 2, "hidden")?,
                &[LAYERS, 1, HIDDEN],
                "hidden",
            )?
            .to_vec(),
            cell: tensor_f32_exact(
                output_at(&outputs, 3, "cell")?,
                &[LAYERS, 1, HIDDEN],
                "cell",
            )?
            .to_vec(),
        },
    })
}
fn run_joiner(
    joiner: &mut Session,
    encoder: &[f32],
    decoder: &[f32],
) -> Result<i32, TranscriptionError> {
    let outputs = joiner
        .run(ort::inputs![
            tensor_ref([1, ENCODER_DIM, 1], encoder, "joiner encoder")?,
            tensor_ref([1, HIDDEN, 1], decoder, "joiner decoder")?
        ])
        .map_err(|e| TranscriptionError::transcription_failure("Parakeet joiner", &e))?;
    let logits = tensor_f32_exact(
        output_at(&outputs, 0, "joiner output")?,
        &[1, 1, 1, VOCAB],
        "joiner output",
    )?;
    logits
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.total_cmp(b.1))
        .map(|(i, _)| i as i32)
        .ok_or_else(|| TranscriptionError::transcription_failure("Parakeet joiner", "empty logits"))
}
impl StreamingModel for Model {
    fn partial_cadence(&self) -> StreamingPartialCadence {
        StreamingPartialCadence {
            min_audio_samples: 1600,
            min_wall_time: Duration::from_millis(100),
        }
    }
    fn accept_audio(&mut self, samples: &[i16]) -> Result<(), TranscriptionError> {
        self.audio.extend_from_slice(samples);
        self.sample_count = self.sample_count.saturating_add(samples.len());
        Ok(())
    }
    fn partial(&mut self) -> Result<EngineTranscriptOutput, TranscriptionError> {
        let result = self.process(false).and_then(|()| self.output());
        if result.is_err() {
            self.reset_utterance();
        }
        result
    }
    fn finalize_utterance(&mut self) -> Result<EngineTranscriptOutput, TranscriptionError> {
        let result = self.process(true).and_then(|()| self.output());
        self.reset_utterance();
        result
    }
    fn reset_utterance(&mut self) {
        self.audio.clear();
        self.center = 0;
        self.sample_count = 0;
        self.tokens.clear();
        self.state = PredictorState::zeros();
        self.last_token = None;
        self.frontend.reset();
    }
}
