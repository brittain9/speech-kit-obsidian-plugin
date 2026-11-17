use anyhow::Result;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::{LogOptions, send_logs_to_tracing};
use std::io::{self, BufReader, BufWriter};
use std::sync::mpsc::{self, Receiver};
use std::thread;

// Do not import the sidecar library: that links Whisper's conflicting GGML.
#[path = "../asr_helper_protocol.rs"]
mod asr_helper_protocol;
#[path = "../qwen_asr_model.rs"]
mod qwen_asr_model;
use asr_helper_protocol::{AsrCommand, AsrEvent, PROTOCOL_VERSION, read_frame, write_frame};
use qwen_asr_model::QwenAsrModel;

fn command_reader() -> Receiver<AsrCommand> {
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut reader = BufReader::new(io::stdin());
        loop {
            match read_frame::<_, AsrCommand>(&mut reader) {
                Ok(Some(command)) => {
                    let shutdown = matches!(command, AsrCommand::Shutdown);
                    // This protocol is sequential. Never block EOF monitoring on
                    // an overflowing queue while the model is busy.
                    if sender.try_send(command).is_err() {
                        std::process::exit(2);
                    }
                    if shutdown {
                        return;
                    }
                }
                // No result can be delivered after the owning sidecar closes
                // stdin. Exit even during native model load/encoding/decode.
                _ => std::process::exit(0),
            }
        }
    });
    receiver
}

fn main() -> Result<()> {
    send_logs_to_tracing(LogOptions::default().with_logs_enabled(false));
    let commands = command_reader();
    let backend = LlamaBackend::init()?;
    let mut model: Option<QwenAsrModel> = None;
    // Do not hold the stdout lock across inference: the EOF watcher must be
    // able to run process-exit cleanup while the model thread is occupied.
    let mut writer = BufWriter::new(io::stdout());
    write_frame(
        &mut writer,
        &AsrEvent::Ready {
            version: env!("CARGO_PKG_VERSION").into(),
            protocol_version: PROTOCOL_VERSION,
        },
    )?;
    while let Ok(command) = commands.recv() {
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    #[test]
    #[ignore = "subprocess fixture selected only by the parent EOF test"]
    fn busy_owner_loss_fixture() {
        let Ok(marker) = std::env::var("SPEECH_KIT_ASR_EOF_TEST_MARKER") else {
            return;
        };
        let _commands = command_reader();
        std::fs::write(marker, b"ready").unwrap();
        // Represents a synchronous native operation that cannot poll stdin.
        thread::sleep(Duration::from_secs(60));
        panic!("ownerless helper remained alive");
    }

    #[test]
    fn closed_owner_stdin_terminates_the_busy_helper_and_reaps_it() {
        let marker = std::env::temp_dir().join(format!("asr-owner-eof-{}", uuid::Uuid::new_v4()));
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "tests::busy_owner_loss_fixture",
                "--ignored",
                "--nocapture",
            ])
            .env("SPEECH_KIT_ASR_EOF_TEST_MARKER", &marker)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        while !marker.is_file() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        if !marker.is_file() {
            let _ = child.kill();
            let _ = child.wait();
            panic!("EOF fixture did not become ready");
        }
        drop(child.stdin.take());
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert!(status.success());
                break;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("busy ownerless helper did not exit within two seconds");
            }
            thread::sleep(Duration::from_millis(10));
        }
        let _ = std::fs::remove_file(marker);
    }
}
