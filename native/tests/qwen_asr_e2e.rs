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
