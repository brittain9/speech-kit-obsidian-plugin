//! The same repository-owned corpus is consumed by the production TS codec.
use std::io::{self, Cursor, Read};

use local_dictation_sidecar::protocol::{
    Event, IncomingFrame, encode_audio_frame_envelope, is_fatal_frame_error, read_frame,
    write_event_frame, write_json_frame, write_synthesis_audio_frame,
};
use serde::Deserialize;
use serde_json::Value;

#[derive(Deserialize)]
struct Corpus {
    version: u32,
    commands: Vec<CommandCase>,
    events: Vec<EventCase>,
    frames: Vec<FrameCase>,
}

#[derive(Deserialize)]
struct CommandCase {
    id: String,
    accepted: bool,
    wire: Value,
    canonical: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventCase {
    id: String,
    rust_accepted: bool,
    wire: Value,
    canonical: Option<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FrameCase {
    id: String,
    hex: String,
    rust: String,
    fatal: Option<bool>,
    json: Option<Value>,
    session_id: Option<String>,
    pcm_byte: Option<u8>,
    pcm_length: Option<usize>,
    synthesis_id: Option<u32>,
    sequence: Option<u32>,
    pcm_hex: Option<String>,
}

fn corpus() -> Corpus {
    let corpus: Corpus = serde_json::from_str(include_str!(
        "../../test/fixtures/sidecar-wire-contract.json"
    ))
    .expect("shared wire corpus should deserialize");
    assert_eq!(corpus.version, 1);
    corpus
}

fn bytes(hex: &str) -> Vec<u8> {
    assert!(hex.len().is_multiple_of(2));
    (0..hex.len())
        .step_by(2)
        .map(|offset| u8::from_str_radix(&hex[offset..offset + 2], 16).unwrap())
        .collect()
}

#[test]
fn shared_command_shapes_and_defaults() {
    for fixture in corpus().commands {
        let mut framed = Vec::new();
        write_json_frame(&mut framed, &fixture.wire).unwrap();
        let result = read_frame(&mut Cursor::new(framed));
        if !fixture.accepted {
            assert!(result.is_err(), "{} should be rejected", fixture.id);
            continue;
        }
        let Some(IncomingFrame::Command(command)) = result.unwrap() else {
            panic!("{} should decode to a command", fixture.id);
        };
        assert_eq!(
            serde_json::to_value(command).unwrap(),
            fixture.canonical.unwrap(),
            "{} command shape/defaults changed",
            fixture.id,
        );
    }
}

#[test]
fn shared_server_event_shapes() {
    for fixture in corpus().events {
        let parsed = serde_json::from_value::<Event>(fixture.wire.clone());
        if !fixture.rust_accepted {
            assert!(parsed.is_err(), "{} should be rejected", fixture.id);
            continue;
        }
        let mut framed = Vec::new();
        write_event_frame(&mut framed, &parsed.unwrap()).unwrap();
        assert_eq!(framed[0], 1, "{} event frame kind", fixture.id);
        let length = u32::from_le_bytes(framed[1..5].try_into().unwrap()) as usize;
        assert_eq!(
            length,
            framed.len() - 5,
            "{} event frame length",
            fixture.id
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&framed[5..]).unwrap(),
            fixture.canonical.unwrap_or(fixture.wire),
            "{} server event shape changed",
            fixture.id,
        );
    }
}

struct Fragmented<'a> {
    remaining: &'a [u8],
    max_chunk: usize,
}

impl Read for Fragmented<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        let length = buffer.len().min(self.remaining.len()).min(self.max_chunk);
        buffer[..length].copy_from_slice(&self.remaining[..length]);
        self.remaining = &self.remaining[length..];
        Ok(length)
    }
}

#[test]
fn shared_frames_reject_malformed_input_and_accept_fragmented_reads() {
    for fixture in corpus().frames {
        let framed = bytes(&fixture.hex);
        for max_chunk in [1, 3, 64, 4096] {
            let result = read_frame(&mut Fragmented {
                remaining: &framed,
                max_chunk,
            });
            if fixture.rust == "rejected" {
                let error = result.expect_err(&fixture.id);
                if let Some(fatal) = fixture.fatal {
                    assert_eq!(is_fatal_frame_error(&error), fatal, "{}", fixture.id);
                }
                continue;
            }
            match result.unwrap().expect(&fixture.id) {
                IncomingFrame::Command(command) => assert_eq!(
                    serde_json::to_value(command).unwrap(),
                    fixture.json.clone().unwrap(),
                    "{}",
                    fixture.id,
                ),
                IncomingFrame::Audio(audio) => {
                    assert_eq!(audio.session_id, fixture.session_id.clone().unwrap());
                    assert_eq!(
                        audio.frame_bytes,
                        vec![fixture.pcm_byte.unwrap(); fixture.pcm_length.unwrap()],
                    );
                }
            }
        }
    }
}

#[test]
fn shared_binary_encodings_match_independent_bytes() {
    for fixture in corpus().frames {
        let expected = bytes(&fixture.hex);
        if fixture.id == "microphone-audio" {
            let envelope = encode_audio_frame_envelope(
                fixture.session_id.as_deref().unwrap(),
                &vec![fixture.pcm_byte.unwrap(); fixture.pcm_length.unwrap()],
            )
            .unwrap();
            assert_eq!(expected[0], 2);
            assert_eq!(envelope, expected[5..]);
        } else if fixture.id == "synthesis-audio" {
            let mut encoded = Vec::new();
            write_synthesis_audio_frame(
                &mut encoded,
                fixture.synthesis_id.unwrap(),
                fixture.sequence.unwrap(),
                &bytes(fixture.pcm_hex.as_deref().unwrap()),
            )
            .unwrap();
            assert_eq!(encoded, expected);
        } else if fixture.id == "odd-synthesis-pcm" {
            let error = write_synthesis_audio_frame(
                &mut Vec::new(),
                fixture.synthesis_id.unwrap(),
                fixture.sequence.unwrap(),
                &bytes(fixture.pcm_hex.as_deref().unwrap()),
            )
            .unwrap_err();
            assert!(error.to_string().contains("even"));
        }
    }
}

#[test]
fn shared_commands_and_audio_can_arrive_in_one_read() {
    let frames = corpus()
        .frames
        .into_iter()
        .filter(|fixture| fixture.rust == "accepted")
        .collect::<Vec<_>>();
    let combined = frames
        .iter()
        .flat_map(|fixture| bytes(&fixture.hex))
        .collect::<Vec<_>>();
    let mut reader = Cursor::new(combined);
    for fixture in frames {
        match read_frame(&mut reader).unwrap().expect(&fixture.id) {
            IncomingFrame::Command(command) => {
                assert_eq!(
                    serde_json::to_value(command).unwrap(),
                    fixture.json.unwrap()
                );
            }
            IncomingFrame::Audio(audio) => {
                assert_eq!(audio.session_id, fixture.session_id.unwrap());
                assert_eq!(
                    audio.frame_bytes,
                    vec![fixture.pcm_byte.unwrap(); fixture.pcm_length.unwrap()],
                );
            }
        }
    }
    assert!(read_frame(&mut reader).unwrap().is_none());
}
