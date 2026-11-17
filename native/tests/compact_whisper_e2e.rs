#![cfg(feature = "engine-whisper")]

mod common;

use std::path::PathBuf;
use std::time::{Duration, Instant};

use local_dictation_sidecar::adapters::whisper::WhisperAdapter;
use local_dictation_sidecar::app::AppState;
use local_dictation_sidecar::catalog::ModelCatalog;
use local_dictation_sidecar::engine::traits::ModelFamilyAdapter;
use local_dictation_sidecar::engine::{ModelFamilyId, RuntimeId};
use local_dictation_sidecar::protocol::{
    AccelerationPreference, AudioFrame, Command, Event, ListeningMode, ModelInstallState,
    SelectedModel,
};
use local_dictation_sidecar::session::SpeakingStyle;
use local_dictation_sidecar::transcription::{GpuConfig, TranscriptionRequest};
use sha2::{Digest, Sha256};

const MODEL_ID: &str = "whisper_small_q5_1";

#[test]
fn natural_long_german_fixtures_are_pinned_16khz_pcm() {
    let manifest: serde_json::Value = serde_json::from_slice(
        &std::fs::read(common::fixtures_dir().join("long-german.json")).unwrap(),
    )
    .unwrap();
    for fixture in manifest["fixtures"].as_array().unwrap() {
        let path = common::fixtures_dir().join(fixture["audioPath"].as_str().unwrap());
        let bytes = std::fs::read(&path).unwrap();
        let hash = Sha256::digest(&bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        assert_eq!(hash, fixture["sha256"].as_str().unwrap());
        assert!(
            !common::audio::decode_wav_16k_mono(&path)
                .unwrap()
                .is_empty()
        );
    }
}

struct TestStore(PathBuf);

impl Drop for TestStore {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn selection() -> SelectedModel {
    SelectedModel::CatalogModel {
        runtime_id: RuntimeId::WhisperCpp,
        family_id: ModelFamilyId::Whisper,
        model_id: MODEL_ID.to_string(),
    }
}

fn start_command(session: &str, language: &str, store: &std::path::Path) -> Command {
    Command::StartSession {
        acceleration_preference: AccelerationPreference::CpuOnly,
        detailed_timestamps_enabled: false,
        diarization_enabled: false,
        diarization_max_speakers: None,
        include_system_audio: false,
        file_audio_flow_control: false,
        language: language.to_string(),
        mode: ListeningMode::AlwaysOn,
        model_selection: selection(),
        model_store_path_override: Some(store.display().to_string()),
        session_start_unix_ms: 1_700_000_000_000,
        session_id: session.to_string(),
        speaking_style: SpeakingStyle::Balanced,
    }
}

fn collect_events(app: &mut AppState, events: Vec<Event>, output: &mut Vec<Event>) {
    for event in events {
        if let Event::ContextRequest { correlation_id, .. } = &event {
            let (_, more) = app.handle_command(Command::ContextResponse {
                correlation_id: *correlation_id,
                context: None,
            });
            collect_events(app, more, output);
        }
        output.push(event);
    }
}

fn run_session(
    app: &mut AppState,
    store: &std::path::Path,
    session: &str,
    language: &str,
    frames: &[Vec<u8>],
    cancel: bool,
) -> Vec<Event> {
    let (_, events) = app.handle_command(start_command(session, language, store));
    let mut output = Vec::new();
    collect_events(app, events, &mut output);
    for frame in frames {
        let events = app.handle_audio_frame(AudioFrame {
            session_id: session.to_string(),
            frame_bytes: frame.clone(),
        });
        collect_events(app, events, &mut output);
        let events = app.drain_pending_outputs();
        collect_events(app, events, &mut output);
    }
    let stop = if cancel {
        Command::CancelSession {
            session_id: session.to_string(),
        }
    } else {
        Command::StopSession {
            session_id: session.to_string(),
        }
    };
    let (_, events) = app.handle_command(stop);
    collect_events(app, events, &mut output);
    let deadline = Instant::now() + Duration::from_secs(60);
    while !output.iter().any(
        |event| matches!(event, Event::SessionStopped { session_id, .. } if session_id == session),
    ) {
        assert!(
            Instant::now() < deadline,
            "session {session} did not stop in 60s: {output:?}"
        );
        std::thread::sleep(Duration::from_millis(10));
        let events = app.drain_pending_outputs();
        collect_events(app, events, &mut output);
    }
    assert!(
        !output
            .iter()
            .any(|event| matches!(event, Event::Error { .. })),
        "session errors: {output:?}"
    );
    output
}

#[test]
#[ignore = "fresh managed install downloads the pinned 190 MB model"]
fn compact_whisper_managed_install_detects_transcribes_cancels_and_removes() {
    let root = std::env::temp_dir().join(format!(
        "speech-kit-compact-whisper-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let _store = TestStore(root.clone());
    let mut catalog = ModelCatalog::load_bundled().unwrap();
    // Optional local replay avoids repeatedly fetching the same public weights.
    // Artifact sizes, hashes and model probing still exercise production code.
    if let Ok(url) = std::env::var("STT_TEST_MODEL_DOWNLOAD_URL") {
        let model = catalog
            .models
            .iter_mut()
            .find(|model| model.model_id == MODEL_ID)
            .unwrap();
        model.artifacts[0].download_url = url;
    }
    let mut app = AppState::new("compact-whisper-e2e", catalog);
    let (_, mut events) = app.handle_command(Command::InstallModel {
        runtime_id: RuntimeId::WhisperCpp,
        family_id: ModelFamilyId::Whisper,
        install_id: "compact-whisper-install".to_string(),
        model_id: MODEL_ID.to_string(),
        artifact_ids: Vec::new(),
        model_store_path_override: Some(root.display().to_string()),
    });
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        for event in &events {
            assert!(
                !matches!(
                    event,
                    Event::Error { .. }
                        | Event::ModelInstallUpdate {
                            state: ModelInstallState::Failed | ModelInstallState::Cancelled,
                            ..
                        }
                ),
                "managed install failed: {event:?}"
            );
        }
        if events.iter().any(|event| {
            matches!(
                event,
                Event::ModelInstallUpdate {
                    state: ModelInstallState::Completed,
                    ..
                }
            )
        }) {
            break;
        }
        assert!(Instant::now() < deadline, "managed install exceeded 120s");
        std::thread::sleep(Duration::from_millis(10));
        events = app.drain_pending_outputs();
    }
    let (_, events) = app.handle_command(Command::ProbeModelSelection {
        model_selection: selection(),
        model_store_path_override: Some(root.display().to_string()),
        request_id: None,
    });
    assert!(
        events.iter().any(|event| matches!(
            event,
            Event::ModelProbeResult {
                available: true,
                installed: true,
                ..
            }
        )),
        "probe failed: {events:?}"
    );

    let audio = common::audio::decode_wav_16k_mono(
        &common::fixtures_dir().join("audio/de-fleurs-1577.wav"),
    )
    .unwrap();
    let frames = common::audio::fixture_frames_with_trailing_silence(&audio);
    for (session, language) in [("german-manual", "de"), ("german-auto", "auto")] {
        let events = run_session(&mut app, &root, session, language, &frames, false);
        let text = events
            .iter()
            .filter_map(|event| match event {
                Event::TranscriptReady {
                    text,
                    is_final: true,
                    ..
                } => Some(text.as_str()),
                _ => None,
            })
            .collect::<Vec<_>>()
            .join(" ");
        assert!(
            common::text::word_error_rate(
                "das erschien mir nicht sinnvoll es war ganz gewiss nicht fair",
                &text
            ) <= 0.45,
            "{language} output failed: {text}"
        );
        eprintln!("managed {language}: {text}");
    }
    let silence = run_session(
        &mut app,
        &root,
        "silence",
        "de",
        &vec![vec![0; 640]; 100],
        false,
    );
    assert!(
        !silence
            .iter()
            .any(|event| matches!(event, Event::TranscriptReady { text, .. } if !text.is_empty())),
        "silence produced speech"
    );
    let long_audio = common::audio::decode_wav_16k_mono(
        &common::fixtures_dir().join("audio/de-fleurs-1617.wav"),
    )
    .unwrap();
    let long_frames = common::audio::fixture_frames_with_trailing_silence(&long_audio);
    let long = run_session(
        &mut app,
        &root,
        "natural-long-german",
        "de",
        &long_frames,
        false,
    );
    let text = long
        .iter()
        .filter_map(|event| match event {
            Event::TranscriptReady {
                text,
                is_final: true,
                ..
            } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join(" ");
    assert!(
        common::text::word_error_rate(
            "der kruger nationalpark knp liegt im nordosten von südafrika. er grenzt im osten an mosambik im norden an simbabwe und im süden an den crocodile river",
            &text
        ) <= 0.45,
        "managed long German quality failed: {text}"
    );
    let _ = run_session(&mut app, &root, "cancelled", "de", &frames[..80], true);
    let (_, events) = app.handle_command(Command::RemoveModel {
        runtime_id: RuntimeId::WhisperCpp,
        family_id: ModelFamilyId::Whisper,
        model_id: MODEL_ID.to_string(),
        model_store_path_override: Some(root.display().to_string()),
    });
    assert!(
        events
            .iter()
            .any(|event| matches!(event, Event::ModelRemoved { removed: true, .. })),
        "model removal failed: {events:?}"
    );
}

#[test]
#[ignore = "requires STT_COMPARE_MODEL, a local multilingual Whisper file"]
fn compact_multilingual_whisper_quality_and_resources() {
    let model_path = PathBuf::from(std::env::var("STT_COMPARE_MODEL").unwrap());
    let gpu = GpuConfig { use_gpu: false };
    let started = Instant::now();
    let mut model = WhisperAdapter.load(&model_path, gpu).unwrap();
    let load_ms = started.elapsed().as_secs_f64() * 1_000.0;
    let manifest: serde_json::Value = serde_json::from_slice(
        &std::fs::read(common::fixtures_dir().join("multilingual.json")).unwrap(),
    )
    .unwrap();
    let mut fixtures: Vec<(String, PathBuf, String)> = manifest["fixtures"]
        .as_array()
        .unwrap()
        .iter()
        .map(|fixture| {
            (
                fixture["language"].as_str().unwrap().to_string(),
                common::fixtures_dir().join(fixture["audioPath"].as_str().unwrap()),
                fixture["reference"].as_str().unwrap().to_string(),
            )
        })
        .collect();
    let english = common::manifest::Corpus::load()
        .fixtures
        .into_iter()
        .find(|fixture| fixture.id == "7021-79740-0000")
        .unwrap();
    fixtures.insert(
        0,
        ("en".to_string(), english.audio_path(), english.reference),
    );
    let german = fixtures
        .iter()
        .find(|(language, _, _)| language == "de")
        .unwrap();
    fixtures.push(("de-auto".to_string(), german.1.clone(), german.2.clone()));
    let long_manifest: serde_json::Value = serde_json::from_slice(
        &std::fs::read(common::fixtures_dir().join("long-german.json")).unwrap(),
    )
    .unwrap();
    for fixture in long_manifest["fixtures"].as_array().unwrap() {
        fixtures.push((
            fixture["id"].as_str().unwrap().to_string(),
            common::fixtures_dir().join(fixture["audioPath"].as_str().unwrap()),
            fixture["reference"].as_str().unwrap().to_string(),
        ));
    }
    let mut failures = Vec::new();
    for (language, path, reference) in fixtures {
        let samples = common::audio::decode_wav_16k_mono(&path).unwrap();
        let audio_s = samples.len() as f64 / 16_000.0;
        let started = Instant::now();
        let output = model
            .transcribe(&TranscriptionRequest {
                audio_samples: samples
                    .iter()
                    .map(|sample| f32::from(*sample) / 32768.0)
                    .collect(),
                detailed_timestamps_enabled: false,
                gpu_config: gpu,
                language: if language == "de-auto" {
                    "auto".to_string()
                } else if language.starts_with("de-") {
                    "de".to_string()
                } else {
                    language.clone()
                },
                model_file_path: model_path.clone(),
                context: None,
            })
            .unwrap();
        let processing_ms = started.elapsed().as_secs_f64() * 1_000.0;
        if language == "de-auto" && output.detected_language.as_deref() != Some("de") {
            failures.push(format!(
                "German automatic detection returned {:?}",
                output.detected_language
            ));
        }
        let text = common::text::joined_text(&output);
        let scored_text = if language == "sr" {
            common::text::to_serbian_latin(&text)
        } else {
            text.clone()
        };
        let error_rate = if language == "ja" {
            common::text::character_error_rate(&reference, &text)
        } else {
            common::text::word_error_rate(&reference, &scored_text)
        };
        eprintln!(
            "{}",
            serde_json::json!({"language": language, "audioSeconds": audio_s, "loadMs": load_ms, "processingMs": processing_ms, "realTimeFactor": processing_ms / (audio_s * 1000.0), "errorRate": error_rate, "text": text})
        );
        if language == "sr" && common::text::serbian_cyrillic_share(&text) < 0.80 {
            failures.push(
                "sr: output did not preserve the established Cyrillic script contract".to_string(),
            );
        }
        let max_error = if language == "en" { 0.20 } else { 0.45 };
        if error_rate > max_error {
            failures.push(format!(
                "{language}: error rate {error_rate} exceeds {max_error}"
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "multilingual model quality failures: {failures:?}"
    );
}

#[test]
#[ignore = "diagnostic: known repeated-audio failure on Small and installed Turbo; requires STT_COMPARE_MODEL"]
fn compact_whisper_repeated_audio_stress() {
    let model_path = PathBuf::from(std::env::var("STT_COMPARE_MODEL").unwrap());
    let gpu = GpuConfig { use_gpu: false };
    let mut model = WhisperAdapter.load(&model_path, gpu).unwrap();
    let fixture = common::fixtures_dir().join("audio/de-fleurs-1577.wav");
    let long_samples = common::audio::decode_wav_16k_mono(&fixture)
        .unwrap()
        .repeat(6);
    let long_started = Instant::now();
    let long_output = model
        .transcribe(&TranscriptionRequest {
            audio_samples: long_samples
                .iter()
                .map(|sample| f32::from(*sample) / 32768.0)
                .collect(),
            detailed_timestamps_enabled: false,
            gpu_config: gpu,
            language: "de".to_string(),
            model_file_path: model_path.clone(),
            context: None,
        })
        .unwrap();
    let text = common::text::joined_text(&long_output);
    let error_rate = common::text::word_error_rate(
        &["das erschien mir nicht sinnvoll es war ganz gewiss nicht fair"; 6].join(" "),
        &text,
    );
    let processing_ms = long_started.elapsed().as_secs_f64() * 1_000.0;
    eprintln!(
        "{}",
        serde_json::json!({"language": "de-long-repeated", "audioSeconds": 32.4, "processingMs": processing_ms, "realTimeFactor": processing_ms / 32400.0, "errorRate": error_rate, "text": text})
    );
    assert!(
        error_rate <= 0.45,
        "known repeated-audio stress failed: {error_rate}; output: {text}"
    );
}
