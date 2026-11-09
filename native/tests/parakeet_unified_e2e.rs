//! Real-model acceptance for the pinned Parakeet Unified English export.

mod common;

use common::{
    audio, driver,
    manifest::Corpus,
    text::{joined_text, missing_anchors, word_error_rate},
};
use local_dictation_sidecar::adapters::parakeet_unified::ParakeetUnifiedAdapter;
use local_dictation_sidecar::engine::traits::ModelFamilyAdapter;
use local_dictation_sidecar::engine::{ModelFamilyId, RuntimeId};
use local_dictation_sidecar::protocol::SelectedModel;
use local_dictation_sidecar::transcription::GpuConfig;

#[test]
#[ignore = "needs the pinned Parakeet Unified ONNX export"]
fn partials_and_final_preserve_speech_and_reset() {
    let fixture = Corpus::load()
        .fixtures
        .into_iter()
        .find(|fixture| fixture.id == "7021-79740-0000")
        .unwrap();
    let samples = audio::decode_wav_16k_mono(&fixture.audio_path()).unwrap();
    let mut model = ParakeetUnifiedAdapter
        .load_streaming(
            &common::model::require_parakeet_unified_model(),
            GpuConfig { use_gpu: false },
        )
        .unwrap();
    let mut partials = Vec::new();
    for chunk in samples.chunks(8_000) {
        model.accept_audio(chunk).unwrap();
        let text = joined_text(&model.partial().unwrap());
        if !text.is_empty() && partials.last() != Some(&text) {
            partials.push(text);
        }
    }
    let final_text = joined_text(&model.finalize_utterance().unwrap());
    assert!(!partials.is_empty(), "expected a live partial");
    assert!(partials.windows(2).all(|p| p[1].starts_with(&p[0])));
    assert!(final_text.starts_with(partials.last().unwrap()));
    let wer = word_error_rate(&fixture.reference, &final_text);
    eprintln!("Parakeet final: {final_text} (WER {wer:.3})");
    assert!(wer <= fixture.max_wer, "{final_text}");
    assert!(
        missing_anchors(&final_text, &fixture.anchors).is_empty(),
        "{final_text}"
    );
    assert!(joined_text(&model.partial().unwrap()).is_empty());
    model.accept_audio(&samples).unwrap();
    assert_eq!(
        final_text,
        joined_text(&model.finalize_utterance().unwrap())
    );
}

#[test]
#[ignore = "needs the pinned Parakeet Unified ONNX export"]
fn silence_and_cancelled_audio_leave_no_text() {
    let mut model = ParakeetUnifiedAdapter
        .load_streaming(
            &common::model::require_parakeet_unified_model(),
            GpuConfig { use_gpu: false },
        )
        .unwrap();
    model.accept_audio(&vec![0; 48_000]).unwrap();
    assert!(joined_text(&model.finalize_utterance().unwrap()).is_empty());
    let fixture = Corpus::load()
        .fixtures
        .into_iter()
        .find(|fixture| fixture.id == "7021-79740-0000")
        .unwrap();
    let samples = audio::decode_wav_16k_mono(&fixture.audio_path()).unwrap();
    model.accept_audio(&samples[..64_000]).unwrap();
    assert!(
        !joined_text(&model.partial().unwrap()).is_empty(),
        "the cancelled utterance must have a partial"
    );
    model.reset_utterance();
    assert!(joined_text(&model.finalize_utterance().unwrap()).is_empty());
}

#[test]
#[ignore = "needs the pinned Parakeet Unified ONNX export"]
fn worker_streams_and_finalizes_a_public_speech_fixture() {
    let fixture = Corpus::load()
        .fixtures
        .into_iter()
        .find(|fixture| fixture.id == "7021-79740-0000")
        .unwrap();
    let samples = audio::decode_wav_16k_mono(&fixture.audio_path()).unwrap();
    let selection = SelectedModel::ExternalFile {
        runtime_id: RuntimeId::OnnxRuntime,
        family_id: ModelFamilyId::ParakeetUnified,
        file_path: common::model::require_parakeet_unified_model()
            .display()
            .to_string(),
    };
    let result = driver::stream_in_process(
        selection,
        &audio::fixture_frames_with_trailing_silence(&samples),
    );
    assert!(result.stopped, "session did not stop");
    assert!(result.errors.is_empty(), "{:?}", result.errors);
    assert!(!result.partials.is_empty(), "no live partials");
    let wer = word_error_rate(&fixture.reference, &result.final_text);
    eprintln!(
        "Worker elapsed: {} ms for {} ms audio",
        result.processing_ms,
        samples.len() * 1000 / 16_000
    );
    eprintln!(
        "Parakeet worker final: {} (WER {wer:.3})",
        result.final_text
    );
    assert!(wer <= fixture.max_wer, "{}", result.final_text);
    assert!(missing_anchors(&result.final_text, &fixture.anchors).is_empty());
}

#[test]
#[ignore = "needs the pinned Parakeet Unified ONNX export"]
fn final_partial_hops_keep_the_end_of_speech() {
    let fixture = Corpus::load()
        .fixtures
        .into_iter()
        .find(|fixture| fixture.id == "7021-79740-0000")
        .unwrap();
    let samples = audio::decode_wav_16k_mono(&fixture.audio_path()).unwrap();
    let mut model = ParakeetUnifiedAdapter
        .load_streaming(
            &common::model::require_parakeet_unified_model(),
            GpuConfig { use_gpu: false },
        )
        .unwrap();
    // Remove most trailing silence, then end just beyond a feature boundary.
    let clipped_len = ((samples.len() - 1_800) / 160) * 160;
    for extra_samples in [1, 79] {
        for chunk in samples[..clipped_len].chunks(8_000) {
            model.accept_audio(chunk).unwrap();
            model.partial().unwrap();
        }
        model.accept_audio(&vec![0; extra_samples]).unwrap();
        let text = joined_text(&model.finalize_utterance().unwrap());
        assert!(
            word_error_rate(&fixture.reference, &text) <= fixture.max_wer,
            "{text}"
        );
        assert!(text.to_lowercase().contains("useful"), "{text}");
    }
}

#[test]
#[ignore = "needs the pinned Parakeet Unified ONNX export and runs for over a minute"]
fn sustained_worker_stream_finishes_without_queue_errors() {
    let fixture = Corpus::load()
        .fixtures
        .into_iter()
        .find(|fixture| fixture.id == "7021-79740-0000")
        .unwrap();
    let clip = audio::decode_wav_16k_mono(&fixture.audio_path()).unwrap();
    let samples = clip.repeat(6);
    let selection = SelectedModel::ExternalFile {
        runtime_id: RuntimeId::OnnxRuntime,
        family_id: ModelFamilyId::ParakeetUnified,
        file_path: common::model::require_parakeet_unified_model()
            .display()
            .to_string(),
    };
    let result = driver::stream_in_process(
        selection,
        &audio::fixture_frames_with_trailing_silence(&samples),
    );
    assert!(result.stopped, "session did not stop");
    assert!(result.errors.is_empty(), "{:?}", result.errors);
    assert!(!result.partials.is_empty(), "no live partials");
    assert!(
        result.final_text.to_lowercase().contains("useful"),
        "missing end of final phrase: {}",
        result.final_text
    );
    eprintln!(
        "Sustained worker elapsed: {} ms for {} ms audio",
        result.processing_ms,
        samples.len() * 1000 / 16_000
    );
}

#[test]
#[ignore = "needs the 1120 ms Parakeet Unified ONNX export"]
fn buffered_1120_profile_loads() {
    let encoder = common::model::require_parakeet_unified_model();
    ParakeetUnifiedAdapter
        .load_streaming(&encoder, GpuConfig { use_gpu: false })
        .expect("the 1120 ms buffered export should load");
}
