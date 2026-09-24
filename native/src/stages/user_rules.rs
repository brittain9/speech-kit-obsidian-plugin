use serde::Serialize;
use unicode_general_category::{GeneralCategory, get_general_category};
use unicode_normalization::UnicodeNormalization;

use crate::protocol::{
    PersonalCorrectionRule, StageId, TranscriptSegment, validate_correction_rules,
};
use crate::stages::{StageContext, StageProcess, StageProcessor};
use crate::transcription::Transcript;

pub const MAX_CORRECTION_OUTPUT_CHARS: usize = 1_000_000;
pub const MAX_CORRECTION_AMPLIFICATION: usize = 8;

const VERSION: u32 = 2;

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
        if let Err(error) = validate_correction_rules(ctx.correction_rules) {
            return failed_process("invalid_rule", &error.to_string());
        }

        let enabled_rule_count = ctx
            .correction_rules
            .iter()
            .filter(|rule| rule.enabled)
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

        let mut changed_segment_count = 0;
        let mut applied_rule_count = 0;
        let mut replacement_count = 0;
        let mut corrected_segments = Vec::with_capacity(transcript.segments.len());

        for segment in &transcript.segments {
            match apply_rules_to_segment(segment, ctx.correction_rules) {
                Ok(result) => {
                    if result.changed {
                        changed_segment_count += 1;
                    }
                    applied_rule_count += result.applied_rule_count;
                    replacement_count += result.replacement_count;
                    corrected_segments.push(result.segment);
                }
                Err(error) => return failed_process(error.code, &error.message),
            }
        }

        let payload = payload(UserRulesPayload {
            version: VERSION,
            rule_count: ctx.correction_rules.len(),
            enabled_rule_count,
            applied_rule_count,
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
    applied_rule_count: usize,
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
            code: "absolute_amplification",
            message: format!(
                "personal correction output exceeds {MAX_CORRECTION_OUTPUT_CHARS} characters"
            ),
        }
    }

    fn relative() -> Self {
        Self {
            code: "relative_amplification",
            message: format!(
                "personal correction output exceeds {MAX_CORRECTION_AMPLIFICATION}x amplification"
            ),
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct UserRulesPayload {
    version: u32,
    rule_count: usize,
    enabled_rule_count: usize,
    applied_rule_count: usize,
    replacement_count: usize,
    changed_segment_count: usize,
}

fn apply_rules_to_segment(
    segment: &TranscriptSegment,
    rules: &[PersonalCorrectionRule],
) -> Result<SegmentApplication, RuleApplicationError> {
    let original_text = segment.text.as_str();
    let original_length = original_text.chars().count();
    let mut text: Option<String> = None;
    let mut applied_rule_count = 0;
    let mut replacement_count = 0;

    for rule in rules.iter().filter(|rule| rule.enabled) {
        let current = text.as_deref().unwrap_or(original_text);
        let application = preflight_rule(current, rule, original_length)?;
        if application.matches.is_empty() {
            continue;
        }
        let next = match text.take() {
            Some(current) => materialize_rule(&current, rule, &application.matches),
            None => materialize_rule(original_text, rule, &application.matches),
        };
        text = Some(next);
        applied_rule_count += 1;
        replacement_count += application.matches.len();
    }

    let Some(text) = text else {
        return Ok(SegmentApplication {
            applied_rule_count,
            changed: false,
            replacement_count,
            segment: segment.clone(),
        });
    };

    Ok(SegmentApplication {
        applied_rule_count,
        changed: text != original_text,
        replacement_count,
        segment: TranscriptSegment {
            text,
            ..segment.clone()
        },
    })
}

fn preflight_rule(
    input: &str,
    rule: &PersonalCorrectionRule,
    original_length: usize,
) -> Result<RuleApplication, RuleApplicationError> {
    let matches = find_matches(input, &rule.find);
    let input_length = input.chars().count();
    let replace_length = rule.replace.chars().count();
    let removed = matches
        .iter()
        .try_fold(0_usize, |total, &(start, end)| {
            total.checked_add(input[start..end].chars().count())
        })
        .ok_or_else(|| RuleApplicationError {
            code: "absolute_amplification",
            message: "personal correction length overflow".to_string(),
        })?;
    let added = replace_length
        .checked_mul(matches.len())
        .ok_or_else(|| RuleApplicationError {
            code: "absolute_amplification",
            message: "personal correction length overflow".to_string(),
        })?;
    let output_length = input_length
        .checked_sub(removed)
        .and_then(|length| length.checked_add(added))
        .ok_or_else(RuleApplicationError::absolute)?;

    if output_length > MAX_CORRECTION_OUTPUT_CHARS {
        return Err(RuleApplicationError::absolute());
    }
    let relative_limit = original_length
        .checked_mul(MAX_CORRECTION_AMPLIFICATION)
        .ok_or_else(RuleApplicationError::relative)?;
    if original_length > 0 && output_length > relative_limit {
        return Err(RuleApplicationError::relative());
    }

    Ok(RuleApplication { matches })
}

fn materialize_rule(
    input: &str,
    rule: &PersonalCorrectionRule,
    matches: &[(usize, usize)],
) -> String {
    let mut output = String::with_capacity(input.len());
    let mut cursor = 0;
    for &(start, end) in matches {
        output.push_str(&input[cursor..start]);
        output.push_str(&rule.replace);
        cursor = end;
    }
    output.push_str(&input[cursor..]);
    output
}

fn find_matches(input: &str, find: &str) -> Vec<(usize, usize)> {
    let normalized_input: Vec<char> = input.nfd().collect();
    let normalized_find: Vec<char> = find.nfd().collect();
    let original_chars: Vec<char> = input.chars().collect();
    let original_boundaries = char_boundaries(&original_chars);
    let original_prefix_lengths = (normalized_input.len() != original_chars.len())
        .then(|| nfd_prefix_lengths(&original_chars));
    let mut matches = Vec::new();
    let mut index = 0;

    while index + normalized_find.len() <= normalized_input.len() {
        if !same_code_points(&normalized_input, index, &normalized_find) {
            index += 1;
            continue;
        }
        let before_index = index.checked_sub(1);
        let after_index = index + normalized_find.len();
        let start_edge = word_edge(&normalized_find, 0, 1);
        let end_edge = word_edge(
            &normalized_find,
            normalized_find.len().saturating_sub(1),
            -1,
        );
        if is_boundary(start_edge, &normalized_input, before_index, 1)
            || is_boundary(end_edge, &normalized_input, Some(after_index), -1)
        {
            index += 1;
            continue;
        }
        let start = map_normalized_boundary(
            &original_chars,
            &original_boundaries,
            index,
            normalized_input.len(),
            original_prefix_lengths.as_deref(),
        );
        let end = map_normalized_boundary(
            &original_chars,
            &original_boundaries,
            after_index,
            normalized_input.len(),
            original_prefix_lengths.as_deref(),
        );
        matches.push((start, end));
        index = after_index;
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

fn is_boundary(
    edge: Option<char>,
    adjacent: &[char],
    adjacent_index: Option<usize>,
    direction: isize,
) -> bool {
    let Some(mut index) = adjacent_index.map(|value| value as isize) else {
        return false;
    };
    if !edge.is_some_and(is_word_character) {
        return false;
    }
    while index >= 0
        && (index as usize) < adjacent.len()
        && is_combining_mark(adjacent[index as usize])
    {
        index += direction;
    }
    index >= 0 && (index as usize) < adjacent.len() && is_word_character(adjacent[index as usize])
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

fn char_boundaries(chars: &[char]) -> Vec<usize> {
    let mut boundaries = vec![0];
    let mut offset = 0;
    for character in chars {
        offset += character.len_utf8();
        boundaries.push(offset);
    }
    boundaries
}

fn nfd_prefix_lengths(chars: &[char]) -> Vec<usize> {
    let mut lengths = vec![0];
    let mut total = 0;
    for character in chars {
        total += character.to_string().nfd().count();
        lengths.push(total);
    }
    lengths
}

fn map_normalized_boundary(
    original_chars: &[char],
    original_boundaries: &[usize],
    normalized_index: usize,
    normalized_length: usize,
    original_prefix_lengths: Option<&[usize]>,
) -> usize {
    if normalized_length == original_chars.len() {
        return original_boundaries[normalized_index.min(original_chars.len())];
    }
    if let Some(prefix_lengths) = original_prefix_lengths
        && let Some(exact_index) = prefix_lengths
            .iter()
            .position(|length| *length == normalized_index)
    {
        return original_boundaries[exact_index];
    }
    let approximate = normalized_index.min(original_chars.len());
    let start = approximate.saturating_sub(8);
    let end = (approximate + 9).min(original_chars.len());
    let mut fallback = original_boundaries[approximate];
    for candidate in start..=end {
        let prefix: String = original_chars[..candidate].iter().collect();
        if prefix.nfd().count() == normalized_index {
            fallback = original_boundaries[candidate];
            if candidate == approximate {
                return fallback;
            }
        }
    }
    fallback
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
            enabled: true,
            find: find.to_string(),
            replace: replace.to_string(),
        }
    }

    #[test]
    fn matches_whole_words_with_unicode_letter_and_number_categories() {
        assert_eq!(
            find_matches("cat concatenate cat cat_2 2cat", "cat"),
            vec![(0, 3), (16, 19)]
        );
        assert_eq!(
            find_matches("one １ Ⅻ e\u{301}", "e\u{301}"),
            vec![(12, 15)]
        );
        assert!(find_matches("cafe\u{301}", "cafe").is_empty());
        assert!(find_matches("cafe\u{301}x", "cafe\u{301}").is_empty());
        assert_eq!(find_matches("é é", "é"), vec![(0, 2), (3, 5)]);
    }

    #[test]
    fn matches_nfd_forms_but_preserves_replacement_text() {
        let result = apply_rules_to_segment(&segment("cafe\u{301}"), &[rule("café", "coffee")])
            .expect("NFD match should succeed");
        assert_eq!(result.segment.text, "coffee");
    }

    #[test]
    fn rejects_relative_amplification_before_materializing() {
        let error = apply_rules_to_segment(&segment("a"), &[rule("a", "aaaaaaaaa")])
            .expect_err("nine times expansion must be rejected");
        assert_eq!(error.code, "relative_amplification");
    }

    #[test]
    fn rejects_absolute_amplification_before_materializing() {
        let input = "a ".repeat(MAX_CORRECTION_OUTPUT_CHARS / 2);
        let error = apply_rules_to_segment(&segment(&input), &[rule("a", "aa")])
            .expect_err("absolute amplification must be rejected");
        assert_eq!(error.code, "absolute_amplification");
    }

    #[test]
    fn rejects_ordered_doubling_cascade_at_the_budget() {
        let rules = [
            rule("a", "aa"),
            rule("aa", "aaaa"),
            rule("aaaa", "aaaaaaaa"),
            rule("aaaaaaaa", "aaaaaaaaaaaaaaaa"),
        ];
        let error = apply_rules_to_segment(&segment("a"), &rules)
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
        let result = apply_rules_to_segment(&segment("one"), &[rule("two", "2")])
            .expect("second segment should not be joined to the first");
        assert_eq!(result.segment.text, "one");
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
}
