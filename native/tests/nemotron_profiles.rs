#![cfg(feature = "engine-nemotron-asr")]

mod common;

use std::path::PathBuf;

use common::text::joined_text;
use local_dictation_sidecar::adapters::nemotron_asr::NemotronAsrAdapter;
use local_dictation_sidecar::engine::ModelFamilyId;
use local_dictation_sidecar::engine::RuntimeId;
use local_dictation_sidecar::engine::capabilities::LanguageSupport;
use local_dictation_sidecar::engine::traits::ModelFamilyAdapter;
use local_dictation_sidecar::protocol::SelectedModel;
use local_dictation_sidecar::transcription::GpuConfig;

fn local_encoder(variable: &str) -> PathBuf {
    let directory = std::env::var(variable).unwrap_or_else(|_| {
        panic!("Set {variable} to the verified local model directory; this test never downloads weights")
    });
    PathBuf::from(directory).join("encoder.int8.onnx")
}

#[test]
fn family_label_covers_english_and_multilingual_models() {
    assert_eq!(
        ModelFamilyId::NemotronAsr.display_name(),
        "NVIDIA Nemotron ASR"
    );
}

#[test]
#[ignore = "requires both verified local Nemotron profile directories"]
fn new_profiles_publish_live_revisions_and_stop() {
    for (variable, language, fixture) in [
        ("STT_TEST_NEMOTRON_ENGLISH_DIR", "en", "7021-79740-0000.wav"),
        ("STT_TEST_NEMOTRON_160MS_DIR", "de", "de-fleurs-1577.wav"),
    ] {
        let encoder = local_encoder(variable);
        let samples =
            common::audio::decode_wav_16k_mono(&common::fixtures_dir().join("audio").join(fixture))
                .unwrap();
        let frames = common::audio::fixture_frames_with_trailing_silence(&samples);
        let result = common::driver::stream_in_process_language(
            SelectedModel::ExternalFile {
                runtime_id: RuntimeId::OnnxRuntime,
                family_id: ModelFamilyId::NemotronAsr,
                file_path: encoder.display().to_string(),
            },
            &frames,
            language,
        );
        assert!(result.stopped, "{variable} did not stop");
        assert!(result.errors.is_empty(), "{:?}", result.errors);
        assert!(
            !result.partials.is_empty(),
            "{variable} had no live partial"
        );
        assert!(
            result
                .partials
                .windows(2)
                .all(|pair| pair[1].revision > pair[0].revision
                    && pair[1].text.starts_with(&pair[0].text))
        );
        assert!(
            result
                .final_revision
                .is_some_and(|revision| revision > result.partials.last().unwrap().revision)
        );
        assert!(
            result
                .final_text
                .starts_with(&result.partials.last().unwrap().text)
        );
    }
}

#[test]
#[ignore = "requires verified English 560 ms assets in STT_TEST_NEMOTRON_ENGLISH_DIR"]
fn english_560ms_export_loads_streams_and_rejects_other_languages() {
    let encoder = local_encoder("STT_TEST_NEMOTRON_ENGLISH_DIR");
    assert_eq!(
        NemotronAsrAdapter
            .probe_model_and_language_support(&encoder)
            .unwrap(),
        LanguageSupport::EnglishOnly,
    );
    let mut model = NemotronAsrAdapter
        .load_streaming(&encoder, GpuConfig { use_gpu: false })
        .unwrap();
    assert!(model.set_language("de").is_err());
    assert!(model.set_language("auto").is_err());
    model.set_language("en").unwrap();
    let audio = common::audio::decode_wav_16k_mono(
        &common::fixtures_dir().join("audio/7021-79740-0000.wav"),
    )
    .unwrap();
    let mut partials = Vec::new();
    for chunk in audio.chunks(1_600) {
        model.accept_audio(chunk).unwrap();
        let text = joined_text(&model.partial().unwrap());
        if !text.is_empty() && partials.last() != Some(&text) {
            partials.push(text);
        }
    }
    let final_text = joined_text(&model.finalize_utterance().unwrap());
    eprintln!("English 560 ms final: {final_text}");
    assert!(!partials.is_empty());
    assert!(
        partials
            .windows(2)
            .all(|pair| pair[1].starts_with(&pair[0]))
    );
    assert!(final_text.starts_with(partials.last().unwrap()));
    assert!(final_text.to_lowercase().contains("such persons"));
    model.accept_audio(&vec![0; 32_000]).unwrap();
    assert!(joined_text(&model.finalize_utterance().unwrap()).is_empty());
}

#[test]
#[ignore = "requires verified 160 ms assets in STT_TEST_NEMOTRON_160MS_DIR"]
fn multilingual_160ms_loads_transcribes_german_and_resets() {
    let encoder = local_encoder("STT_TEST_NEMOTRON_160MS_DIR");
    let languages = NemotronAsrAdapter
        .probe_model_and_language_support(&encoder)
        .unwrap();
    assert!(
        matches!(languages, LanguageSupport::List { tags } if tags.iter().any(|tag| tag == "de"))
    );
    let mut model = NemotronAsrAdapter
        .load_streaming(&encoder, GpuConfig { use_gpu: false })
        .unwrap();
    model.set_language("de").unwrap();
    let audio = common::audio::decode_wav_16k_mono(
        &common::fixtures_dir().join("audio/de-fleurs-1577.wav"),
    )
    .unwrap();
    model.accept_audio(&audio).unwrap();
    let final_text = joined_text(&model.finalize_utterance().unwrap());
    eprintln!("Multilingual 160 ms German final: {final_text}");
    assert!(!final_text.trim().is_empty());
    assert!(!final_text.contains("<de-DE>"));
    model.set_language("auto").unwrap();
    model.accept_audio(&vec![0; 32_000]).unwrap();
    assert!(joined_text(&model.finalize_utterance().unwrap()).is_empty());
}
