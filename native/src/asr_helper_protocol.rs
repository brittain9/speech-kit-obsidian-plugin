use serde::{Deserialize, Serialize};
use std::io::{self, Read, Write};
use std::path::PathBuf;

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_AUDIO_SAMPLES: usize = 35 * 16_000;

#[derive(Debug, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AsrCommand {
    Load {
        model_path: PathBuf,
        use_gpu: bool,
    },
    Transcribe {
        request_id: u64,
        audio_samples: Vec<f32>,
        language: String,
    },
    Shutdown,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum AsrEvent {
    Ready {
        version: String,
        protocol_version: u32,
    },
    Loaded,
    Transcript {
        request_id: u64,
        text: String,
        detected_language: Option<String>,
    },
    Error {
        code: String,
    },
}

pub fn write_frame<W: Write, T: Serialize>(writer: &mut W, value: &T) -> io::Result<()> {
    let payload =
        serde_json::to_vec(value).map_err(|_| io::Error::other("invalid ASR helper message"))?;
    if payload.len() > MAX_FRAME_BYTES {
        return Err(io::Error::other("ASR helper payload exceeds limit"));
    }
    writer.write_all(&[1])?;
    writer.write_all(&(payload.len() as u32).to_le_bytes())?;
    writer.write_all(&payload)?;
    writer.flush()
}

pub fn read_frame<R: Read, T: for<'de> Deserialize<'de>>(reader: &mut R) -> io::Result<Option<T>> {
    let mut header = [0; 5];
    if reader.read(&mut header[..1])? == 0 {
        return Ok(None);
    }
    reader.read_exact(&mut header[1..])?;
    let len = u32::from_le_bytes(header[1..].try_into().unwrap()) as usize;
    if header[0] != 1 || len > MAX_FRAME_BYTES {
        return Err(io::Error::other("invalid ASR helper frame"));
    }
    let mut payload = vec![0; len];
    reader.read_exact(&mut payload)?;
    serde_json::from_slice(&payload)
        .map(Some)
        .map_err(|_| io::Error::other("invalid ASR helper message"))
}

pub fn language_name(tag: &str) -> Option<&'static str> {
    match tag {
        "en" => Some("English"),
        "es" => Some("Spanish"),
        "de" => Some("German"),
        "fr" => Some("French"),
        "pt" => Some("Portuguese"),
        "it" => Some("Italian"),
        "nl" => Some("Dutch"),
        "ja" => Some("Japanese"),
        _ => None,
    }
}

pub fn language_tag(name: &str) -> Option<&'static str> {
    ["en", "es", "de", "fr", "pt", "it", "nl", "ja"]
        .into_iter()
        .find(|tag| language_name(tag).is_some_and(|value| value.eq_ignore_ascii_case(name.trim())))
}

pub fn parse_output(
    raw: &str,
    forced_language: &str,
) -> Result<(String, Option<String>), &'static str> {
    let raw = raw.trim();
    let (text, language) = if let Some((meta, text)) = raw.split_once("<asr_text>") {
        let name = meta.trim().strip_prefix("language ").unwrap_or("").trim();
        (text.trim(), language_tag(name).map(str::to_owned))
    } else if raw.starts_with("language ") && forced_language == "auto" {
        return Err("incomplete ASR language metadata");
    } else {
        (raw, None)
    };
    if text.contains("<|") || text.contains("<asr_text>") {
        return Err("unexpected ASR control token in transcript");
    }
    Ok((
        text.to_owned(),
        if forced_language == "auto" {
            language
        } else {
            None
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn frame_caps_reject_before_payload_allocation_and_reject_truncated_headers() {
        let mut bytes = vec![1];
        bytes.extend_from_slice(&((MAX_FRAME_BYTES + 1) as u32).to_le_bytes());
        assert!(read_frame::<_, AsrEvent>(&mut bytes.as_slice()).is_err());
        assert!(read_frame::<_, AsrEvent>(&mut [1, 2].as_slice()).is_err());
        assert!(
            read_frame::<_, AsrEvent>(&mut [].as_slice())
                .unwrap()
                .is_none()
        );
    }
    #[test]
    fn model_metadata_is_removed_without_repetition_or_text_loss() {
        assert_eq!(
            parse_output("language German<asr_text>Hallo. Hallo. Hallo.", "auto").unwrap(),
            ("Hallo. Hallo. Hallo.".into(), Some("de".into()))
        );
        assert_eq!(
            parse_output("language None<asr_text>", "auto").unwrap(),
            (String::new(), None)
        );
        assert_eq!(parse_output("Hallo", "de").unwrap(), ("Hallo".into(), None));
        assert!(parse_output("language German", "auto").is_err());
        assert!(parse_output("<|audio_start|>hello", "auto").is_err());
        assert!(language_name("hr").is_none());
        assert!(language_name("sr").is_none());
    }
}
