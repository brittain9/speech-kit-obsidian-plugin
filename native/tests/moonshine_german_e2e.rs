#![cfg(feature = "engine-moonshine")]

mod common;

use std::path::PathBuf;
use std::time::{Duration, Instant};

use local_dictation_sidecar::adapters::moonshine::MoonshineAdapter;
use local_dictation_sidecar::app::AppState;
use local_dictation_sidecar::catalog::ModelCatalog;
use local_dictation_sidecar::engine::capabilities::LanguageSupport;
use local_dictation_sidecar::engine::traits::ModelFamilyAdapter;
use local_dictation_sidecar::engine::{ModelFamilyId, RuntimeId};
use local_dictation_sidecar::protocol::{
    AccelerationPreference, AudioFrame, Command, Event, ListeningMode, ModelInstallState,
    ModelProbeStatus, SelectedModel,
};
use local_dictation_sidecar::session::SpeakingStyle;
use local_dictation_sidecar::transcription::GpuConfig;

const MODEL_ID: &str = "moonshine_tiny_streaming_de";

struct TestStore(PathBuf);

impl Drop for TestStore {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn candidate_catalog() -> ModelCatalog {
    let mut catalog = ModelCatalog::load_bundled().unwrap();
    catalog.models.push(
        serde_json::from_str(include_str!(
            "fixtures/moonshine/german-tiny-experimental.json"
        ))
        .unwrap(),
    );
    catalog.validate().unwrap();
    catalog
}

fn selection() -> SelectedModel {
    SelectedModel::CatalogModel {
        runtime_id: RuntimeId::OnnxRuntime,
        family_id: ModelFamilyId::Moonshine,
        model_id: MODEL_ID.to_string(),
    }
}

fn external_start(session_id: &str, path: &std::path::Path) -> Command {
    Command::StartSession {
        acceleration_preference: AccelerationPreference::CpuOnly,
        detailed_timestamps_enabled: false,
        diarization_enabled: false,
        diarization_max_speakers: None,
        include_system_audio: false,
        file_audio_flow_control: false,
        language: "de".to_string(),
        mode: ListeningMode::AlwaysOn,
        model_selection: SelectedModel::ExternalFile {
            runtime_id: RuntimeId::OnnxRuntime,
            family_id: ModelFamilyId::Moonshine,
            file_path: path.display().to_string(),
        },
        model_store_path_override: None,
        session_start_unix_ms: 1_700_000_000_000,
        session_id: session_id.to_string(),
        speaking_style: SpeakingStyle::Patient,
    }
}

#[test]
#[ignore = "bounded local comparison; requires STT_COMPARE_FAMILY and STT_COMPARE_MODEL"]
fn german_streaming_resource_comparison() {
    let path = PathBuf::from(std::env::var("STT_COMPARE_MODEL").unwrap());
    let adapter: Box<dyn ModelFamilyAdapter> =
        match std::env::var("STT_COMPARE_FAMILY").unwrap().as_str() {
            "moonshine" => Box::new(MoonshineAdapter),
            #[cfg(feature = "engine-nemotron-asr")]
            "nemotron_asr" => {
                Box::new(local_dictation_sidecar::adapters::nemotron_asr::NemotronAsrAdapter)
            }
            _ => panic!("choose a compiled Moonshine or Nemotron adapter"),
        };
    let fixture =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/audio/de-fleurs-1577.wav");
    let audio = common::audio::decode_wav_16k_mono(&fixture).unwrap();
    let reference = "das erschien mir nicht sinnvoll es war ganz gewiss nicht fair";
    let load_start = Instant::now();
    let mut model = adapter
        .load_streaming(&path, GpuConfig { use_gpu: false })
        .unwrap();
    model.set_language("de").unwrap();
    let load_ms = load_start.elapsed().as_secs_f64() * 1_000.0;
    let long_repeats = std::env::var("STT_COMPARE_LONG_REPEATS")
        .ok()
        .map(|value| value.parse::<usize>().unwrap());
    for repeats in std::iter::once(1).chain(long_repeats) {
        let samples = audio.repeat(repeats);
        let expected = vec![reference; repeats].join(" ");
        let started = Instant::now();
        let mut first_partial_audio_ms = None;
        let mut first_partial_wall_ms = None;
        let mut accepted = 0;
        for chunk in samples.chunks(8_000) {
            model.accept_audio(chunk).unwrap();
            accepted += chunk.len();
            if !model.partial().unwrap().segments.is_empty() && first_partial_audio_ms.is_none() {
                first_partial_audio_ms = Some(accepted as f64 / 16.0);
                first_partial_wall_ms = Some(started.elapsed().as_secs_f64() * 1_000.0);
            }
        }
        let final_start = Instant::now();
        let output = model.finalize_utterance().unwrap();
        let final_ms = final_start.elapsed().as_secs_f64() * 1_000.0;
        let text = common::text::joined_text(&output);
        let audio_s = samples.len() as f64 / 16_000.0;
        let wer = common::text::word_error_rate(&expected, &text);
        let rtf = started.elapsed().as_secs_f64() / audio_s;
        eprintln!(
            "{}",
            serde_json::json!({"family": adapter.family_id().as_str(), "fixture": "de-fleurs-1577", "repeats": repeats, "audioSeconds": audio_s, "loadMs": load_ms, "firstPartialAudioMs": first_partial_audio_ms, "firstPartialComputeMs": first_partial_wall_ms, "finalizeMs": final_ms, "realTimeFactor": rtf, "wordErrorRate": wer})
        );
        assert!(first_partial_audio_ms.is_some() && !text.is_empty());
        assert!(
            rtf < 1.0,
            "candidate must sustain faster-than-real-time on the validation Mac"
        );
        assert!(
            wer <= 0.30,
            "public fixture regression exceeds the exploratory 30% WER floor: {wer}; output: {text}"
        );
    }
}

#[test]
#[ignore = "requires MOONSHINE_GERMAN_MODEL_PATH; 33s real-time patient-VAD long recording"]
fn german_patient_vad_long_recording_preserves_repeated_speech() {
    let path = PathBuf::from(std::env::var("MOONSHINE_GERMAN_MODEL_PATH").unwrap());
    let fixture =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/audio/de-fleurs-1577.wav");
    let audio = common::audio::decode_wav_16k_mono(&fixture)
        .unwrap()
        .repeat(6);
    let frames = common::audio::fixture_frames_with_trailing_silence(&audio);
    let outcome = common::driver::stream_in_process_language(
        SelectedModel::ExternalFile {
            runtime_id: RuntimeId::OnnxRuntime,
            family_id: ModelFamilyId::Moonshine,
            file_path: path.display().to_string(),
        },
        &frames,
        "de",
    );
    let expected = ["das erschien mir nicht sinnvoll es war ganz gewiss nicht fair"; 6].join(" ");
    let wer = common::text::word_error_rate(&expected, &outcome.final_texts.join(" "));
    eprintln!(
        "patient VAD long recording: WER={wer}, final utterances={:?}, errors={:?}",
        outcome.final_texts, outcome.errors
    );
    assert!(outcome.errors.is_empty() && outcome.stopped);
    assert!(
        wer <= 0.30,
        "long recording exceeded exploratory 30% WER floor: {wer}"
    );
}

#[test]
#[ignore = "requires MOONSHINE_GERMAN_MODEL_PATH pointing to the verified split frontend"]
fn german_worker_cancellation_allows_a_clean_silent_restart() {
    let path = PathBuf::from(std::env::var("MOONSHINE_GERMAN_MODEL_PATH").unwrap());
    let mut app = AppState::new(
        "moonshine-cancellation-e2e",
        ModelCatalog::load_bundled().unwrap(),
    );
    let (_, events) = app.handle_command(external_start("cancelled-german", &path));
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, Event::Error { .. })),
        "start failed: {events:?}"
    );
    let fixture =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/audio/de-fleurs-1577.wav");
    let audio = common::audio::decode_wav_16k_mono(&fixture).unwrap();
    for frame in common::audio::fixture_frames_with_trailing_silence(&audio)
        .into_iter()
        .take(100)
    {
        app.handle_audio_frame(AudioFrame {
            session_id: "cancelled-german".to_string(),
            frame_bytes: frame,
        });
    }
    let (_, mut events) = app.handle_command(Command::CancelSession {
        session_id: "cancelled-german".to_string(),
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    while !events.iter().any(|event| matches!(event, Event::SessionStopped { session_id, .. } if session_id == "cancelled-german")) {
        assert!(Instant::now() < deadline, "cancellation did not terminate the session");
        std::thread::sleep(Duration::from_millis(10));
        events.extend(app.drain_pending_outputs());
    }
    let (_, events) = app.handle_command(external_start("restarted-german", &path));
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, Event::Error { .. })),
        "restart failed: {events:?}"
    );
    for _ in 0..100 {
        app.handle_audio_frame(AudioFrame {
            session_id: "restarted-german".to_string(),
            frame_bytes: vec![0; 640],
        });
    }
    let (_, mut events) = app.handle_command(Command::StopSession {
        session_id: "restarted-german".to_string(),
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    while !events.iter().any(|event| matches!(event, Event::SessionStopped { session_id, .. } if session_id == "restarted-german")) {
        assert!(Instant::now() < deadline, "restarted session did not stop");
        std::thread::sleep(Duration::from_millis(10));
        events.extend(app.drain_pending_outputs());
    }
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, Event::Error { .. } | Event::TranscriptReady { .. })),
        "cancelled speech leaked or restart failed: {events:?}"
    );
}

#[test]
#[ignore = "downloads the 32 MB official model and tests the managed install/worker path"]
fn experimental_german_install_probe_and_worker_validation() {
    let root = std::env::temp_dir().join(format!(
        "speech-kit-moonshine-managed-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let _store = TestStore(root.clone());
    let mut app = AppState::new("moonshine-german-e2e", candidate_catalog());
    let (_, mut events) = app.handle_command(Command::InstallModel {
        runtime_id: RuntimeId::OnnxRuntime,
        family_id: ModelFamilyId::Moonshine,
        install_id: "german-install".to_string(),
        model_id: MODEL_ID.to_string(),
        artifact_ids: Vec::new(),
        model_store_path_override: Some(root.display().to_string()),
    });
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        for event in &events {
            assert!(
                !matches!(event, Event::Error { .. }),
                "managed install error: {event:?}"
            );
            if let Event::ModelInstallUpdate {
                state,
                message,
                details,
                ..
            } = event
            {
                assert!(
                    !matches!(
                        state,
                        ModelInstallState::Failed | ModelInstallState::Cancelled
                    ),
                    "managed install failed: {message:?}: {details:?}"
                );
                if *state == ModelInstallState::Completed {
                    break;
                }
            }
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
        "managed probe failed: {events:?}"
    );
    let resolved_path = events
        .iter()
        .find_map(|event| match event {
            Event::ModelProbeResult {
                available: true,
                resolved_path: Some(path),
                ..
            } => Some(path.clone()),
            _ => None,
        })
        .unwrap();
    let installed = SelectedModel::ExternalFile {
        runtime_id: RuntimeId::OnnxRuntime,
        family_id: ModelFamilyId::Moonshine,
        file_path: resolved_path,
    };
    drop(app);

    let fixture =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/audio/de-fleurs-1577.wav");
    let audio = common::audio::decode_wav_16k_mono(&fixture).unwrap();
    let frames = common::audio::fixture_frames_with_trailing_silence(&audio);
    let result = common::driver::stream_in_process_language(installed.clone(), &frames, "de");
    eprintln!("experimental German worker: {result:?}");
    assert!(
        result.errors.is_empty(),
        "worker errors: {:?}",
        result.errors
    );
    assert!(result.stopped && !result.partials.is_empty());
    assert!(
        result.final_text.to_lowercase().contains("sinnvoll")
            && result.final_text.to_lowercase().contains("fair")
    );

    let silence = vec![vec![0; 640]; 100];
    let silent = common::driver::stream_in_process_language(installed.clone(), &silence, "de");
    assert!(silent.errors.is_empty() && silent.stopped);
    assert!(
        silent.partials.is_empty() && silent.final_text.is_empty(),
        "VAD must suppress silence: {silent:?}"
    );
    let wrong_language = common::driver::stream_in_process_language(installed, &[], "en");
    assert!(
        wrong_language
            .errors
            .iter()
            .any(|error| error.contains("unsupported_language")),
        "German model accepted English selection: {wrong_language:?}"
    );
}

#[test]
#[ignore = "requires MOONSHINE_GERMAN_MODEL_PATH pointing to the verified split frontend"]
fn unrecognized_split_tokenizer_cannot_claim_german_support() {
    let source = PathBuf::from(std::env::var("MOONSHINE_GERMAN_MODEL_PATH").unwrap());
    let root = std::env::temp_dir().join(format!(
        "speech-kit-moonshine-tokenizer-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let _store = TestStore(root.clone());
    for filename in [
        "frontend.model.ort",
        "frontend.weights.ort",
        "encoder.ort",
        "adapter.ort",
        "cross_kv.ort",
        "decoder_kv.ort",
        "streaming_config.json",
        "tokenizer.bin",
    ] {
        std::fs::copy(source.parent().unwrap().join(filename), root.join(filename)).unwrap();
    }
    let path = root.join("tokenizer.bin");
    let mut bytes = std::fs::read(&path).unwrap();
    *bytes.last_mut().unwrap() ^= 1;
    std::fs::write(path, bytes).unwrap();
    let frontend = root.join("frontend.model.ort");
    let mut app = AppState::new(
        "moonshine-unverified-probe",
        ModelCatalog::load_bundled().unwrap(),
    );
    let (_, events) = app.handle_command(Command::ProbeModelSelection {
        model_selection: SelectedModel::ExternalFile {
            runtime_id: RuntimeId::OnnxRuntime,
            family_id: ModelFamilyId::Moonshine,
            file_path: frontend.display().to_string(),
        },
        model_store_path_override: None,
        request_id: None,
    });
    assert!(
        events.iter().any(|event| matches!(event,
            Event::ModelProbeResult {
                available: false,
                status: ModelProbeStatus::Invalid,
                details: Some(details),
                ..
            } if details.contains("Unverified Moonshine split export")
        )),
        "unverified split export was advertised as ready: {events:?}"
    );
    assert_eq!(
        MoonshineAdapter
            .probe_model_and_language_support(&frontend)
            .unwrap_err()
            .code,
        "invalid_model_file"
    );
    let mut start = external_start("unverified-english-fallback", &frontend);
    if let Command::StartSession { language, .. } = &mut start {
        *language = "en".to_string();
    }
    let (_, events) = app.handle_command(start);
    assert!(
        events.iter().any(|event| matches!(event,
            Event::Error { code, .. } if code == "invalid_model_file"
        )),
        "unverified split export was allowed to start: {events:?}"
    );
}

#[test]
#[ignore = "requires MOONSHINE_GERMAN_MODEL_PATH pointing to the verified split frontend"]
fn german_split_frontend_streams_finalizes_and_resets() {
    let path = PathBuf::from(std::env::var("MOONSHINE_GERMAN_MODEL_PATH").unwrap());
    let adapter = MoonshineAdapter;
    let started = Instant::now();
    assert_eq!(
        adapter.probe_model_and_language_support(&path).unwrap(),
        LanguageSupport::List {
            tags: vec!["de".to_string()]
        },
    );
    let mut model = adapter
        .load_streaming(&path, GpuConfig { use_gpu: false })
        .unwrap();
    model.set_language("de").unwrap();
    assert_eq!(
        model.set_language("en").unwrap_err().code,
        "unsupported_language"
    );
    let load_time = started.elapsed();
    let fixture =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/audio/de-fleurs-1577.wav");
    let audio = hound::WavReader::open(fixture)
        .unwrap()
        .samples::<i16>()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    let started = Instant::now();
    let mut partials = 0;
    for chunk in audio.chunks(8_000) {
        model.accept_audio(chunk).unwrap();
        if !model.partial().unwrap().segments.is_empty() {
            partials += 1;
        }
    }
    let output = model.finalize_utterance().unwrap();
    let text = output
        .segments
        .iter()
        .map(|segment| segment.text.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    eprintln!(
        "load={load_time:?}, inference={:?}, partials={partials}, transcript={text}",
        started.elapsed()
    );
    assert!(partials > 0, "German streaming produced no partials");
    assert!(
        text.to_lowercase().contains("sinnvoll") && text.to_lowercase().contains("fair"),
        "unexpected German fixture transcript: {text}"
    );
    assert!(
        model.partial().unwrap().segments.is_empty(),
        "finalization must reset utterance state"
    );
    model.accept_audio(&vec![0; 16_000]).unwrap();
    let silent_output = model.finalize_utterance().unwrap();
    let silent_text = silent_output
        .segments
        .iter()
        .map(|segment| segment.text.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    eprintln!("direct-model silence output={silent_text:?}; production VAD is tested separately");
    assert!(
        !silent_text.to_lowercase().contains("sinnvoll"),
        "reset leaked previous speech into silence"
    );
}

#[test]
#[ignore = "requires the verified German streaming export; natural long-speech adoption gate"]
fn german_natural_long_recordings_preserve_words_and_reset() {
    let path = PathBuf::from(std::env::var("MOONSHINE_GERMAN_MODEL_PATH").unwrap());
    let manifest: serde_json::Value = serde_json::from_slice(
        &std::fs::read(common::fixtures_dir().join("long-german.json")).unwrap(),
    )
    .unwrap();
    let mut model = MoonshineAdapter
        .load_streaming(&path, GpuConfig { use_gpu: false })
        .unwrap();
    model.set_language("de").unwrap();
    let mut failures = Vec::new();
    for fixture in manifest["fixtures"].as_array().unwrap() {
        let audio = common::audio::decode_wav_16k_mono(
            &common::fixtures_dir().join(fixture["audioPath"].as_str().unwrap()),
        )
        .unwrap();
        let started = Instant::now();
        let mut partials = 0;
        for chunk in audio.chunks(8_000) {
            model.accept_audio(chunk).unwrap();
            if !model.partial().unwrap().segments.is_empty() {
                partials += 1;
            }
        }
        let output = model.finalize_utterance().unwrap();
        let text = common::text::joined_text(&output);
        let wer = common::text::word_error_rate(fixture["reference"].as_str().unwrap(), &text);
        eprintln!(
            "{}",
            serde_json::json!({
                "fixture": fixture["id"], "audioSeconds": audio.len() as f64 / 16_000.0,
                "wordErrorRate": wer, "partials": partials,
                "computeMs": started.elapsed().as_secs_f64() * 1_000.0, "text": text,
            })
        );
        assert!(
            model.partial().unwrap().segments.is_empty(),
            "finalization must reset partial state"
        );
        if wer > 0.30 || partials == 0 {
            failures.push(format!("{}: WER={wer}, partials={partials}", fixture["id"]));
        }
    }
    assert!(
        failures.is_empty(),
        "natural German adoption gate failed: {failures:?}"
    );
}

#[test]
#[ignore = "paced real VAD/worker natural German adoption gate; requires verified German model"]
fn german_natural_long_recordings_through_paced_vad() {
    let path = PathBuf::from(std::env::var("MOONSHINE_GERMAN_MODEL_PATH").unwrap());
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
        let frames = common::audio::fixture_frames_with_trailing_silence(&audio);
        let started = Instant::now();
        let outcome = common::driver::stream_in_process_language(
            SelectedModel::ExternalFile {
                runtime_id: RuntimeId::OnnxRuntime,
                family_id: ModelFamilyId::Moonshine,
                file_path: path.display().to_string(),
            },
            &frames,
            "de",
        );
        let wer = common::text::word_error_rate(
            fixture["reference"].as_str().unwrap(),
            &outcome.final_texts.join(" "),
        );
        eprintln!(
            "{}",
            serde_json::json!({
                "fixture": fixture["id"], "audioSeconds": audio.len() as f64 / 16_000.0,
                "wordErrorRate": wer, "partials": outcome.partials.len(), "finals": outcome.final_texts,
                "wallMs": started.elapsed().as_secs_f64() * 1_000.0, "errors": outcome.errors,
            })
        );
        if wer > 0.30 || !outcome.errors.is_empty() || !outcome.stopped {
            failures.push(format!(
                "{}: WER={wer}, errors={:?}, stopped={}",
                fixture["id"], outcome.errors, outcome.stopped
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "paced natural German adoption gate failed: {failures:?}"
    );
}

#[test]
#[ignore = "requires a verified German model; multiple phrases and external language contract"]
fn german_multiple_phrases_preserve_session_and_language_contract() {
    let path = PathBuf::from(std::env::var("MOONSHINE_GERMAN_MODEL_PATH").unwrap());
    assert_eq!(
        MoonshineAdapter
            .probe_model_and_language_support(&path)
            .unwrap(),
        LanguageSupport::List {
            tags: vec!["de".to_string()]
        }
    );
    let mut app = AppState::new(
        "german-language-contract",
        ModelCatalog::load_bundled().unwrap(),
    );
    let mut start = external_start("wrong-language", &path);
    if let Command::StartSession { language, .. } = &mut start {
        *language = "en".to_string();
    }
    let (_, events) = app.handle_command(start);
    assert!(
        events.iter().any(
            |event| matches!(event, Event::Error { code, .. } if code == "unsupported_language")
        ),
        "German artifact accepted English: {events:?}"
    );
    assert!(
        !events
            .iter()
            .any(|event| matches!(event, Event::SessionStarted { .. }))
    );
    let audio = common::audio::decode_wav_16k_mono(
        &common::fixtures_dir().join("audio/de-fleurs-1577.wav"),
    )
    .unwrap();
    let mut sequence = audio.clone();
    sequence.extend(std::iter::repeat_n(0_i16, 3 * 16_000));
    sequence.extend(audio);
    let frames = common::audio::fixture_frames_with_trailing_silence(&sequence);
    let outcome = common::driver::stream_in_process_language(
        SelectedModel::ExternalFile {
            runtime_id: RuntimeId::OnnxRuntime,
            family_id: ModelFamilyId::Moonshine,
            file_path: path.display().to_string(),
        },
        &frames,
        "de",
    );
    let reference = ["das erschien mir nicht sinnvoll es war ganz gewiss nicht fair"; 2].join(" ");
    let wer = common::text::word_error_rate(&reference, &outcome.final_texts.join(" "));
    eprintln!(
        "{}",
        serde_json::json!({"check":"multiple_phrases", "finals": outcome.final_texts,
        "partials": outcome.partials.len(), "wordErrorRate": wer, "errors": outcome.errors})
    );
    assert!(outcome.errors.is_empty() && outcome.stopped);
    assert_eq!(
        outcome.final_texts.len(),
        2,
        "natural phrase boundary must finalize each clip once"
    );
    assert!(
        wer <= 0.30,
        "multiple-phrase short speech quality failed: {wer}"
    );
}
