//! Optional machine-readable measurements from the model-backed acceptance
//! tests. Tests remain authoritative for pass/fail; setting
//! `STT_QUALITY_REPORT_PATH` additionally appends one JSON object per measured
//! fixture so CI and release tooling can render the same evidence for humans.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;

use serde::Serialize;

pub const REPORT_PATH_ENV: &str = "STT_QUALITY_REPORT_PATH";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelEvidence {
    pub model_id: String,
    pub source_url: String,
    pub license: String,
    pub artifacts: Vec<ArtifactEvidence>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactEvidence {
    pub filename: String,
    pub download_url: String,
    pub expected_sha256: String,
    pub expected_size_bytes: u64,
    pub actual_sha256: Option<String>,
    pub actual_size_bytes: Option<u64>,
}

/// Compute once per model, outside the timed inference path. Explicit local
/// overrides may differ from the catalog; retain both identities, never relabel.
pub fn model_evidence(model_id: &str, entry: &std::path::Path) -> ModelEvidence {
    let catalog = local_dictation_sidecar::catalog::ModelCatalog::load_bundled().unwrap();
    let model = catalog
        .models
        .iter()
        .find(|model| model.model_id == model_id)
        .unwrap();
    let primary = model.primary_artifact().unwrap();
    ModelEvidence {
        model_id: model_id.to_owned(),
        source_url: model.source_url.clone(),
        license: model.license_label.clone(),
        artifacts: model
            .artifacts
            .iter()
            .filter(|artifact| artifact.required)
            .map(|artifact| {
                let path = if artifact.artifact_id == primary.artifact_id {
                    entry.to_path_buf()
                } else {
                    entry.with_file_name(&artifact.filename)
                };
                ArtifactEvidence {
                    filename: artifact.filename.clone(),
                    download_url: artifact.download_url.clone(),
                    expected_sha256: artifact.sha256.clone(),
                    expected_size_bytes: artifact.size_bytes,
                    actual_sha256: super::model::file_sha256(&path).ok(),
                    actual_size_bytes: std::fs::metadata(path).ok().map(|metadata| metadata.len()),
                }
            })
            .collect(),
    }
}

#[derive(Debug, Serialize)]
pub struct FixtureEvidence<'a> {
    pub sha256: &'a str,
    pub manifest: &'a str,
}

#[derive(Debug, Serialize)]
pub struct CorrectnessEvidence<'a> {
    pub stopped: bool,
    pub errors: &'a [String],
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaseEvidence<'a> {
    pub reference: &'a str,
    pub hypothesis: &'a str,
    pub scored_reference: String,
    pub scored_hypothesis: String,
    pub normalization: &'static str,
    pub fixture: FixtureEvidence<'a>,
    pub model: &'a ModelEvidence,
    pub correctness: CorrectnessEvidence<'a>,
}

impl<'a> CaseEvidence<'a> {
    pub fn new(
        reference: &'a str,
        hypothesis: &'a str,
        language: &str,
        metric: &str,
        fixture: FixtureEvidence<'a>,
        model: &'a ModelEvidence,
        correctness: CorrectnessEvidence<'a>,
    ) -> Self {
        let scored = if language == "sr" {
            super::text::to_serbian_latin(hypothesis)
        } else {
            hypothesis.to_owned()
        };
        let normalize = |text: &str| {
            if metric == "cer" {
                text.to_lowercase()
                    .chars()
                    .filter(|c| c.is_alphanumeric())
                    .collect()
            } else {
                super::text::normalize(text).join(" ")
            }
        };
        Self {
            reference,
            hypothesis,
            scored_reference: normalize(reference),
            scored_hypothesis: normalize(&scored),
            normalization: if language == "sr" {
                "serbian-latin-unicode-alphanumeric-lowercase-v1"
            } else if metric == "cer" {
                "unicode-alphanumeric-lowercase-cer-v1"
            } else {
                "unicode-alphanumeric-lowercase-v1"
            },
            fixture,
            model,
            correctness,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityMeasurement<'a> {
    pub suite: &'a str,
    pub model_id: &'a str,
    pub model_name: &'a str,
    pub language: &'a str,
    pub selection: &'a str,
    pub fixture_id: &'a str,
    pub quality_metric: &'a str,
    pub quality_error_rate: f64,
    pub quality_budget: f64,
    pub audio_duration_ms: u64,
    pub processing_duration_ms: u64,
    pub real_time_factor: f64,
    pub real_time_factor_budget: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_partial_audio_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_partial_audio_budget_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub utterance_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub partial_count: Option<usize>,
    pub passed: bool,
}

/// The on-disk line format: the schema version is `record`'s concern, not a
/// field every suite restates.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct VersionedMeasurement<'a> {
    schema_version: u8,
    #[serde(flatten)]
    measurement: &'a QualityMeasurement<'a>,
    #[serde(skip_serializing_if = "Option::is_none")]
    evidence: Option<&'a CaseEvidence<'a>>,
}

pub fn record(measurement: &QualityMeasurement<'_>) {
    record_inner(measurement, None);
}

pub fn record_evidence(measurement: &QualityMeasurement<'_>, evidence: &CaseEvidence<'_>) {
    record_inner(measurement, Some(evidence));
}

fn record_inner(measurement: &QualityMeasurement<'_>, evidence: Option<&CaseEvidence<'_>>) {
    let Some(path) = std::env::var_os(REPORT_PATH_ENV).map(PathBuf::from) else {
        return;
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap_or_else(|error| {
            panic!(
                "create quality report directory {}: {error}",
                parent.display()
            )
        });
    }
    let mut output = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .unwrap_or_else(|error| panic!("open quality report {}: {error}", path.display()));
    serde_json::to_writer(
        &mut output,
        &VersionedMeasurement {
            schema_version: if evidence.is_some() { 2 } else { 1 },
            measurement,
            evidence,
        },
    )
    .unwrap_or_else(|error| panic!("serialize quality measurement: {error}"));
    output
        .write_all(b"\n")
        .unwrap_or_else(|error| panic!("write quality report {}: {error}", path.display()));
}

/// Locks the JSONL line shape consumed by
/// `scripts/lib/transcription-quality-report.mjs`: camelCase keys, a top-level
/// `schemaVersion`, and omitted (not null) optional fields.
#[test]
fn versioned_measurement_serializes_the_parser_contract() {
    let line = serde_json::to_value(VersionedMeasurement {
        schema_version: 1,
        evidence: None,
        measurement: &QualityMeasurement {
            suite: "suite",
            model_id: "model",
            model_name: "Model",
            language: "en",
            selection: "manual",
            fixture_id: "fixture",
            quality_metric: "wer",
            quality_error_rate: 0.1,
            quality_budget: 0.2,
            audio_duration_ms: 1_000,
            processing_duration_ms: 500,
            real_time_factor: 0.5,
            real_time_factor_budget: 1.0,
            first_partial_audio_ms: None,
            first_partial_audio_budget_ms: None,
            utterance_count: Some(1),
            partial_count: None,
            passed: true,
        },
    })
    .expect("measurement must serialize");

    assert_eq!(line["schemaVersion"], 1);
    assert_eq!(line["modelId"], "model");
    assert_eq!(line["realTimeFactorBudget"], 1.0);
    assert_eq!(line["utteranceCount"], 1);
    let object = line.as_object().expect("line must be a JSON object");
    assert!(!object.contains_key("firstPartialAudioMs"));
    assert!(!object.contains_key("partialCount"));
}

#[test]
fn evidence_retains_verbatim_text_and_declares_scoring_transformations() {
    let model = ModelEvidence {
        model_id: "model".into(),
        source_url: "pinned".into(),
        license: "Apache-2.0".into(),
        artifacts: Vec::new(),
    };
    let case = CaseEvidence::new(
        "At 4,892 m.",
        "At 4892 meters.",
        "en",
        "wer",
        FixtureEvidence {
            sha256: "fixture",
            manifest: "manifest.json",
        },
        &model,
        CorrectnessEvidence {
            stopped: false,
            errors: &[],
        },
    );
    assert_eq!(case.reference, "At 4,892 m.");
    assert_eq!(case.hypothesis, "At 4892 meters.");
    assert_eq!(case.scored_reference, "at 4 892 m");
    assert_eq!(case.scored_hypothesis, "at 4892 meters");
    assert_eq!(case.normalization, "unicode-alphanumeric-lowercase-v1");
    let serbian = CaseEvidence::new(
        "ovo je tekst",
        "Ово је текст",
        "sr",
        "wer",
        FixtureEvidence {
            sha256: "fixture",
            manifest: "manifest.json",
        },
        &model,
        CorrectnessEvidence {
            stopped: true,
            errors: &[],
        },
    );
    assert_eq!(serbian.hypothesis, "Ово је текст");
    assert_eq!(serbian.scored_hypothesis, "ovo je tekst");
    assert!(serbian.normalization.starts_with("serbian-latin-"));
}

#[test]
fn local_model_override_keeps_actual_identity_instead_of_catalog_identity() {
    let path = std::env::temp_dir().join(format!("quality-model-{}", uuid::Uuid::new_v4()));
    std::fs::write(&path, b"local override").unwrap();
    let evidence = model_evidence(super::model::TEST_MODEL_ID, &path);
    std::fs::remove_file(path).unwrap();
    let artifact = &evidence.artifacts[0];
    assert_eq!(artifact.actual_size_bytes, Some(14));
    assert_ne!(
        artifact.actual_sha256.as_deref(),
        Some(artifact.expected_sha256.as_str())
    );
    assert!(artifact.actual_sha256.is_some());
}
