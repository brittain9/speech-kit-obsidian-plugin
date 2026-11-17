mod common;
use local_dictation_sidecar::engine::registry::EngineRegistry;

#[test]
fn parakeet_tdt_is_a_distinct_batch_family() {
    let registry = EngineRegistry::build();
    let adapter = registry
        .adapters()
        .find(|adapter| adapter.family_id().as_str() == "parakeet_tdt")
        .expect("Parakeet TDT needs a registered adapter, distinct from English streaming Unified");
    let capabilities = adapter.capabilities();
    assert!(!capabilities.supports_streaming);
    assert!(capabilities.supports_word_timestamps);
    assert!(capabilities.supports_automatic_language_detection);
}

#[test]
#[ignore = "requires the pinned local TDT artifact set"]
fn local_model_decodes_german_with_bounded_word_timing() {
    use local_dictation_sidecar::engine::{ModelFamilyId, RuntimeId};
    use local_dictation_sidecar::transcription::{GpuConfig, TranscriptionRequest};
    let family: ModelFamilyId =
        serde_json::from_str("\"parakeet_tdt\"").expect("distinct TDT family");
    let registry = EngineRegistry::build();
    let adapter = registry
        .adapter(RuntimeId::OnnxRuntime, family)
        .expect("TDT adapter");
    let model_path = PathBuf::from(
        std::env::var("STT_COMPARE_MODEL").expect("set STT_COMPARE_MODEL to the pinned encoder"),
    );
    let root = model_path.as_path();
    let mut model = adapter.load(root, GpuConfig { use_gpu: false }).unwrap();
    let mut wav = hound::WavReader::open(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/audio/de-fleurs-1577.wav"
    ))
    .unwrap();
    let samples: Vec<i16> = wav.samples().map(Result::unwrap).collect();
    let output = model
        .transcribe(&TranscriptionRequest {
            audio_samples: samples.iter().map(|&s| s as f32 / 32768.0).collect(),
            language: "de".into(),
            context: None,
            detailed_timestamps_enabled: true,
            gpu_config: GpuConfig { use_gpu: false },
            model_file_path: root.into(),
        })
        .unwrap();
    let text = output
        .segments
        .iter()
        .map(|s| s.text.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    assert!(
        common::text::word_error_rate(
            "das erschien mir nicht sinnvoll es war ganz gewiss nicht fair",
            &text
        ) <= 0.45,
        "{text}"
    );
    let mut end = 0;
    for word in output.segments.iter().flat_map(|s| &s.words) {
        assert!(word.start_ms >= end);
        assert!(word.end_ms >= word.start_ms);
        assert!(word.end_ms <= samples.len() as u64 * 1_000 / 16_000);
        end = word.end_ms;
    }
    assert!(end > 0, "model must return actual word timing");
}

use local_dictation_sidecar::engine::traits::ModelFamilyAdapter;
use local_dictation_sidecar::transcription::{GpuConfig, TranscriptionRequest};
use std::path::PathBuf;
use std::time::Instant;
#[test]
#[ignore = "diagnostic: pinned int8 export fails natural-long German; requires STT_COMPARE_MODEL"]
fn parakeet_tdt_quality_and_latency() {
    let model_path = PathBuf::from(std::env::var("STT_COMPARE_MODEL").unwrap());
    let gpu = GpuConfig { use_gpu: false };
    let started = Instant::now();
    let mut model = local_dictation_sidecar::adapters::parakeet_tdt::ParakeetTdtAdapter
        .load(&model_path, gpu)
        .unwrap();
    let load_ms = started.elapsed().as_secs_f64() * 1_000.0;
    let manifest: serde_json::Value = serde_json::from_slice(
        &std::fs::read(common::fixtures_dir().join("multilingual.json")).unwrap(),
    )
    .unwrap();
    let mut fixtures: Vec<(String, PathBuf, String)> = manifest["fixtures"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|fixture| !["ja", "sr"].contains(&fixture["language"].as_str().unwrap()))
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
                detailed_timestamps_enabled: true,
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
        if output.detected_language.is_some() {
            failures.push(format!(
                "model without language-ID output unexpectedly returned {:?}",
                output.detected_language
            ));
        }
        let text = common::text::joined_text(&output);
        let error_rate = common::text::word_error_rate(&reference, &text);
        eprintln!(
            "{}",
            serde_json::json!({"language": language, "audioSeconds": audio_s, "loadMs": load_ms, "processingMs": processing_ms, "realTimeFactor": processing_ms / (audio_s * 1000.0), "errorRate": error_rate, "text": text})
        );
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

use local_dictation_sidecar::app::AppState;
use local_dictation_sidecar::catalog::ModelCatalog;
use local_dictation_sidecar::engine::{ModelFamilyId, RuntimeId};
use local_dictation_sidecar::protocol::{
    AccelerationPreference, AudioFrame, Command, Event, ListeningMode, SelectedModel,
};
use local_dictation_sidecar::session::SpeakingStyle;
use std::time::Duration;
fn start_command(session: &str, language: &str, store: &std::path::Path) -> Command {
    Command::StartSession {
        acceleration_preference: AccelerationPreference::CpuOnly,
        detailed_timestamps_enabled: true,
        diarization_enabled: false,
        diarization_max_speakers: None,
        include_system_audio: false,
        file_audio_flow_control: false,
        language: language.to_string(),
        mode: ListeningMode::AlwaysOn,
        model_selection: SelectedModel::ExternalFile {
            runtime_id: RuntimeId::OnnxRuntime,
            family_id: ModelFamilyId::ParakeetTdt,
            file_path: store.display().to_string(),
        },
        model_store_path_override: None,
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
#[ignore = "diagnostic: pinned export fails natural-long native VAD sessions; requires STT_COMPARE_MODEL"]
fn external_tdt_natural_long_sessions() {
    let model = PathBuf::from(std::env::var("STT_COMPARE_MODEL").unwrap());
    let mut app = AppState::new("tdt-experiment", ModelCatalog::load_bundled().unwrap());
    let manifest: serde_json::Value = serde_json::from_slice(
        &std::fs::read(common::fixtures_dir().join("long-german.json")).unwrap(),
    )
    .unwrap();
    let mut failures = Vec::new();
    for fixture in manifest["fixtures"].as_array().unwrap() {
        let audio = common::audio::decode_wav_16k_mono(
            &common::fixtures_dir().join(fixture["audioPath"].as_str().unwrap()),
        )
        .unwrap();
        let events = run_session(
            &mut app,
            &model,
            fixture["id"].as_str().unwrap(),
            "de",
            &common::audio::fixture_frames_with_trailing_silence(&audio),
            false,
        );
        let texts: Vec<_> = events
            .iter()
            .filter_map(|event| match event {
                Event::TranscriptReady {
                    text,
                    is_final: true,
                    ..
                } => Some(text.as_str()),
                _ => None,
            })
            .collect();
        let text = texts.join(" ");
        let error = common::text::word_error_rate(fixture["reference"].as_str().unwrap(), &text);
        eprintln!(
            "{}",
            serde_json::json!({"case":fixture["id"],"path":"native-vad","finals":texts.len(),"errorRate":error,"text":text})
        );
        if error > 0.45 {
            failures.push(format!("{} WER={error}", fixture["id"]));
        }
    }
    assert!(
        failures.is_empty(),
        "actual segmented quality failures: {failures:?}"
    );
}
