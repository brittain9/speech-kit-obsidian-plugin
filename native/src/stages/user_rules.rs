use std::collections::{HashMap, HashSet};

use serde::Serialize;
use unicode_general_category::{GeneralCategory, get_general_category};
use unicode_normalization::UnicodeNormalization;

use crate::protocol::{
    MAX_FRAME_PAYLOAD, MAX_SESSION_ID_CHARS, PersonalCorrectionRule, StageId, TranscriptSegment,
};
use crate::stages::{StageContext, StageProcess, StageProcessor};
use crate::transcription::Transcript;

pub const MAX_CORRECTION_OUTPUT_CHARS: usize = 1_000_000;
pub const MAX_CORRECTION_AMPLIFICATION: usize = 8;
pub const MAX_CORRECTION_INPUT_CHARS: usize = 1_000_000;
pub const MAX_CORRECTION_NORMALIZED_SCAN_CHARS: usize = 2_000_000;
pub const MAX_CORRECTION_SEARCH_STEPS: usize = 4_000_000;
const MAX_SESSION_ID_EVENT_BYTES: usize = 32 + MAX_SESSION_ID_CHARS * 6;

const VERSION: u32 = 2;
#[cfg(test)]
thread_local! {
    static NORMALIZED_INPUT_VECTOR_CONSTRUCTIONS: std::cell::Cell<usize> =
        const { std::cell::Cell::new(0) };
}
const ABSOLUTE_AMPLIFICATION_CODE: &str = "absolute_amplification";
const RELATIVE_AMPLIFICATION_CODE: &str = "relative_amplification";
const WORK_BUDGET_CODE: &str = "work_budget";

#[derive(Debug, Clone)]
pub struct CompiledPersonalCorrectionRule {
    enabled: bool,
    first_scalar: Option<char>,
    normalized_find: Vec<char>,
    replace: String,
    replace_chars: usize,
}

pub type CompiledPersonalCorrectionRules = Vec<CompiledPersonalCorrectionRule>;

pub fn compile_correction_rules(
    rules: &[PersonalCorrectionRule],
) -> CompiledPersonalCorrectionRules {
    rules
        .iter()
        .map(|rule| CompiledPersonalCorrectionRule {
            enabled: rule.enabled.unwrap_or(false),
            first_scalar: rule.find.nfd().next(),
            normalized_find: rule.find.nfd().collect(),
            replace: rule.replace.clone(),
            replace_chars: rule.replace.chars().count(),
        })
        .collect()
}

pub struct UserRulesStage;

impl StageProcessor for UserRulesStage {
    fn id(&self) -> StageId {
        StageId::UserRules
    }

    fn process(&self, transcript: &Transcript, ctx: &StageContext<'_>) -> StageProcess {
        if !ctx.is_final {
            return StageProcess::Skipped {
                reason: "partial".to_string(),
                payload: None,
            };
        }

        let enabled_rule_count = ctx
            .correction_rules
            .iter()
            .filter(|rule| rule.enabled.unwrap_or(false))
            .count();
        if enabled_rule_count == 0 {
            return StageProcess::Skipped {
                reason: "disabled".to_string(),
                payload: Some(payload(UserRulesPayload {
                    version: VERSION,
                    rule_count: ctx.correction_rules.len(),
                    enabled_rule_count: 0,
                    applied_rule_count: 0,
                    replacement_count: 0,
                    changed_segment_count: 0,
                })),
            };
        }

        let compiled = ctx.compiled_correction_rules.map_or_else(
            || compile_correction_rules(ctx.correction_rules),
            <[CompiledPersonalCorrectionRule]>::to_vec,
        );
        let original_total = transcript
            .segments
            .iter()
            .try_fold(0_usize, |total, segment| {
                total.checked_add(segment.text.chars().count())
            })
            .unwrap_or(usize::MAX);
        let mut budget = UtteranceBudget::new(original_total);
        let mut corrected_segments = Vec::with_capacity(transcript.segments.len());
        let mut applied_rule_indices = HashSet::new();
        let mut replacement_count = 0_usize;
        let mut changed_segment_count = 0_usize;

        for segment in &transcript.segments {
            match apply_rules_to_segment(segment, &compiled, &mut budget) {
                Ok(result) => {
                    if result.changed {
                        changed_segment_count += 1;
                    }
                    applied_rule_indices.extend(result.applied_rule_indices);
                    replacement_count += result.replacement_count;
                    corrected_segments.push(result.segment);
                }
                Err(error) => return failed_process(error.code, &error.message),
            }
        }

        if estimate_transcript_event_bytes(&corrected_segments, &transcript.stage_history)
            > MAX_FRAME_PAYLOAD
        {
            return failed_process(
                "frame_budget",
                "the corrected transcript event exceeds the sidecar frame payload limit",
            );
        }

        let payload = payload(UserRulesPayload {
            version: VERSION,
            rule_count: ctx.correction_rules.len(),
            enabled_rule_count,
            applied_rule_count: applied_rule_indices.len(),
            replacement_count,
            changed_segment_count,
        });
        if replacement_count == 0 {
            StageProcess::Skipped {
                reason: "no_matches".to_string(),
                payload: Some(payload),
            }
        } else {
            StageProcess::Ok {
                segments: corrected_segments,
                payload: Some(payload),
            }
        }
    }
}

#[derive(Debug)]
struct SegmentApplication {
    applied_rule_indices: Vec<usize>,
    changed: bool,
    replacement_count: usize,
    segment: TranscriptSegment,
}

#[derive(Debug)]
struct RuleApplication {
    matches: Vec<(usize, usize)>,
}

#[derive(Debug)]
struct RuleApplicationError {
    code: &'static str,
    message: String,
}

impl RuleApplicationError {
    fn absolute() -> Self {
        Self {
            code: ABSOLUTE_AMPLIFICATION_CODE,
            message: format!(
                "personal correction output exceeds {MAX_CORRECTION_OUTPUT_CHARS} characters"
            ),
        }
    }

    fn relative() -> Self {
        Self {
            code: RELATIVE_AMPLIFICATION_CODE,
            message: format!(
                "personal correction output exceeds {MAX_CORRECTION_AMPLIFICATION}x amplification"
            ),
        }
    }

    fn work(message: impl Into<String>) -> Self {
        Self {
            code: WORK_BUDGET_CODE,
            message: message.into(),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UserRulesPayload {
    version: u32,
    rule_count: usize,
    enabled_rule_count: usize,
    applied_rule_count: usize,
    replacement_count: usize,
    changed_segment_count: usize,
}

#[derive(Debug)]
struct UtteranceBudget {
    current_chars: usize,
    normalized_chars: usize,
    original_chars: usize,
    search_steps: usize,
}

impl UtteranceBudget {
    fn new(original_chars: usize) -> Self {
        Self {
            current_chars: original_chars,
            normalized_chars: 0,
            original_chars,
            search_steps: 0,
        }
    }

    fn reserve_normalized(&mut self, count: usize) -> Result<(), RuleApplicationError> {
        let next = self
            .normalized_chars
            .checked_add(count)
            .ok_or_else(|| RuleApplicationError::work("normalized correction input overflows"))?;
        if next > MAX_CORRECTION_NORMALIZED_SCAN_CHARS {
            return Err(RuleApplicationError::work(
                "normalized correction input exceeds the safety budget",
            ));
        }
        self.normalized_chars = next;
        Ok(())
    }

    fn add_search_steps(&mut self, count: usize) -> Result<(), RuleApplicationError> {
        self.search_steps = self
            .search_steps
            .checked_add(count)
            .ok_or_else(|| RuleApplicationError::work("correction search work overflows"))?;
        if self.search_steps > MAX_CORRECTION_SEARCH_STEPS {
            return Err(RuleApplicationError::work(
                "correction search exceeds the safety budget",
            ));
        }
        Ok(())
    }

    fn check_output(
        &mut self,
        current_segment_chars: usize,
        output_chars: usize,
    ) -> Result<(), RuleApplicationError> {
        let other_chars = self.current_chars.saturating_sub(current_segment_chars);
        let total = other_chars
            .checked_add(output_chars)
            .ok_or_else(RuleApplicationError::absolute)?;
        if total > MAX_CORRECTION_OUTPUT_CHARS {
            return Err(RuleApplicationError::absolute());
        }
        let relative_limit = self
            .original_chars
            .checked_mul(MAX_CORRECTION_AMPLIFICATION)
            .ok_or_else(RuleApplicationError::relative)?;
        if self.original_chars > 0 && total > relative_limit {
            return Err(RuleApplicationError::relative());
        }
        self.current_chars = total;
        Ok(())
    }
}

fn apply_rules_to_segment(
    segment: &TranscriptSegment,
    rules: &[CompiledPersonalCorrectionRule],
    budget: &mut UtteranceBudget,
) -> Result<SegmentApplication, RuleApplicationError> {
    let original_text = segment.text.as_str();
    if original_text.chars().count() > MAX_CORRECTION_INPUT_CHARS {
        return Err(RuleApplicationError::work(
            "correction input exceeds the safety budget",
        ));
    }
    let mut normalized = NormalizedInput::new(original_text, budget)?;
    let mut text: Option<String> = None;
    let mut applied_rule_indices = Vec::new();
    let mut replacement_count = 0;

    for (index, rule) in rules.iter().enumerate() {
        if !rule.enabled {
            continue;
        }
        let current_chars = text.as_deref().unwrap_or(original_text).chars().count();
        let application = preflight_rule(&normalized, rule, current_chars, budget)?;
        if application.matches.is_empty() {
            continue;
        }
        let next = materialize_rule(
            text.as_deref().unwrap_or(original_text),
            &rule.replace,
            &application.matches,
        );
        let changed = next != text.as_deref().unwrap_or(original_text);
        text = Some(next);
        applied_rule_indices.push(index);
        replacement_count += application.matches.len();
        if changed {
            normalized = NormalizedInput::new(text.as_deref().unwrap_or(original_text), budget)?;
        }
    }

    let Some(text) = text else {
        return Ok(SegmentApplication {
            applied_rule_indices,
            changed: false,
            replacement_count,
            segment: segment.clone(),
        });
    };

    Ok(SegmentApplication {
        applied_rule_indices,
        changed: text != original_text,
        replacement_count,
        segment: TranscriptSegment {
            text,
            ..segment.clone()
        },
    })
}

fn preflight_rule(
    normalized: &NormalizedInput,
    rule: &CompiledPersonalCorrectionRule,
    current_segment_chars: usize,
    budget: &mut UtteranceBudget,
) -> Result<RuleApplication, RuleApplicationError> {
    let candidate_count = rule
        .first_scalar
        .and_then(|scalar| normalized.first_scalar_indices.get(&scalar))
        .map_or(0, Vec::len);
    let normalized_find_len = rule.normalized_find.len();
    let per_candidate = normalized_find_len
        .checked_add(2)
        .ok_or_else(|| RuleApplicationError::work("correction search work overflows"))?;
    let boundary_cost = candidate_count
        .checked_mul(per_candidate)
        .ok_or_else(|| RuleApplicationError::work("correction search work overflows"))?;
    budget.add_search_steps(boundary_cost)?;
    let matches = find_matches(normalized, rule);
    let replace_length = rule.replace_chars;
    let removed = matches.iter().try_fold(0_usize, |total, &(start, end)| {
        total.checked_add(normalized.input[start..end].chars().count())
    });
    let removed = removed.ok_or_else(RuleApplicationError::absolute)?;
    let added = replace_length
        .checked_mul(matches.len())
        .ok_or_else(RuleApplicationError::absolute)?;
    let output_length = current_segment_chars
        .checked_sub(removed)
        .and_then(|length| length.checked_add(added))
        .ok_or_else(RuleApplicationError::absolute)?;
    budget.check_output(current_segment_chars, output_length)?;
    Ok(RuleApplication { matches })
}

fn materialize_rule(input: &str, replace: &str, matches: &[(usize, usize)]) -> String {
    let mut output = String::with_capacity(input.len());
    let mut cursor = 0;
    for &(start, end) in matches {
        output.push_str(&input[cursor..start]);
        output.push_str(replace);
        cursor = end;
    }
    output.push_str(&input[cursor..]);
    output
}

struct NormalizedInput {
    boundary_map: Vec<Option<usize>>,
    chars: Vec<char>,
    first_scalar_indices: HashMap<char, Vec<usize>>,
    input: String,
    next_word_boundary: Vec<bool>,
    previous_word_boundary: Vec<bool>,
    safe_boundaries: Vec<bool>,
}

impl NormalizedInput {
    fn new(input: &str, budget: &mut UtteranceBudget) -> Result<Self, RuleApplicationError> {
        // Count normalization without constructing per-character strings or
        // vectors so the aggregate budget is checked before any allocation.
        let normalized_len = input.nfd().count();
        if normalized_len > MAX_CORRECTION_INPUT_CHARS {
            return Err(RuleApplicationError::work(
                "normalized correction input exceeds the safety budget",
            ));
        }
        // Reserve the aggregate budget before constructing any full normalized,
        // original-character, or boundary vectors.
        budget.reserve_normalized(normalized_len)?;
        #[cfg(test)]
        NORMALIZED_INPUT_VECTOR_CONSTRUCTIONS.with(|counter| counter.set(counter.get() + 1));
        let input = input.to_owned();
        let original_chars = input.chars().collect::<Vec<_>>();
        let normalized = input.nfd().collect::<Vec<_>>();
        let mut boundary_map = vec![None; normalized.len() + 1];
        let mut safe_boundaries = vec![false; normalized.len() + 1];
        let mut normalized_index = 0;
        let mut byte_index = 0;
        for original_char in &original_chars {
            let expansion = original_char.to_string().nfd().collect::<Vec<_>>();
            let combining = is_combining_mark(*original_char);
            boundary_map[normalized_index] = Some(byte_index);
            safe_boundaries[normalized_index] = !combining;
            for offset in 1..expansion.len() {
                safe_boundaries[normalized_index + offset] = false;
            }
            let end_boundary = normalized_index + expansion.len();
            boundary_map[end_boundary] = Some(byte_index + original_char.len_utf8());
            safe_boundaries[end_boundary] = !combining;
            normalized_index += expansion.len();
            byte_index += original_char.len_utf8();
        }
        boundary_map[normalized.len()] = Some(byte_index);
        safe_boundaries[normalized.len()] = true;
        let mut first_scalar_indices = HashMap::new();
        for (index, character) in normalized.iter().copied().enumerate() {
            first_scalar_indices
                .entry(character)
                .or_insert_with(Vec::new)
                .push(index);
        }
        let mut previous_word_boundary = vec![false; normalized.len() + 1];
        for (index, character) in normalized.iter().copied().enumerate() {
            previous_word_boundary[index + 1] = if is_combining_mark(character) {
                previous_word_boundary[index]
            } else {
                is_word_character(character)
            };
        }
        let mut next_word_boundary = vec![false; normalized.len() + 1];
        for index in (0..normalized.len()).rev() {
            next_word_boundary[index] = if is_combining_mark(normalized[index]) {
                next_word_boundary[index + 1]
            } else {
                is_word_character(normalized[index])
            };
        }
        Ok(Self {
            boundary_map,
            chars: normalized,
            first_scalar_indices,
            input,
            next_word_boundary,
            previous_word_boundary,
            safe_boundaries,
        })
    }
}

fn find_matches(
    normalized: &NormalizedInput,
    rule: &CompiledPersonalCorrectionRule,
) -> Vec<(usize, usize)> {
    let Some(first_scalar) = rule.first_scalar else {
        return Vec::new();
    };
    let mut matches = Vec::new();
    let mut next_allowed_start = 0;
    for &index in normalized
        .first_scalar_indices
        .get(&first_scalar)
        .into_iter()
        .flatten()
    {
        if index < next_allowed_start {
            continue;
        }
        if index + rule.normalized_find.len() > normalized.chars.len() {
            continue;
        }
        if !same_code_points(&normalized.chars, index, &rule.normalized_find) {
            continue;
        }
        if !normalized.safe_boundaries[index]
            || !normalized.safe_boundaries[index + rule.normalized_find.len()]
        {
            continue;
        }
        let after_index = index + rule.normalized_find.len();
        let start_edge = word_edge(&rule.normalized_find, 0, 1);
        let end_edge = word_edge(
            &rule.normalized_find,
            rule.normalized_find.len().saturating_sub(1),
            -1,
        );
        if is_boundary(start_edge, &normalized.previous_word_boundary, index)
            || is_boundary(end_edge, &normalized.next_word_boundary, after_index)
        {
            continue;
        }
        let (Some(start), Some(end)) = (
            normalized.boundary_map[index],
            normalized.boundary_map[after_index],
        ) else {
            continue;
        };
        matches.push((start, end));
        next_allowed_start = after_index;
    }
    matches
}

fn word_edge(chars: &[char], start: usize, direction: isize) -> Option<char> {
    let mut index = start as isize;
    while index >= 0 && (index as usize) < chars.len() {
        let value = chars[index as usize];
        if !is_combining_mark(value) {
            return Some(value);
        }
        index += direction;
    }
    None
}

fn is_boundary(edge: Option<char>, adjacent_word_boundary: &[bool], boundary_index: usize) -> bool {
    edge.is_some_and(is_word_character)
        && boundary_index < adjacent_word_boundary.len()
        && adjacent_word_boundary[boundary_index]
}

fn is_combining_mark(value: char) -> bool {
    matches!(
        get_general_category(value),
        GeneralCategory::NonspacingMark
            | GeneralCategory::SpacingMark
            | GeneralCategory::EnclosingMark
    )
}

fn is_word_character(value: char) -> bool {
    value == '_'
        || matches!(
            get_general_category(value),
            GeneralCategory::UppercaseLetter
                | GeneralCategory::LowercaseLetter
                | GeneralCategory::TitlecaseLetter
                | GeneralCategory::ModifierLetter
                | GeneralCategory::OtherLetter
                | GeneralCategory::DecimalNumber
                | GeneralCategory::LetterNumber
                | GeneralCategory::OtherNumber
        )
}

fn same_code_points(input: &[char], start: usize, expected: &[char]) -> bool {
    expected
        .iter()
        .enumerate()
        .all(|(offset, value)| input.get(start + offset) == Some(value))
}

fn estimate_transcript_event_bytes(
    segments: &[TranscriptSegment],
    stage_history: &[crate::protocol::StageOutcome],
) -> usize {
    // JSON escaping can consume six bytes for one Unicode scalar. Count both
    // the segment text and the duplicate joined `text` field conservatively,
    // plus fixed metadata/frame overhead for words, timings, and stage history.
    let mut estimate = 2_048usize.saturating_add(MAX_SESSION_ID_EVENT_BYTES);
    for segment in segments {
        estimate = estimate.saturating_add(256);
        estimate = estimate.saturating_add(segment.text.chars().count().saturating_mul(6));
        for word in &segment.words {
            estimate = estimate.saturating_add(128);
            estimate = estimate.saturating_add(word.text.chars().count().saturating_mul(6));
        }
    }
    let joined_chars = segments
        .iter()
        .map(|segment| segment.text.chars().count())
        .sum::<usize>();
    estimate = estimate.saturating_add(joined_chars.saturating_mul(6));
    estimate = estimate.saturating_add(segments.len().saturating_mul(8));
    let history_bytes = serde_json::to_vec(stage_history)
        .map(|bytes| bytes.len().saturating_mul(2))
        .unwrap_or(MAX_FRAME_PAYLOAD);
    estimate.saturating_add(history_bytes)
}

fn payload(value: UserRulesPayload) -> serde_json::Value {
    serde_json::to_value(value).expect("personal correction payload should serialize")
}

fn failed_process(code: &'static str, message: &str) -> StageProcess {
    StageProcess::Failed {
        error: format!("{code}: {message}"),
        payload: Some(serde_json::json!({ "errorCode": code })),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio_metadata::VoiceActivityEvidence;
    use crate::engine::capabilities::{LanguageSupport, ModelFamilyCapabilities, ModelTask};
    use crate::protocol::{StageOutcome, StageStatus, TimestampGranularity, TimestampSource};
    use crate::stages::{post_engine_processors, run_post_engine};
    use uuid::Uuid;

    fn segment(text: &str) -> TranscriptSegment {
        TranscriptSegment {
            end_ms: 1_000,
            speaker: Some(0),
            start_ms: 0,
            text: text.to_string(),
            timestamp_granularity: TimestampGranularity::Segment,
            timestamp_source: TimestampSource::Engine,
            words: Vec::new(),
        }
    }

    fn context<'a>(rules: &'a [PersonalCorrectionRule], is_final: bool) -> StageContext<'a> {
        let caps = Box::leak(Box::new(ModelFamilyCapabilities {
            task: ModelTask::Stt,
            supports_hardware_acceleration: true,
            available_voices: Vec::new(),
            supports_speed_control: false,
            output_sample_rate: None,
            supports_segment_timestamps: true,
            supports_word_timestamps: false,
            supports_initial_prompt: true,
            supports_streaming: false,
            supports_language_selection: false,
            supports_automatic_language_detection: false,
            supported_languages: LanguageSupport::EnglishOnly,
            max_audio_duration_secs: None,
            produces_punctuation: true,
        }));
        let enablement = Box::leak(Box::new(crate::stages::StageEnablement::default()));
        let voice_activity = Box::leak(Box::new(VoiceActivityEvidence {
            audio_start_ms: 0,
            audio_end_ms: 1_000,
            speech_start_ms: 0,
            speech_end_ms: 1_000,
            voiced_ms: 1_000,
            unvoiced_ms: 0,
            mean_probability: 0.9,
            max_probability: 1.0,
        }));
        let runtime = Box::leak(Box::new(
            tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap(),
        ));
        let (_cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
        let cancel_rx = Box::leak(Box::new(cancel_rx));
        StageContext {
            cancel_rx,
            context: None,
            correction_rules: rules,
            compiled_correction_rules: None,
            family_capabilities: caps,
            is_final,
            language: "en",
            pause_ms_before_utterance: None,
            segment_diagnostics: &[],
            stage_enabled: enablement,
            tokio_runtime: runtime,
            vad_probabilities: &[],
            voice_activity,
        }
    }

    fn transcript(segments: Vec<TranscriptSegment>) -> Transcript {
        Transcript {
            utterance_id: Uuid::nil(),
            revision: 0,
            segments,
            stage_history: vec![StageOutcome {
                duration_ms: 0,
                is_final: true,
                payload: None,
                revision_in: 0,
                revision_out: Some(0),
                stage_id: StageId::Engine,
                status: StageStatus::Ok,
            }],
        }
    }

    fn rule(find: &str, replace: &str) -> PersonalCorrectionRule {
        PersonalCorrectionRule {
            enabled: Some(true),
            find: find.to_string(),
            id: format!("{find}-{replace}"),
            replace: replace.to_string(),
            validity: Default::default(),
        }
    }

    #[test]
    fn matches_whole_words_with_unicode_letter_and_number_categories() {
        assert_eq!(
            find_matches(
                &NormalizedInput::new(
                    "cat concatenate cat cat_2 2cat",
                    &mut UtteranceBudget::new(100)
                )
                .unwrap(),
                &compile_correction_rules(&[rule("cat", "x")])[0]
            ),
            vec![(0, 3), (16, 19)]
        );
        assert_eq!(
            find_matches(
                &NormalizedInput::new("one １ Ⅻ e\u{301}", &mut UtteranceBudget::new(100)).unwrap(),
                &compile_correction_rules(&[rule("e\u{301}", "x")])[0]
            ),
            vec![(12, 15)]
        );
        assert!(
            find_matches(
                &NormalizedInput::new("cafe\u{301}", &mut UtteranceBudget::new(100)).unwrap(),
                &compile_correction_rules(&[rule("cafe", "x")])[0]
            )
            .is_empty()
        );
        assert!(
            find_matches(
                &NormalizedInput::new("cafe\u{301}x", &mut UtteranceBudget::new(100)).unwrap(),
                &compile_correction_rules(&[rule("cafe\u{301}", "x")])[0]
            )
            .is_empty()
        );
        assert_eq!(
            find_matches(
                &NormalizedInput::new("é é", &mut UtteranceBudget::new(100)).unwrap(),
                &compile_correction_rules(&[rule("é", "x")])[0]
            ),
            vec![(0, 2), (3, 5)]
        );
    }

    #[test]
    fn matches_left_to_right_without_overlapping_punctuation() {
        let result = apply_rules_to_segment(
            &segment("!!!"),
            &compile_correction_rules(&[rule("!!", "!")]),
            &mut UtteranceBudget::new(3),
        )
        .expect("punctuation rule should apply");
        assert_eq!(result.segment.text, "!!");
        assert_eq!(result.replacement_count, 1);
    }

    #[test]
    fn rejects_partial_canonical_scalar_matches() {
        let normalized = NormalizedInput::new("café", &mut UtteranceBudget::new(100)).unwrap();
        let compiled = compile_correction_rules(&[rule("cafe", "tea")]);
        assert!(find_matches(&normalized, &compiled[0]).is_empty());
    }

    #[test]
    fn matches_nfd_forms_but_preserves_replacement_text() {
        let mut budget = UtteranceBudget::new(4);
        let result = apply_rules_to_segment(
            &segment("cafe\u{301}"),
            &compile_correction_rules(&[rule("café", "coffee")]),
            &mut budget,
        )
        .expect("NFD match should succeed");
        assert_eq!(result.segment.text, "coffee");
    }

    #[test]
    fn rejects_relative_amplification_before_materializing() {
        let mut budget = UtteranceBudget::new(1);
        let error = apply_rules_to_segment(
            &segment("a"),
            &compile_correction_rules(&[rule("a", "aaaaaaaaa")]),
            &mut budget,
        )
        .expect_err("nine times expansion must be rejected");
        assert_eq!(error.code, "relative_amplification");
    }

    #[test]
    fn rejects_absolute_amplification_before_materializing() {
        let input = "a ".repeat(MAX_CORRECTION_OUTPUT_CHARS / 2);
        let mut budget = UtteranceBudget::new(input.chars().count());
        let error = apply_rules_to_segment(
            &segment(&input),
            &compile_correction_rules(&[rule("a", "aa")]),
            &mut budget,
        )
        .expect_err("absolute amplification must be rejected");
        assert_eq!(error.code, "absolute_amplification");
    }

    #[test]
    fn rejects_ordered_doubling_cascade_at_the_budget() {
        let rules = compile_correction_rules(&[
            rule("a", "aa"),
            rule("aa", "aaaa"),
            rule("aaaa", "aaaaaaaa"),
            rule("aaaaaaaa", "aaaaaaaaaaaaaaaa"),
        ]);
        let mut budget = UtteranceBudget::new(1);
        let error = apply_rules_to_segment(&segment("a"), &rules, &mut budget)
            .expect_err("ordered doubling must eventually be rejected");
        assert_eq!(error.code, "relative_amplification");
    }

    #[test]
    fn stage_history_records_corrections_after_hallucination_filter() {
        let rules = [rule("one", "1")];
        let mut final_transcript = transcript(vec![segment("one")]);
        run_post_engine(
            &mut final_transcript,
            &post_engine_processors(),
            &context(&rules, true),
        );
        let post_engine = &final_transcript.stage_history[1..];
        assert_eq!(post_engine.len(), 2);
        assert_eq!(post_engine[0].stage_id, StageId::HallucinationFilter);
        assert_eq!(post_engine[1].stage_id, StageId::UserRules);
        assert!(matches!(post_engine[1].status, StageStatus::Ok));
        assert_eq!(final_transcript.segments[0].text, "1");
    }

    #[test]
    fn stage_never_concatenates_across_segment_boundaries() {
        let mut budget = UtteranceBudget::new(3);
        let result = apply_rules_to_segment(
            &segment("one"),
            &compile_correction_rules(&[rule("two", "2")]),
            &mut budget,
        )
        .expect("second segment should not be joined to the first");
        assert_eq!(result.segment.text, "one");
    }

    #[test]
    fn counts_each_applied_rule_once_across_segments() {
        let rules = [rule("one", "1")];
        let mut transcript = transcript(vec![segment("one"), segment("one")]);
        transcript.segments[1].start_ms = 1_000;
        transcript.segments[1].end_ms = 2_000;
        let result = UserRulesStage.process(&transcript, &context(&rules, true));
        let StageProcess::Ok {
            payload: Some(payload),
            ..
        } = result
        else {
            panic!("expected correction stage success");
        };
        assert_eq!(payload.get("appliedRuleCount"), Some(&serde_json::json!(1)));
        assert_eq!(payload.get("replacementCount"), Some(&serde_json::json!(2)));
    }

    #[test]
    fn work_budget_rejects_many_long_near_matches_without_wall_clock_assumptions() {
        let rules = (0..100)
            .map(|_| rule(&format!("a{}", "b".repeat(255)), "x"))
            .collect::<Vec<_>>();
        let transcript = transcript(vec![segment(&"a".repeat(100_000))]);
        let result = UserRulesStage.process(&transcript, &context(&rules, true));
        let StageProcess::Failed { error, .. } = result else {
            panic!("expected work budget failure");
        };
        assert!(error.contains("work_budget"));
        assert_eq!(transcript.segments[0].text, "a".repeat(100_000));
    }

    #[test]
    fn nfd_long_near_match_work_budget_is_deterministic() {
        let input = "e\u{301}".repeat(50_000);
        let find = format!("{}x", "e\u{301}".repeat(127));
        let mut budget = UtteranceBudget::new(input.chars().count());
        let error = apply_rules_to_segment(
            &segment(&input),
            &compile_correction_rules(&[rule(&find, "x")]),
            &mut budget,
        )
        .expect_err("pathological NFD near-match must exhaust the work budget");
        assert_eq!(error.code, "work_budget");
    }

    #[test]
    fn identity_replacements_reuse_normalized_input_at_the_budget_limit() {
        let mut budget = UtteranceBudget::new(2);
        budget.normalized_chars = MAX_CORRECTION_NORMALIZED_SCAN_CHARS - 2;
        let result = apply_rules_to_segment(
            &segment("a "),
            &compile_correction_rules(&[rule("a", "a"), rule("a ", "a ")]),
            &mut budget,
        )
        .expect("identity replacements should not rebuild normalized input");

        assert_eq!(result.segment.text, "a ");
        assert_eq!(result.replacement_count, 2);
    }

    #[test]
    fn normalized_budget_rejects_before_temporary_strings_and_boundary_vectors() {
        let input = "e\u{301}".repeat(50_000);
        let mut budget = UtteranceBudget::new(input.chars().count());
        budget.normalized_chars = MAX_CORRECTION_NORMALIZED_SCAN_CHARS - 1;
        let before = NORMALIZED_INPUT_VECTOR_CONSTRUCTIONS.with(std::cell::Cell::get);
        let error = match NormalizedInput::new(&input, &mut budget) {
            Err(error) => error,
            Ok(_) => panic!("aggregate normalized budget should reject before vectors"),
        };
        assert_eq!(error.code, "work_budget");
        assert_eq!(
            NORMALIZED_INPUT_VECTOR_CONSTRUCTIONS.with(std::cell::Cell::get),
            before
        );
    }

    #[test]
    fn correction_frame_estimate_reserves_worst_case_session_id_bytes() {
        let estimate = estimate_transcript_event_bytes(&[segment("ok")], &[]);
        assert!(estimate >= 2_048 + MAX_SESSION_ID_EVENT_BYTES);
    }

    #[test]
    fn frame_budget_keeps_original_transcript_and_records_failed_stage() {
        let mut source = segment("a");
        source.words = vec![crate::protocol::TranscriptWord {
            end_ms: 1,
            start_ms: 0,
            text: "x".repeat(3_000_000),
            timestamp_source: TimestampSource::Engine,
        }];
        let mut transcript = transcript(vec![source]);
        let original_text = transcript.segments[0].text.clone();
        run_post_engine(
            &mut transcript,
            &post_engine_processors(),
            &context(&[rule("z", "y")], true),
        );
        assert_eq!(transcript.segments[0].text, original_text);
        assert_eq!(transcript.stage_history.len(), 3);
        assert!(matches!(
            transcript.stage_history.last().map(|stage| &stage.status),
            Some(StageStatus::Failed { error }) if error.contains("frame_budget")
        ));
    }

    #[test]
    fn stage_is_final_only_and_preserves_segment_boundaries() {
        let rules = [rule("one", "1")];
        let partial = transcript(vec![segment("one")]);
        let result = UserRulesStage.process(&partial, &context(&rules, false));
        assert!(matches!(result, StageProcess::Skipped { .. }));
        let mut final_transcript = transcript(vec![segment("one"), segment("two")]);
        final_transcript.segments[1].start_ms = 1_000;
        final_transcript.segments[1].end_ms = 2_000;
        let result = UserRulesStage.process(&final_transcript, &context(&rules, true));
        match result {
            StageProcess::Ok { segments, payload } => {
                assert_eq!(segments[0].text, "1");
                assert_eq!(segments[0].start_ms, 0);
                assert_eq!(segments[0].end_ms, 1_000);
                assert_eq!(segments[1].text, "two");
                assert_eq!(segments[1].speaker, Some(0));
                let payload = payload.expect("correction stage should record counts");
                assert_eq!(payload.get("replacementCount"), Some(&serde_json::json!(1)));
                assert_eq!(
                    payload.get("changedSegmentCount"),
                    Some(&serde_json::json!(1))
                );
            }
            _ => panic!("expected correction stage success"),
        }
    }

    #[test]
    fn consumes_shared_golden_vectors() {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../test/fixtures/personal-correction-golden.json"
        ))
        .expect("golden fixture should parse");
        for case in fixture["cases"]
            .as_array()
            .expect("cases should be an array")
        {
            let id = case["id"].as_str().expect("case id");
            let input = case["input"].as_str().expect("case input");
            let rules: Vec<PersonalCorrectionRule> = serde_json::from_value(case["rules"].clone())
                .expect("golden rules should deserialize");
            let compiled_rules = compile_correction_rules(&rules);
            if let Some(source_segments) = case["segments"].as_array() {
                let source_segments = source_segments
                    .iter()
                    .map(|value| {
                        serde_json::from_value::<TranscriptSegment>(value.clone())
                            .expect("segment should deserialize")
                    })
                    .collect::<Vec<_>>();
                let original_total = source_segments
                    .iter()
                    .map(|segment| segment.text.chars().count())
                    .sum();
                let mut budget = UtteranceBudget::new(original_total);
                let actual_segments = source_segments
                    .iter()
                    .map(|source| {
                        apply_rules_to_segment(source, &compiled_rules, &mut budget)
                            .expect("metadata vector should apply")
                            .segment
                    })
                    .collect::<Vec<_>>();
                assert_eq!(
                    serde_json::to_value(&actual_segments).expect("segments serialize"),
                    case["expectedSegments"],
                    "{id}"
                );
                continue;
            }
            let source_segment = segment(input);
            let mut budget = UtteranceBudget::new(source_segment.text.chars().count());
            let result = apply_rules_to_segment(&source_segment, &compiled_rules, &mut budget);
            if let Some(error_code) = case["errorCode"].as_str() {
                assert_eq!(
                    result.expect_err("cascade vector should fail").code,
                    error_code,
                    "{id}"
                );
            } else {
                let result = result.expect("golden vector should apply");
                if let Some(expected) = case["expected"].as_str() {
                    assert_eq!(result.segment.text, expected, "{id}");
                }
                if let Some(expected_replacements) = case["replacements"].as_u64() {
                    assert_eq!(
                        result.replacement_count as u64, expected_replacements,
                        "{id}"
                    );
                }
                if let Some(expected_rules_applied) = case["rulesApplied"].as_u64() {
                    assert_eq!(
                        result.applied_rule_indices.len() as u64,
                        expected_rules_applied,
                        "{id}"
                    );
                }
            }
        }
    }
}
