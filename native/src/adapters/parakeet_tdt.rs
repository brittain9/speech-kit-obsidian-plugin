//! Bounded multilingual Parakeet TDT batch inference using the pinned NeMo ONNX export.

use std::path::Path;
use std::sync::LazyLock;

use ort::session::Session;
use ort::value::{TensorElementType, ValueType};

use crate::adapters::nemo_rnnt::{
    NemoTokenizer, dimension, graph_shape_error, tensor_f32, tensor_f32_exact, tensor_i64_exact,
    tensor_ref,
};
use crate::engine::capabilities::{
    LanguageSupport, ModelFamilyCapabilities, ModelFamilyId, ModelTask, RuntimeId,
};
use crate::engine::traits::{LoadedModel, ModelFamilyAdapter};
use crate::protocol::{TimestampGranularity, TimestampSource, TranscriptSegment, TranscriptWord};
use crate::runtimes::onnx::build_session;
use crate::transcription::{
    EngineTranscriptOutput, GpuConfig, TranscriptionError, TranscriptionRequest,
    validate_audio_samples, validate_model_path,
};

const VOCAB: usize = 8193;
const BLANK: i32 = VOCAB as i32 - 1;
const DURATION_CLASSES: usize = 5;
const HIDDEN: usize = 640;
const LAYERS: usize = 2;
const ENCODER_DIM: usize = 1024;
const MAX_SAMPLES: usize = 35 * 16_000;
const FRAME_MS: u64 = 80;
const MAX_TOKENS_PER_FRAME: usize = 10;
const LANGUAGES: [&str; 8] = ["en", "es", "de", "fr", "pt", "it", "nl", "hr"];

static CAPABILITIES: LazyLock<ModelFamilyCapabilities> =
    LazyLock::new(|| ModelFamilyCapabilities {
        task: ModelTask::Stt,
        supports_hardware_acceleration: false,
        available_voices: Vec::new(),
        supports_speed_control: false,
        output_sample_rate: None,
        supports_segment_timestamps: true,
        supports_word_timestamps: true,
        supports_initial_prompt: false,
        supports_streaming: false,
        supports_language_selection: true,
        supports_automatic_language_detection: true,
        supported_languages: LanguageSupport::List {
            tags: LANGUAGES.iter().map(|s| (*s).into()).collect(),
        },
        max_audio_duration_secs: Some(35.0),
        produces_punctuation: true,
    });

#[derive(Default)]
pub struct ParakeetTdtAdapter;

impl ModelFamilyAdapter for ParakeetTdtAdapter {
    fn runtime_id(&self) -> RuntimeId {
        RuntimeId::OnnxRuntime
    }
    fn family_id(&self) -> ModelFamilyId {
        ModelFamilyId::ParakeetTdt
    }
    fn capabilities(&self) -> &ModelFamilyCapabilities {
        &CAPABILITIES
    }
    fn probe_model(&self, path: &Path) -> Result<(), TranscriptionError> {
        Model::load(path).map(|_| ())
    }
    fn load(
        &self,
        path: &Path,
        _gpu: GpuConfig,
    ) -> Result<Box<dyn LoadedModel>, TranscriptionError> {
        Ok(Box::new(Model::load(path)?))
    }
}

fn invalid(message: impl ToString) -> TranscriptionError {
    TranscriptionError::invalid_model_with_details(message.to_string())
}

fn verify_graph(
    session: &Session,
    name: &str,
    inputs: &[(&str, TensorElementType, &[i64])],
    outputs: &[(&str, TensorElementType, &[i64])],
) -> Result<(), TranscriptionError> {
    for (actual, expected) in [(session.inputs(), inputs), (session.outputs(), outputs)] {
        if actual.len() != expected.len() {
            return Err(invalid(format!("{name} graph I/O count mismatch")));
        }
        for (actual, &(expected_name, expected_type, expected_shape)) in actual.iter().zip(expected)
        {
            let valid = match actual.dtype() {
                ValueType::Tensor { ty, shape, .. } => {
                    *ty == expected_type && shape.as_ref() == expected_shape
                }
                _ => false,
            };
            if actual.name() != expected_name || !valid {
                return Err(invalid(format!(
                    "{name}: expected {expected_name} {expected_type:?} {expected_shape:?}, got {} {:?}",
                    actual.name(),
                    actual.dtype()
                )));
            }
        }
    }
    Ok(())
}

struct Model {
    frontend: Session,
    encoder: Session,
    decoder: Session,
    tokenizer: NemoTokenizer,
}

impl Model {
    fn load(path: &Path) -> Result<Self, TranscriptionError> {
        validate_model_path(path)?;
        if path.file_name().and_then(|p| p.to_str()) != Some("encoder-model.int8.onnx") {
            return Err(invalid(
                "select encoder-model.int8.onnx for Parakeet TDT v3",
            ));
        }
        let dir = path
            .parent()
            .ok_or_else(|| invalid("model directory missing"))?;
        let config: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.join("config.json")).map_err(invalid)?)
                .map_err(invalid)?;
        if config["model_type"] != "nemo-conformer-tdt"
            || config["features_size"] != 128
            || config["subsampling_factor"] != 8
        {
            return Err(invalid("unsupported Parakeet TDT configuration"));
        }
        let tokenizer = NemoTokenizer::load(&dir.join("vocab.txt"))?;
        tokenizer.validate(VOCAB)?;
        let cpu = GpuConfig { use_gpu: false };
        let frontend = build_session(&dir.join("nemo128.onnx"), cpu)?;
        let encoder = build_session(path, cpu)?;
        let decoder = build_session(&dir.join("decoder_joint-model.int8.onnx"), cpu)?;
        use TensorElementType::{Float32 as F, Int32 as I, Int64 as L};
        verify_graph(
            &frontend,
            "frontend",
            &[("waveforms", F, &[-1, -1]), ("waveforms_lens", L, &[-1])],
            &[("features", F, &[-1, 128, -1]), ("features_lens", L, &[-1])],
        )?;
        verify_graph(
            &encoder,
            "encoder",
            &[("audio_signal", F, &[-1, 128, -1]), ("length", L, &[-1])],
            &[
                ("outputs", F, &[-1, 1024, -1]),
                ("encoded_lengths", L, &[-1]),
            ],
        )?;
        verify_graph(
            &decoder,
            "decoder",
            &[
                ("encoder_outputs", F, &[-1, 1024, -1]),
                ("targets", I, &[-1, -1]),
                ("target_length", I, &[-1]),
                ("input_states_1", F, &[2, -1, 640]),
                ("input_states_2", F, &[2, -1, 640]),
            ],
            &[
                ("outputs", F, &[-1, -1, -1, 8198]),
                ("prednet_lengths", I, &[-1]),
                ("output_states_1", F, &[2, -1, 640]),
                ("output_states_2", F, &[2, -1, 640]),
            ],
        )?;
        Ok(Self {
            frontend,
            encoder,
            decoder,
            tokenizer,
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
struct TimedToken {
    id: i32,
    frame: usize,
    duration: usize,
}

/// Mirrors the export's greedy TDT decoder. The callback commits recurrent state
/// only for nonblank tokens; blanks must not advance the predictor state.
fn decode_tokens(
    mut next: impl FnMut(usize, i32) -> Result<(i32, usize), TranscriptionError>,
    frames: usize,
) -> Result<Vec<TimedToken>, TranscriptionError> {
    let mut tokens = Vec::new();
    let mut frame = 0;
    let mut emitted = 0;
    let mut previous = BLANK;
    while frame < frames {
        let (id, duration) = next(frame, previous)?;
        if !(0..VOCAB as i32).contains(&id) || duration >= DURATION_CLASSES {
            return Err(TranscriptionError::transcription_failure(
                "Parakeet TDT",
                "invalid token or duration",
            ));
        }
        if id != BLANK {
            tokens.push(TimedToken {
                id,
                frame,
                duration,
            });
            previous = id;
            emitted += 1;
        }
        if duration > 0 {
            frame += duration;
            emitted = 0;
        } else if id == BLANK || emitted == MAX_TOKENS_PER_FRAME {
            frame += 1;
            emitted = 0;
        }
    }
    Ok(tokens)
}

fn argmax(logits: &[f32]) -> Result<usize, TranscriptionError> {
    if logits.is_empty() || logits.iter().any(|v| !v.is_finite()) {
        return Err(TranscriptionError::transcription_failure(
            "Parakeet TDT logits",
            "empty or nonfinite output",
        ));
    }
    Ok(logits
        .iter()
        .enumerate()
        .max_by(|(ia, a), (ib, b)| a.total_cmp(b).then_with(|| ib.cmp(ia)))
        .unwrap()
        .0)
}

impl LoadedModel for Model {
    fn transcribe(
        &mut self,
        request: &TranscriptionRequest,
    ) -> Result<EngineTranscriptOutput, TranscriptionError> {
        validate_audio_samples(&request.audio_samples)?;
        if request.language != "auto" && !LANGUAGES.contains(&request.language.as_str()) {
            return Err(TranscriptionError::unsupported_language(
                &request.language,
                "Parakeet TDT supports en/es/de/fr/pt/it/nl/hr or auto",
            ));
        }
        if request.audio_samples.len() > MAX_SAMPLES {
            return Err(TranscriptionError::transcription_failure(
                "Parakeet TDT audio",
                "audio exceeds the 35-second per-utterance bound",
            ));
        }
        let count = request.audio_samples.len();
        let lengths = [count as i64];
        let features = self.frontend.run(ort::inputs!["waveforms" => tensor_ref([1,count], &request.audio_samples, "waveform")?, "waveforms_lens" => tensor_ref([1], &lengths, "waveform length")?]).map_err(|e| TranscriptionError::transcription_failure("Parakeet TDT frontend", e))?;
        let (feature_shape, feature_data) = tensor_f32(&features["features"], "features")?;
        let time = dimension(feature_shape, 2, "features")?;
        tensor_f32_exact(&features["features"], &[1, 128, time], "features")?;
        let feature_lengths = tensor_i64_exact(&features["features_lens"], &[1], "feature length")?;
        let encoded = self.encoder.run(ort::inputs!["audio_signal" => tensor_ref([1,128,time], feature_data, "features")?, "length" => tensor_ref([1], feature_lengths, "feature length")?]).map_err(|e| TranscriptionError::transcription_failure("Parakeet TDT encoder", e))?;
        let (shape, data) = tensor_f32(&encoded["outputs"], "encoder")?;
        let time = dimension(shape, 2, "encoder")?;
        tensor_f32_exact(&encoded["outputs"], &[1, ENCODER_DIM, time], "encoder")?;
        let length = tensor_i64_exact(&encoded["encoded_lengths"], &[1], "encoded length")?[0];
        let length = usize::try_from(length)
            .ok()
            .filter(|&len| len <= time)
            .ok_or_else(|| graph_shape_error("encoded length", &[length]))?;
        let mut state1 = vec![0.0; LAYERS * HIDDEN];
        let mut state2 = state1.clone();
        let mut frame_data = vec![0.0; ENCODER_DIM];
        let decoder = &mut self.decoder;
        let tokens = decode_tokens(
            |frame, previous| {
                for (channel, value) in frame_data.iter_mut().enumerate() {
                    *value = data[channel * time + frame];
                }
                let targets = [previous];
                let lengths = [1_i32];
                let output = decoder.run(ort::inputs![
                "encoder_outputs" => tensor_ref([1,ENCODER_DIM,1], &frame_data, "encoder frame")?,
                "targets" => tensor_ref([1,1], &targets, "targets")?,
                "target_length" => tensor_ref([1], &lengths, "target length")?,
                "input_states_1" => tensor_ref([LAYERS,1,HIDDEN], &state1, "state1")?,
                "input_states_2" => tensor_ref([LAYERS,1,HIDDEN], &state2, "state2")?
            ]).map_err(|e| TranscriptionError::transcription_failure("Parakeet TDT decoder", e))?;
                let logits = tensor_f32_exact(
                    &output["outputs"],
                    &[1, 1, 1, VOCAB + DURATION_CLASSES],
                    "joint logits",
                )?;
                let id = argmax(&logits[..VOCAB])? as i32;
                let duration = argmax(&logits[VOCAB..])?;
                if id != BLANK {
                    state1.copy_from_slice(tensor_f32_exact(
                        &output["output_states_1"],
                        &[LAYERS, 1, HIDDEN],
                        "state1",
                    )?);
                    state2.copy_from_slice(tensor_f32_exact(
                        &output["output_states_2"],
                        &[LAYERS, 1, HIDDEN],
                        "state2",
                    )?);
                }
                Ok((id, duration))
            },
            length,
        )?;
        let text = self
            .tokenizer
            .decode(&tokens.iter().map(|t| t.id).collect::<Vec<_>>())?;
        if text.is_empty() {
            return Ok(EngineTranscriptOutput {
                segments: Vec::new(),
                diagnostics: Vec::new(),
                detected_language: None,
            });
        }
        let audio_ms = count as u64 * 1_000 / 16_000;
        let words = if request.detailed_timestamps_enabled {
            timed_words(&tokens, |id| self.tokenizer.piece(id), audio_ms)?
        } else {
            Vec::new()
        };
        let start_ms = tokens
            .first()
            .map_or(0, |t| t.frame as u64 * FRAME_MS)
            .min(audio_ms);
        let end_ms = tokens
            .last()
            .map_or(audio_ms, |t| {
                (t.frame + t.duration.max(1)) as u64 * FRAME_MS
            })
            .min(audio_ms);
        Ok(EngineTranscriptOutput {
            segments: vec![TranscriptSegment {
                start_ms,
                end_ms,
                text,
                speaker: None,
                timestamp_granularity: if words.is_empty() {
                    TimestampGranularity::Segment
                } else {
                    TimestampGranularity::Word
                },
                timestamp_source: TimestampSource::Engine,
                words,
            }],
            diagnostics: Vec::new(),
            detected_language: None,
        })
    }
}

fn timed_words<'a>(
    tokens: &[TimedToken],
    piece: impl Fn(i32) -> Option<&'a str>,
    audio_ms: u64,
) -> Result<Vec<TranscriptWord>, TranscriptionError> {
    let mut words: Vec<TranscriptWord> = Vec::new();
    for token in tokens {
        let piece = piece(token.id).ok_or_else(|| invalid("token outside vocabulary"))?;
        if piece.starts_with('<') && piece.ends_with('>') {
            continue;
        }
        let starts_word = piece.starts_with('▁');
        let text = piece.replace('▁', " ");
        let text = if starts_word {
            text.trim_start()
        } else {
            &text
        };
        if text.is_empty() {
            continue;
        }
        let start_ms = (token.frame as u64 * FRAME_MS).min(audio_ms);
        let end_ms = ((token.frame + token.duration.max(1)) as u64 * FRAME_MS).min(audio_ms);
        if starts_word || words.is_empty() {
            if let Some(previous) = words.last_mut() {
                previous.end_ms = previous.end_ms.min(start_ms);
            }
            words.push(TranscriptWord {
                start_ms,
                end_ms,
                text: text.into(),
                timestamp_source: TimestampSource::Engine,
            });
        } else if let Some(word) = words.last_mut() {
            word.text.push_str(text);
            word.end_ms = end_ms;
        }
    }
    Ok(words)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn logits_ties_choose_first_class_like_reference_numpy_decoder() {
        assert_eq!(argmax(&[1.0, 1.0, 0.0]).unwrap(), 0);
        assert!(argmax(&[f32::NAN]).is_err());
    }
    #[test]
    fn blank_preserves_previous_token_and_positive_duration_skips_frames() {
        let mut calls = Vec::new();
        let mut next = vec![(7, 0), (BLANK, 0), (BLANK, 3), (8, 1)].into_iter();
        let tokens = decode_tokens(
            |frame, previous| {
                calls.push((frame, previous));
                Ok(next.next().unwrap())
            },
            5,
        )
        .unwrap();
        assert_eq!(calls, vec![(0, BLANK), (0, 7), (1, 7), (4, 7)]);
        assert_eq!(
            tokens.iter().map(|t| (t.id, t.frame)).collect::<Vec<_>>(),
            vec![(7, 0), (8, 4)]
        );
    }
    #[test]
    fn zero_duration_nonblank_output_is_bounded_per_encoder_frame() {
        let mut calls = 0;
        let tokens = decode_tokens(
            |_, _| {
                calls += 1;
                Ok((7, 0))
            },
            3,
        )
        .unwrap();
        assert_eq!(calls, 3 * MAX_TOKENS_PER_FRAME);
        assert_eq!(tokens.last().unwrap().frame, 2);
    }
    #[test]
    fn subword_timing_merges_punctuation_and_clamps_to_audio() {
        let tokens = vec![
            TimedToken {
                id: 0,
                frame: 0,
                duration: 0,
            },
            TimedToken {
                id: 1,
                frame: 1,
                duration: 2,
            },
            TimedToken {
                id: 2,
                frame: 2,
                duration: 0,
            },
            TimedToken {
                id: 3,
                frame: 4,
                duration: 4,
            },
        ];
        let pieces = ["▁Hel", "lo", ",", "▁world!"];
        let words = timed_words(&tokens, |id| pieces.get(id as usize).copied(), 360).unwrap();
        assert_eq!(
            words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>(),
            vec!["Hello,", "world!"]
        );
        assert_eq!((words[0].start_ms, words[0].end_ms), (0, 240));
        assert_eq!((words[1].start_ms, words[1].end_ms), (320, 360));
    }
}
