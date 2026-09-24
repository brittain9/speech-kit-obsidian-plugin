use std::io::{self, Write};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use anyhow::{Context, Result};
use local_dictation_sidecar::app::{AppState, ControlFlow};
use local_dictation_sidecar::catalog::ModelCatalog;
use local_dictation_sidecar::protocol::{
    AudioFrame, Command, Event, IncomingFrame, is_fatal_frame_error,
    is_outbound_frame_payload_too_large, read_frame, write_event_frame,
    write_synthesis_audio_frame,
};
#[cfg(feature = "engine-whisper")]
use whisper_rs::install_logging_hooks;

enum InputMessage {
    Eof,
    Frame(IncomingFrame),
    ProtocolError { details: String, fatal: bool },
    SystemAudio(AudioFrame),
    SystemAudioProbeResult(Box<Event>),
}

fn main() -> Result<()> {
    #[cfg(feature = "engine-whisper")]
    install_logging_hooks();

    let catalog = ModelCatalog::load_bundled()?;
    run_stdio(catalog, env!("CARGO_PKG_VERSION").to_string())
}

fn run_stdio(catalog: ModelCatalog, sidecar_version: String) -> Result<()> {
    let stdout = io::stdout();
    let mut writer = io::BufWriter::new(stdout.lock());
    let (input_tx, input_rx) = mpsc::channel();
    spawn_input_reader(input_tx.clone());
    let mut app_state = AppState::new(sidecar_version, catalog);

    // Native system-audio capture produces frames on its own threads; route them
    // into the same channel the stdin reader feeds, so they flow through the
    // identical command/audio dispatch path. `Sender` is `!Sync`, so a `Mutex`
    // makes the sink satisfy the `Send + Sync` bound.
    let sink_tx = Mutex::new(input_tx.clone());
    app_state.set_system_audio_sink(Arc::new(move |frame| {
        if let Ok(tx) = sink_tx.lock() {
            let _ = tx.send(InputMessage::SystemAudio(frame));
        }
    }));

    loop {
        write_events(&mut writer, app_state.drain_pending_outputs())?;

        match input_rx.recv_timeout(Duration::from_millis(10)) {
            Ok(InputMessage::Frame(frame)) => {
                let (control_flow, events) = match frame {
                    IncomingFrame::Audio(audio_frame) => (
                        ControlFlow::Continue,
                        app_state.handle_audio_frame(audio_frame),
                    ),
                    IncomingFrame::Command(Command::ProbeSystemAudio) => {
                        spawn_system_audio_probe(input_tx.clone());
                        (ControlFlow::Continue, Vec::new())
                    }
                    IncomingFrame::Command(command) => app_state.handle_command(command),
                };

                write_events(&mut writer, events)?;

                if control_flow == ControlFlow::Shutdown {
                    break;
                }
            }
            Ok(InputMessage::SystemAudio(audio_frame)) => {
                write_events(
                    &mut writer,
                    app_state.handle_system_audio_frame(audio_frame),
                )?;
            }
            Ok(InputMessage::SystemAudioProbeResult(event)) => {
                write_events(&mut writer, vec![*event])?;
            }
            Ok(InputMessage::ProtocolError { details, fatal }) => {
                write_events(
                    &mut writer,
                    vec![Event::Error {
                        code: "invalid_frame".to_string(),
                        details: Some(details),
                        message: "Failed to parse an incoming protocol frame.".to_string(),
                        session_id: None,
                    }],
                )?;
                if fatal {
                    break;
                }
            }
            Ok(InputMessage::Eof) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    Ok(())
}

fn spawn_input_reader(tx: Sender<InputMessage>) {
    thread::spawn(move || {
        let stdin = io::stdin();
        let mut reader = stdin.lock();

        read_inputs(&mut reader, &tx);
    });
}

fn read_inputs(reader: &mut impl io::Read, tx: &Sender<InputMessage>) {
    loop {
        match read_frame(reader) {
            Ok(Some(frame)) => {
                if tx.send(InputMessage::Frame(frame)).is_err() {
                    break;
                }
            }
            Ok(None) => {
                let _ = tx.send(InputMessage::Eof);
                break;
            }
            Err(error) => {
                let fatal = is_fatal_frame_error(&error);
                if tx
                    .send(InputMessage::ProtocolError {
                        details: format!("{error:#}"),
                        fatal,
                    })
                    .is_err()
                {
                    break;
                }
                if fatal {
                    break;
                }
            }
        }
    }
}

fn spawn_system_audio_probe(tx: Sender<InputMessage>) {
    thread::spawn(move || {
        let event = match local_dictation_sidecar::system_audio::probe_system_audio() {
            Ok(()) => Event::SystemAudioProbeResult {
                ok: true,
                code: None,
                message: None,
            },
            Err(error) => Event::SystemAudioProbeResult {
                ok: false,
                code: Some(error.code().to_string()),
                message: Some(error.message()),
            },
        };

        let _ = tx.send(InputMessage::SystemAudioProbeResult(Box::new(event)));
    });
}

fn write_events(writer: &mut impl Write, events: Vec<Event>) -> Result<()> {
    for event in events {
        let result = match &event {
            Event::SynthesisAudio {
                synthesis_id,
                seq,
                pcm16le,
            } => write_synthesis_audio_frame(writer, *synthesis_id, *seq, pcm16le)
                .context("failed to write synthesis audio frame"),
            event => write_event_frame(writer, event).context("failed to write event frame"),
        };
        if let Err(error) = result {
            if !is_outbound_frame_payload_too_large(&error) {
                return Err(error);
            }
            // Only a pre-write payload-cap failure is replaced. Serialization
            // and writer I/O failures propagate, and a partial frame is never
            // followed by an unrelated fallback frame.
            let fallback = Event::Error {
                code: "event_frame_too_large".to_string(),
                details: Some(format!("{error:#}")),
                message: "A sidecar event exceeded the frame payload limit.".to_string(),
                session_id: None,
            };
            write_event_frame(writer, &fallback)
                .context("failed to write frame-size error event")?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::io::{self, Cursor, Write};
    use std::sync::mpsc;

    use super::{InputMessage, read_inputs, write_events};
    use local_dictation_sidecar::protocol::{
        Event, HealthStatus, MAX_FRAME_PAYLOAD, read_json_frame,
    };

    #[test]
    fn oversized_frame_terminates_the_reader_without_parsing_payload_bytes() {
        let mut input = Vec::new();
        input.push(0x01);
        input.extend_from_slice(&((16 * 1024 * 1024 + 1) as u32).to_le_bytes());
        input.extend_from_slice(&[0x01, 0x02, 0x03, 0x04, 0x05]);
        input.extend_from_slice(br#"{"type":"health"}"#);
        let (tx, rx) = mpsc::channel();

        read_inputs(&mut Cursor::new(input), &tx);
        drop(tx);

        let messages = rx.into_iter().collect::<Vec<_>>();
        assert_eq!(messages.len(), 1, "payload bytes must not be reparsed");
        assert!(matches!(
            &messages[0],
            InputMessage::ProtocolError {
                details,
                fatal: true,
            } if details.contains("frame payload exceeds maximum supported size")
        ));
    }

    struct PartialWriter {
        output: Vec<u8>,
        writes: usize,
    }

    impl Write for PartialWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.writes += 1;
            if self.writes == 2 {
                return Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "simulated pipe failure",
                ));
            }
            self.output.extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn ordinary_partial_write_errors_propagate_without_fallback() {
        let mut writer = PartialWriter {
            output: Vec::new(),
            writes: 0,
        };
        let error = write_events(
            &mut writer,
            vec![Event::HealthOk {
                sidecar_version: "test".to_string(),
                status: HealthStatus::Ready,
            }],
        )
        .expect_err("writer failure should propagate");
        assert!(format!("{error:#}").contains("simulated pipe failure"));
        assert_eq!(writer.output.len(), 5);
    }

    #[test]
    fn ordinary_synthesis_write_errors_propagate_without_fallback() {
        let mut writer = PartialWriter {
            output: Vec::new(),
            writes: 0,
        };
        let error = write_events(
            &mut writer,
            vec![Event::SynthesisAudio {
                pcm16le: vec![0, 0],
                seq: 0,
                synthesis_id: 7,
            }],
        )
        .expect_err("synthesis writer failure should propagate");
        assert!(format!("{error:#}").contains("simulated pipe failure"));
        assert_eq!(writer.output.len(), 5);
    }

    #[test]
    fn oversized_synthesis_audio_is_replaced_before_any_frame_write() {
        let mut output = Vec::new();
        write_events(
            &mut output,
            vec![Event::SynthesisAudio {
                pcm16le: vec![0; MAX_FRAME_PAYLOAD + 2],
                seq: 0,
                synthesis_id: 7,
            }],
        )
        .expect("pre-write synthesis cap should use the typed fallback");
        let fallback: Event = read_json_frame(&mut output.as_slice())
            .expect("fallback frame should parse")
            .expect("fallback frame should exist");
        assert!(matches!(
            fallback,
            Event::Error { ref code, .. } if code == "event_frame_too_large"
        ));
    }

    #[test]
    fn oversized_events_are_replaced_by_a_typed_error_frame() {
        let code = "oversized".to_string();
        let event = Event::Error {
            code,
            details: None,
            message: "x".repeat(MAX_FRAME_PAYLOAD),
            session_id: None,
        };
        let mut output = Vec::new();
        write_events(&mut output, vec![event]).expect("fallback event should write");
        let fallback: Event = read_json_frame(&mut output.as_slice())
            .expect("fallback frame should parse")
            .expect("fallback frame should exist");
        assert!(matches!(
            fallback,
            Event::Error { ref code, .. } if code == "event_frame_too_large"
        ));
    }
}
