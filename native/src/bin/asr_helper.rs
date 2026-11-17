use anyhow::Result;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::{LogOptions, send_logs_to_tracing};
use std::io::{self, BufReader, BufWriter};

// Do not import the sidecar library: that links Whisper's conflicting GGML.
#[path = "../asr_helper_protocol.rs"]
mod asr_helper_protocol;
#[path = "../qwen_asr_model.rs"]
mod qwen_asr_model;
use asr_helper_protocol::{AsrCommand, AsrEvent, PROTOCOL_VERSION, read_frame, write_frame};
use qwen_asr_model::QwenAsrModel;

fn main() -> Result<()> {
    send_logs_to_tracing(LogOptions::default().with_logs_enabled(false));
    let backend = LlamaBackend::init()?;
    let mut model: Option<QwenAsrModel> = None;
    let mut reader = BufReader::new(io::stdin().lock());
    let mut writer = BufWriter::new(io::stdout().lock());
    write_frame(
        &mut writer,
        &AsrEvent::Ready {
            version: env!("CARGO_PKG_VERSION").into(),
            protocol_version: PROTOCOL_VERSION,
        },
    )?;
    while let Some(command) = read_frame::<_, AsrCommand>(&mut reader)? {
        let event = match command {
            AsrCommand::Shutdown => break,
            AsrCommand::Load {
                model_path,
                use_gpu,
            } => {
                // Load failure invalidates an older pair as well.
                model = None;
                match QwenAsrModel::load(&backend, &model_path, use_gpu) {
                    Ok(loaded) => {
                        model = Some(loaded);
                        AsrEvent::Loaded
                    }
                    Err(_) => AsrEvent::Error {
                        code: "model_pair_load_failed".into(),
                    },
                }
            }
            AsrCommand::Transcribe {
                request_id,
                audio_samples,
                language,
            } => {
                match model
                    .as_mut()
                    .map(|m| m.transcribe(&backend, &audio_samples, &language))
                {
                    Some(Ok((text, detected_language))) => AsrEvent::Transcript {
                        request_id,
                        text,
                        detected_language,
                    },
                    Some(Err(_)) => AsrEvent::Error {
                        code: "inference_failed".into(),
                    },
                    None => AsrEvent::Error {
                        code: "model_not_loaded".into(),
                    },
                }
            }
        };
        write_frame(&mut writer, &event)?;
    }
    Ok(())
}
