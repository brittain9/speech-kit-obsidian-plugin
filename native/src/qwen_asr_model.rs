//! Helper-only model code. Never import this module into the Whisper sidecar.
use crate::asr_helper_protocol::{MAX_AUDIO_SAMPLES, language_name, parse_output};
use anyhow::{Context, Result, ensure};
use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::LlamaModel;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::mtmd::{
    MtmdBitmap, MtmdContext, MtmdContextParams, MtmdInputText, mtmd_default_marker,
};
use llama_cpp_2::sampling::LlamaSampler;
use std::num::NonZeroU32;
use std::path::Path;

const CONTEXT_SIZE: u32 = 4096;
const MAX_OUTPUT_TOKENS: usize = 768;
const THREADS: i32 = 8;

pub struct QwenAsrModel {
    // The encoder context can refer to the decoder model; drop it first.
    encoder: MtmdContext,
    model: LlamaModel,
    use_gpu: bool,
}

impl QwenAsrModel {
    pub fn load(backend: &LlamaBackend, path: &Path, use_gpu: bool) -> Result<Self> {
        let name = path
            .file_name()
            .and_then(|p| p.to_str())
            .context("invalid model filename")?;
        ensure!(
            name.starts_with("Qwen3-ASR-") && name.ends_with(".gguf"),
            "unsupported Qwen model layout"
        );
        let projector = path.with_file_name(format!("mmproj-{name}"));
        ensure!(
            path.is_file() && projector.is_file(),
            "Qwen model pair is incomplete"
        );
        let use_gpu = use_gpu && cfg!(any(feature = "gpu-metal", feature = "gpu-cuda"));
        let mut params = LlamaModelParams::default().with_n_gpu_layers(0);
        if use_gpu {
            params = params.with_n_gpu_layers(1000);
        } else {
            params = params.with_devices(&[])?;
        }
        let model = LlamaModel::load_from_file(backend, path, &params)
            .context("Qwen decoder load failed")?;
        ensure!(
            model.meta_val_str("general.architecture").ok().as_deref() == Some("qwen3vl"),
            "unsupported Qwen decoder architecture"
        );
        ensure!(
            model.vocab().tokenize(b"<asr_text>", false, true).len() == 1,
            "Qwen ASR tokenizer is missing"
        );
        let encoder = MtmdContext::init_from_file(
            projector.to_str().context("invalid encoder path")?,
            &model,
            &MtmdContextParams {
                use_gpu,
                print_timings: false,
                n_threads: THREADS,
                ..Default::default()
            },
        )
        .context("Qwen encoder load failed")?;
        ensure!(
            encoder.support_audio() && encoder.get_audio_sample_rate() == Some(16_000),
            "unsupported Qwen audio encoder"
        );
        Ok(Self {
            encoder,
            model,
            use_gpu,
        })
    }

    pub fn transcribe(
        &mut self,
        backend: &LlamaBackend,
        samples: &[f32],
        language: &str,
    ) -> Result<(String, Option<String>)> {
        ensure!(
            !samples.is_empty()
                && samples.len() <= MAX_AUDIO_SAMPLES
                && samples.iter().all(|x| x.is_finite() && x.abs() <= 1.0),
            "invalid bounded PCM input"
        );
        let suffix = if language == "auto" {
            String::new()
        } else {
            format!(
                "language {}<asr_text>",
                language_name(language).context("unsupported language")?
            )
        };
        let prompt = format!(
            "<|im_start|>system\n<|im_end|>\n<|im_start|>user\n{}<|im_end|>\n<|im_start|>assistant\n{suffix}",
            mtmd_default_marker()
        );
        let padded;
        let samples = if samples.len() < 8_000 {
            padded = {
                let mut s = samples.to_vec();
                s.resize(8_000, 0.0);
                s
            };
            padded.as_slice()
        } else {
            samples
        };
        let audio = MtmdBitmap::from_audio_data(samples)?;
        let chunks = self.encoder.tokenize(
            MtmdInputText {
                text: prompt,
                add_special: true,
                parse_special: true,
            },
            &[&audio],
        )?;
        ensure!(
            chunks.total_positions() >= 0
                && chunks.total_positions() as usize + MAX_OUTPUT_TOKENS < CONTEXT_SIZE as usize,
            "audio exceeds Qwen context bound"
        );
        let params = LlamaContextParams::default()
            .with_n_ctx(NonZeroU32::new(CONTEXT_SIZE))
            .with_n_batch(512)
            .with_n_ubatch(512)
            .with_n_threads(THREADS)
            .with_n_threads_batch(THREADS)
            .with_offload_kqv(self.use_gpu)
            .with_op_offload(self.use_gpu);
        // Fresh decoder context resets KV state without reloading model weights.
        let mut context = self.model.new_context(backend, params)?;
        let mut position = chunks.eval_chunks(&mut self.encoder, &mut context, 0, 0, 512, true)?;
        let mut sampler = LlamaSampler::greedy();
        let vocab = self.model.vocab();
        let mut bytes = Vec::new();
        let mut batch = LlamaBatch::new(1, 1);
        for _ in 0..MAX_OUTPUT_TOKENS {
            let token = sampler.sample(&context, -1);
            sampler.accept(token);
            if vocab.is_eog(token) {
                let raw = String::from_utf8(bytes).context("invalid Qwen text encoding")?;
                return parse_output(&raw, language).map_err(anyhow::Error::msg);
            }
            // Keep ASR metadata delimiters so parsing can remove them correctly.
            vocab.token_to_piece_into(token, &mut bytes, true, None);
            batch.clear();
            batch.add(token, position, &[0], true)?;
            context.decode(&mut batch)?;
            position += 1;
        }
        anyhow::bail!("Qwen output token limit reached before completion")
    }
}
