//! Shared NeMo RNNT tokenizer, acoustic frontend, and ONNX tensor helpers.

use crate::transcription::TranscriptionError;
use ort::value::{DynValue, PrimitiveTensorElementType, TensorRef};
use realfft::num_complex::Complex;
use realfft::{RealFftPlanner, RealToComplex};
use std::fs;
use std::path::Path;
use std::sync::Arc;

const SAMPLE_RATE: usize = 16_000;
const FRAME_SHIFT_SAMPLES: usize = 160;
const FRAME_LENGTH_SAMPLES: usize = 400;
const FFT_SIZE: usize = 512;
const FFT_BINS: usize = FFT_SIZE / 2 + 1;
const STFT_WINDOW_OFFSET: usize = (FFT_SIZE - FRAME_LENGTH_SAMPLES) / 2;
const FEATURE_DIM: usize = 128;
const PREEMPHASIS_COEFFICIENT: f32 = 0.97;
const LOG_ZERO_GUARD: f32 = 1.0 / 16_777_216.0;

pub(crate) struct NemoTokenizer {
    pieces: Vec<String>,
}

impl NemoTokenizer {
    pub(crate) fn load(path: &Path) -> Result<Self, TranscriptionError> {
        let text = fs::read_to_string(path).map_err(|error| {
            TranscriptionError::invalid_model_with_details(format!(
                "failed to read {}: {error}",
                path.display()
            ))
        })?;
        let mut pieces = Vec::new();
        for (line_number, line) in text.lines().enumerate() {
            let (piece, id) = line.rsplit_once(' ').ok_or_else(|| {
                TranscriptionError::invalid_model_with_details(format!(
                    "invalid tokens.txt line {}",
                    line_number + 1
                ))
            })?;
            let id = id.parse::<usize>().map_err(|error| {
                TranscriptionError::invalid_model_with_details(format!(
                    "invalid tokens.txt id on line {}: {error}",
                    line_number + 1
                ))
            })?;
            if id != pieces.len() || piece.is_empty() {
                return Err(TranscriptionError::invalid_model_with_details(format!(
                    "tokens.txt must contain contiguous non-empty pieces; line {} declares id {id}",
                    line_number + 1
                )));
            }
            pieces.push(piece.to_string());
        }
        Ok(Self { pieces })
    }

    pub(crate) fn validate(&self, vocab_size: usize) -> Result<(), TranscriptionError> {
        if self.pieces.len() != vocab_size
            || self.pieces.last().map(String::as_str) != Some("<blk>")
        {
            return Err(TranscriptionError::invalid_model_with_details(format!(
                "tokenizer mismatch: expected {vocab_size} pieces ending in <blk>, found {}",
                self.pieces.len()
            )));
        }
        Ok(())
    }

    pub(crate) fn decode(&self, token_ids: &[i32]) -> Result<String, TranscriptionError> {
        let mut text = String::new();
        for &id in token_ids {
            let piece = usize::try_from(id)
                .ok()
                .and_then(|id| self.pieces.get(id))
                .ok_or_else(|| {
                    TranscriptionError::transcription_failure(
                        "Nemotron tokenizer",
                        format!("token id {id} is outside the vocabulary"),
                    )
                })?;
            if is_language_tag(piece) {
                continue;
            }
            text.push_str(piece);
        }
        Ok(text.replace('▁', " ").trim().to_string())
    }
}

fn is_language_tag(piece: &str) -> bool {
    let bytes = piece.as_bytes();
    if bytes.len() < 4 || bytes[0] != b'<' || bytes[bytes.len() - 1] != b'>' {
        return false;
    }
    let body = &bytes[1..bytes.len() - 1];
    if (2..=3).contains(&body.len()) && body.iter().all(u8::is_ascii_lowercase) {
        return true;
    }
    body.len() == 5
        && body[..2].iter().all(u8::is_ascii_lowercase)
        && body[2] == b'-'
        && body[3..].iter().all(u8::is_ascii_uppercase)
}

pub(crate) struct OnlineNemoFeatures {
    audio: Vec<f32>,
    features: Vec<[f32; FEATURE_DIM]>,
    filterbank: Vec<[f32; FFT_BINS]>,
    fft: Arc<dyn RealToComplex<f32>>,
    fft_input: Vec<f32>,
    fft_output: Vec<Complex<f32>>,
    fft_scratch: Vec<Complex<f32>>,
    finished: bool,
    window: [f32; FRAME_LENGTH_SAMPLES],
}

impl OnlineNemoFeatures {
    pub(crate) fn new() -> Self {
        let fft = RealFftPlanner::<f32>::new().plan_fft_forward(FFT_SIZE);
        let fft_input = fft.make_input_vec();
        let fft_output = fft.make_output_vec();
        let fft_scratch = fft.make_scratch_vec();
        Self {
            audio: Vec::new(),
            features: Vec::new(),
            filterbank: build_librosa_filterbank(),
            fft,
            fft_input,
            fft_output,
            fft_scratch,
            finished: false,
            window: build_symmetric_hann_window(),
        }
    }

    pub(crate) fn accept(&mut self, samples: &[i16]) {
        debug_assert!(!self.finished);
        self.audio
            .extend(samples.iter().map(|&sample| sample as f32 / 32768.0));
        self.compute_available(false);
    }

    pub(crate) fn finish(&mut self) {
        if !self.finished {
            self.finished = true;
            self.compute_available(true);
        }
    }

    pub(crate) fn reset(&mut self) {
        self.audio.clear();
        self.features.clear();
        self.finished = false;
    }

    pub(crate) fn len(&self) -> usize {
        self.features.len()
    }

    fn compute_available(&mut self, flush: bool) {
        if self.audio.is_empty() {
            return;
        }
        let target = frame_count(self.audio.len(), flush);
        while self.features.len() < target {
            let frame = self.compute_frame(self.features.len());
            self.features.push(frame);
        }
    }

    fn compute_frame(&mut self, frame_index: usize) -> [f32; FEATURE_DIM] {
        let start = frame_index as isize * FRAME_SHIFT_SAMPLES as isize
            - (FRAME_LENGTH_SAMPLES / 2) as isize;
        self.fft_input.fill(0.0);
        for (offset, sample) in self.fft_input
            [STFT_WINDOW_OFFSET..STFT_WINDOW_OFFSET + FRAME_LENGTH_SAMPLES]
            .iter_mut()
            .enumerate()
        {
            *sample =
                preemphasized_sample(&self.audio, start + offset as isize) * self.window[offset];
        }

        self.fft
            .process_with_scratch(
                &mut self.fft_input,
                &mut self.fft_output,
                &mut self.fft_scratch,
            )
            .expect("Nemotron FFT buffers match the planned size");
        let mut power = [0.0_f32; FFT_BINS];
        for (index, value) in self.fft_output.iter().enumerate() {
            power[index] = value.re * value.re + value.im * value.im;
        }

        let mut result = [0.0_f32; FEATURE_DIM];
        for (mel_index, weights) in self.filterbank.iter().enumerate() {
            let energy = weights
                .iter()
                .zip(power)
                .map(|(weight, value)| weight * value)
                .sum::<f32>();
            result[mel_index] = (energy + LOG_ZERO_GUARD).ln();
        }
        result
    }

    pub(crate) fn window(&self, start: usize, frame_count: usize) -> Vec<f32> {
        let mut window = vec![0.0_f32; frame_count * FEATURE_DIM];
        for target_frame in 0..frame_count {
            if let Some(source) = self.features.get(start + target_frame) {
                window[target_frame * FEATURE_DIM..(target_frame + 1) * FEATURE_DIM]
                    .copy_from_slice(source);
            }
        }
        window
    }
}

fn frame_count(sample_count: usize, flush: bool) -> usize {
    if flush {
        return sample_count / FRAME_SHIFT_SAMPLES;
    }
    sample_count
        .saturating_sub(FRAME_LENGTH_SAMPLES / 2)
        .div_ceil(FRAME_SHIFT_SAMPLES)
}

fn preemphasized_sample(audio: &[f32], index: isize) -> f32 {
    let Ok(index) = usize::try_from(index) else {
        return 0.0;
    };
    let Some(&sample) = audio.get(index) else {
        return 0.0;
    };
    if index == 0 {
        sample
    } else {
        sample - PREEMPHASIS_COEFFICIENT * audio[index - 1]
    }
}

fn build_symmetric_hann_window() -> [f32; FRAME_LENGTH_SAMPLES] {
    std::array::from_fn(|index| {
        let phase = 2.0 * std::f32::consts::PI * index as f32 / (FRAME_LENGTH_SAMPLES - 1) as f32;
        0.5 - 0.5 * phase.cos()
    })
}

fn build_librosa_filterbank() -> Vec<[f32; FFT_BINS]> {
    let mel_min = hz_to_slaney_mel(0.0);
    let mel_max = hz_to_slaney_mel(SAMPLE_RATE as f32 / 2.0);
    let mel_step = (mel_max - mel_min) / (FEATURE_DIM + 1) as f32;
    (0..FEATURE_DIM)
        .map(|bin| {
            let left = slaney_mel_to_hz(mel_min + bin as f32 * mel_step);
            let center = slaney_mel_to_hz(mel_min + (bin + 1) as f32 * mel_step);
            let right = slaney_mel_to_hz(mel_min + (bin + 2) as f32 * mel_step);
            let normalization = 2.0 / (right - left);
            std::array::from_fn(|fft_bin| {
                let hz = SAMPLE_RATE as f32 / FFT_SIZE as f32 * fft_bin as f32;
                if hz > left && hz <= center {
                    (hz - left) / (center - left) * normalization
                } else if hz > center && hz < right {
                    (right - hz) / (right - center) * normalization
                } else {
                    0.0
                }
            })
        })
        .collect()
}

fn hz_to_slaney_mel(hz: f32) -> f32 {
    if hz <= 1_000.0 {
        hz * 3.0 / 200.0
    } else {
        15.0 + 14.545_078 * (hz / 1_000.0).ln()
    }
}

fn slaney_mel_to_hz(mel: f32) -> f32 {
    if mel <= 15.0 {
        200.0 / 3.0 * mel
    } else {
        1_000.0 * ((mel - 15.0) * 0.068_751_775).exp()
    }
}

pub(crate) fn tensor_ref<'a, T, const RANK: usize>(
    shape: [usize; RANK],
    data: &'a [T],
    context: &str,
) -> Result<TensorRef<'a, T>, TranscriptionError>
where
    T: PrimitiveTensorElementType + Clone + std::fmt::Debug + 'static,
{
    TensorRef::from_array_view((shape, data))
        .map_err(|error| TranscriptionError::transcription_failure(context, &error))
}

pub(crate) fn output_at<'a>(
    outputs: &'a ort::session::SessionOutputs<'_>,
    index: usize,
    name: &str,
) -> Result<&'a DynValue, TranscriptionError> {
    if index >= outputs.len() {
        return Err(TranscriptionError::transcription_failure(
            "Nemotron graph output",
            format!("missing {name} at index {index}"),
        ));
    }
    Ok(&outputs[index])
}

pub(crate) fn tensor_f32<'a>(
    value: &'a DynValue,
    name: &str,
) -> Result<(&'a [i64], &'a [f32]), TranscriptionError> {
    let (shape, data) = value
        .try_extract_tensor::<f32>()
        .map_err(|error| TranscriptionError::transcription_failure(name, &error))?;
    Ok((shape, data))
}

pub(crate) fn tensor_f32_exact<'a>(
    value: &'a DynValue,
    expected_shape: &[usize],
    name: &str,
) -> Result<&'a [f32], TranscriptionError> {
    let (shape, data) = tensor_f32(value, name)?;
    if !shape_matches(shape, expected_shape) {
        return Err(graph_shape_error(name, shape));
    }
    Ok(data)
}

pub(crate) fn tensor_i64_exact<'a>(
    value: &'a DynValue,
    expected_shape: &[usize],
    name: &str,
) -> Result<&'a [i64], TranscriptionError> {
    let (shape, data) = value
        .try_extract_tensor::<i64>()
        .map_err(|error| TranscriptionError::transcription_failure(name, &error))?;
    if !shape_matches(shape, expected_shape) {
        return Err(graph_shape_error(name, shape));
    }
    Ok(data)
}

fn shape_matches(actual: &[i64], expected: &[usize]) -> bool {
    actual.len() == expected.len()
        && actual
            .iter()
            .zip(expected)
            .all(|(&actual, &expected)| actual == expected as i64)
}

pub(crate) fn dimension(
    shape: &[i64],
    index: usize,
    name: &str,
) -> Result<usize, TranscriptionError> {
    shape
        .get(index)
        .and_then(|value| usize::try_from(*value).ok())
        .ok_or_else(|| graph_shape_error(name, shape))
}

pub(crate) fn graph_shape_error(name: &str, shape: &[i64]) -> TranscriptionError {
    TranscriptionError::transcription_failure(
        "Nemotron graph shape",
        format!("unexpected {name} shape {shape:?}"),
    )
}
