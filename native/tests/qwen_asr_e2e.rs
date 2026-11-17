mod common;

use local_dictation_sidecar::engine::registry::EngineRegistry;
use local_dictation_sidecar::engine::{ModelFamilyId, RuntimeId};
use local_dictation_sidecar::transcription::{GpuConfig, TranscriptionRequest};
use std::path::PathBuf;

#[test]
fn qwen_family_is_honest_about_batch_language_and_timing() {
    let family: ModelFamilyId =
        serde_json::from_str("\"qwen3_asr\"").expect("Qwen ASR family must be recognized");
    let registry = EngineRegistry::build();
    let adapter = registry
        .adapter(RuntimeId::LlamaCpp, family)
        .expect("Qwen needs its native helper adapter");
    let caps = adapter.capabilities();
    assert!(
        !caps.supports_streaming,
        "first slice is bounded batch, not a cached streaming encoder"
    );
    assert!(!caps.supports_word_timestamps);
    assert!(caps.supports_automatic_language_detection);
    let languages = serde_json::to_value(&caps.supported_languages).unwrap();
    assert!(
        languages["tags"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("ja"))
    );
    assert!(
        !languages["tags"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("hr"))
    );
    assert!(
        !languages["tags"]
            .as_array()
            .unwrap()
            .contains(&serde_json::json!("sr"))
    );
}

#[test]
#[ignore = "requires STT_QWEN_MODEL and the built version-matched ASR helper"]
fn real_german_model_transcribes_without_leaking_control_tokens() {
    let path = PathBuf::from(std::env::var("STT_QWEN_MODEL").unwrap());
    let family: ModelFamilyId = serde_json::from_str("\"qwen3_asr\"").expect("Qwen ASR family");
    let mut registry = EngineRegistry::build();
    registry.register_adapter(Box::new(
        local_dictation_sidecar::adapters::qwen_asr::QwenAsrAdapter::with_helper_executable(
            PathBuf::from(env!("CARGO_BIN_EXE_local-dictation-asr-helper")),
        ),
    ));
    let adapter = registry.adapter(RuntimeId::LlamaCpp, family).unwrap();
    let mut model = adapter.load(&path, GpuConfig { use_gpu: false }).unwrap();
    let samples = common::audio::decode_wav_16k_mono(
        &common::fixtures_dir().join("audio/de-fleurs-1577.wav"),
    )
    .unwrap();
    for language in ["de", "auto"] {
        let output = model
            .transcribe(&TranscriptionRequest {
                audio_samples: samples.iter().map(|&s| f32::from(s) / 32768.0).collect(),
                detailed_timestamps_enabled: true,
                gpu_config: GpuConfig { use_gpu: false },
                language: language.into(),
                model_file_path: path.clone(),
                context: None,
            })
            .unwrap();
        let text = common::text::joined_text(&output);
        assert!(
            !text.contains("<asr_text>") && !text.contains("<|"),
            "{text}"
        );
        assert!(
            common::text::word_error_rate(
                "das erschien mir nicht sinnvoll es war ganz gewiss nicht fair",
                &text
            ) <= 0.45,
            "{language}: {text}"
        );
        if language == "auto" {
            assert_eq!(output.detected_language.as_deref(), Some("de"));
        }
        assert!(output.segments.iter().all(|s| s.words.is_empty()));
    }
}

#[test]
#[ignore = "diagnostic: provisional raw English screen fails on 0.6B; requires local Qwen pair"]
fn qwen_multilingual_and_natural_long_quality() {
    let path = PathBuf::from(std::env::var("STT_QWEN_MODEL").unwrap());
    let adapter =
        local_dictation_sidecar::adapters::qwen_asr::QwenAsrAdapter::with_helper_executable(
            PathBuf::from(env!("CARGO_BIN_EXE_local-dictation-asr-helper")),
        );
    use local_dictation_sidecar::engine::traits::ModelFamilyAdapter;
    let mut model = adapter.load(&path, GpuConfig { use_gpu: false }).unwrap();
    let mut cases: Vec<(String, PathBuf, String, f64)> = Vec::new();
    let english = common::manifest::Corpus::load()
        .fixtures
        .into_iter()
        .find(|f| f.id == "7021-79740-0000")
        .unwrap();
    cases.push((
        "en-short".into(),
        english.audio_path(),
        english.reference,
        0.20,
    ));
    let multilingual: serde_json::Value = serde_json::from_slice(
        &std::fs::read(common::fixtures_dir().join("multilingual.json")).unwrap(),
    )
    .unwrap();
    for f in multilingual["fixtures"].as_array().unwrap() {
        let language = f["language"].as_str().unwrap();
        if ["hr", "sr"].contains(&language) {
            continue;
        }
        cases.push((
            language.into(),
            common::fixtures_dir().join(f["audioPath"].as_str().unwrap()),
            f["reference"].as_str().unwrap().into(),
            0.45,
        ));
    }
    for manifest in ["long-german.json", "qwen-asr-quality.json"] {
        let data: serde_json::Value =
            serde_json::from_slice(&std::fs::read(common::fixtures_dir().join(manifest)).unwrap())
                .unwrap();
        for f in data["fixtures"].as_array().unwrap() {
            cases.push((
                f["id"].as_str().unwrap().into(),
                common::fixtures_dir().join(f["audioPath"].as_str().unwrap()),
                f["reference"].as_str().unwrap().into(),
                if manifest == "qwen-asr-quality.json" {
                    0.20
                } else {
                    0.45
                },
            ));
        }
    }
    let mut failures = Vec::new();
    for (id, audio, reference, max_error) in cases {
        let pcm = common::audio::decode_wav_16k_mono(&audio).unwrap();
        let started = std::time::Instant::now();
        let language = if id.starts_with("en-") {
            "en"
        } else if id.starts_with("de-") {
            "de"
        } else {
            &id
        };
        let output = model
            .transcribe(&TranscriptionRequest {
                audio_samples: pcm.iter().map(|&x| f32::from(x) / 32768.0).collect(),
                detailed_timestamps_enabled: false,
                gpu_config: GpuConfig { use_gpu: false },
                language: language.into(),
                model_file_path: path.clone(),
                context: None,
            })
            .unwrap();
        let text = common::text::joined_text(&output);
        let error = if language == "ja" {
            common::text::character_error_rate(&reference, &text)
        } else {
            common::text::word_error_rate(&reference, &text)
        };
        eprintln!(
            "{}",
            serde_json::json!({"case":id,"audioSeconds":pcm.len() as f64/16000.0,"wallMs":started.elapsed().as_secs_f64()*1000.0,"errorRate":error,"text":text})
        );
        if error > max_error {
            failures.push(format!("{id}: {error} > {max_error}"));
        }
    }
    assert!(failures.is_empty(), "quality floors failed: {failures:?}");
}

#[cfg(unix)]
#[test]
fn public_probe_rejects_a_fifo_companion_before_helper_launch() {
    use local_dictation_sidecar::app::AppState;
    use local_dictation_sidecar::catalog::ModelCatalog;
    use local_dictation_sidecar::protocol::{Command, Event, SelectedModel};
    use std::sync::mpsc;
    use std::time::Duration;
    let root = std::env::temp_dir().join(format!("speech-kit-qwen-fifo-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let model = root.join("Qwen3-ASR-test-Q8_0.gguf");
    let companion = root.join("mmproj-Qwen3-ASR-test-Q8_0.gguf");
    std::fs::write(&model, b"GGUF").unwrap();
    assert!(
        std::process::Command::new("mkfifo")
            .arg(&companion)
            .status()
            .unwrap()
            .success()
    );
    let (tx, rx) = mpsc::channel();
    let thread = std::thread::spawn(move || {
        let mut app = AppState::new("fifo-probe", ModelCatalog::load_bundled().unwrap());
        let (_, events) = app.handle_command(Command::ProbeModelSelection {
            model_selection: SelectedModel::ExternalFile {
                runtime_id: RuntimeId::LlamaCpp,
                family_id: ModelFamilyId::Qwen3Asr,
                file_path: model.display().to_string(),
            },
            model_store_path_override: None,
            request_id: None,
        });
        tx.send(events).unwrap();
    });
    let result = rx.recv_timeout(Duration::from_secs(1));
    let _ = std::fs::remove_dir_all(&root);
    let events = result.expect("a nonregular companion must not block the public probe");
    thread.join().unwrap();
    assert!(
        events.iter().any(|event| matches!(
            event,
            Event::ModelProbeResult {
                available: false,
                ..
            }
        )),
        "{events:?}"
    );
    assert!(
        serde_json::to_string(&events).unwrap().contains("regular"),
        "probe must reject the FIFO before checking the missing helper: {events:?}"
    );
}
