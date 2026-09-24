import { t } from '../shared/i18n';

export const PERSONAL_CORRECTION_RULE_MAX_COUNT = 100;
export const PERSONAL_CORRECTION_RULE_MAX_CHARS = 256;
export const MAX_CORRECTION_OUTPUT_CHARS = 1_000_000;
export const MAX_CORRECTION_AMPLIFICATION = 8;

export interface PersonalCorrectionRule {
  enabled: boolean;
  find: string;
  id: string;
  replace: string;
}

export type PersonalCorrectionRuleErrorCode =
  | 'too_many_rules'
  | 'blank_find'
  | 'blank_replace'
  | 'oversized_find'
  | 'oversized_replace'
  | 'blank_id'
  | 'oversized_id'
  | 'invalid_id'
  | 'invalid_enabled'
  | 'invalid_find'
  | 'invalid_replace'
  | 'duplicate_id'
  | 'duplicate_find'
  | 'lone_surrogate'
  | 'absolute_amplification'
  | 'relative_amplification';

export interface PersonalCorrectionRuleValidationError {
  code: PersonalCorrectionRuleErrorCode;
  field: 'enabled' | 'find' | 'id' | 'replace' | 'rules';
  index?: number;
  message: string;
}

export interface PersonalCorrectionRulesValidation {
  errors: PersonalCorrectionRuleValidationError[];
  valid: boolean;
}

export type PersonalCorrectionPreviewResult =
  | {
      changed: boolean;
      inputLength: number;
      ok: true;
      output: string;
      outputLength: number;
      replacements: number;
      rulesApplied: number;
    }
  | {
      error: PersonalCorrectionRuleValidationError;
      ok: false;
    };

export class PersonalCorrectionRuleError extends Error {
  readonly code: PersonalCorrectionRuleErrorCode;
  readonly field: PersonalCorrectionRuleValidationError['field'];
  readonly index: number | undefined;

  constructor(error: PersonalCorrectionRuleValidationError) {
    super(error.message);
    this.name = 'PersonalCorrectionRuleError';
    this.code = error.code;
    this.field = error.field;
    this.index = error.index;
  }
}

/**
 * Validate settings at the boundary where a draft or persisted snapshot can be
 * trusted. This function deliberately does not normalize away invalid values:
 * silently dropping a malformed persisted rule would make the next session
 * silently behave differently from the saved settings.
 */
export function validatePersonalCorrectionRules(
  rules: readonly PersonalCorrectionRule[],
): PersonalCorrectionRulesValidation {
  const errors: PersonalCorrectionRuleValidationError[] = [];
  if (rules.length > PERSONAL_CORRECTION_RULE_MAX_COUNT) {
    errors.push(
      validationError(
        'too_many_rules',
        'rules',
        t('settings.corrections.validation.tooMany', {
          max: PERSONAL_CORRECTION_RULE_MAX_COUNT,
        }),
      ),
    );
  }

  const ids = new Set<string>();
  const finds = new Set<string>();
  rules.forEach((rule, index) => {
    if (typeof rule.id !== 'string') {
      errors.push(
        validationError('invalid_id', 'id', t('settings.corrections.validation.invalidId'), index),
      );
    } else {
      const id = rule.id.trim();
      if (id.length === 0) {
        errors.push(
          validationError('blank_id', 'id', t('settings.corrections.validation.blankId'), index),
        );
      } else if (unicodeLength(id) > PERSONAL_CORRECTION_RULE_MAX_CHARS) {
        errors.push(
          validationError(
            'oversized_id',
            'id',
            t('settings.corrections.validation.oversized', {
              field: correctionFieldLabel('id'),
              max: PERSONAL_CORRECTION_RULE_MAX_CHARS,
            }),
            index,
          ),
        );
      } else if (hasLoneUtf16Surrogate(id)) {
        errors.push(
          validationError(
            'lone_surrogate',
            'id',
            t('settings.corrections.validation.loneSurrogate'),
            index,
          ),
        );
      } else if (ids.has(id)) {
        errors.push(
          validationError(
            'duplicate_id',
            'id',
            t('settings.corrections.validation.duplicateId'),
            index,
          ),
        );
      }
      ids.add(id);
    }

    if (typeof rule.enabled !== 'boolean') {
      errors.push(
        validationError(
          'invalid_enabled',
          'enabled',
          t('settings.corrections.validation.invalidEnabled'),
          index,
        ),
      );
    }

    if (typeof rule.find !== 'string') {
      errors.push(
        validationError(
          'invalid_find',
          'find',
          t('settings.corrections.validation.invalidFind'),
          index,
        ),
      );
    } else {
      validateTextField(rule.find, 'find', 'blank_find', 'oversized_find', index, errors);
      if (
        rule.find.trim().length > 0 &&
        unicodeLength(rule.find) <= PERSONAL_CORRECTION_RULE_MAX_CHARS &&
        !hasLoneUtf16Surrogate(rule.find)
      ) {
        const normalizedFind = rule.find.normalize('NFD');
        if (finds.has(normalizedFind)) {
          errors.push(
            validationError(
              'duplicate_find',
              'find',
              t('settings.corrections.validation.duplicateFind'),
              index,
            ),
          );
        }
        finds.add(normalizedFind);
      }
    }

    if (typeof rule.replace !== 'string') {
      errors.push(
        validationError(
          'invalid_replace',
          'replace',
          t('settings.corrections.validation.invalidReplace'),
          index,
        ),
      );
    } else {
      validateTextField(
        rule.replace,
        'replace',
        'blank_replace',
        'oversized_replace',
        index,
        errors,
      );
    }
  });

  return { errors, valid: errors.length === 0 };
}

/**
 * Keep structurally recognizable persisted rules, including semantically
 * invalid values, so session-start validation can report a localized settings
 * error instead of sending an invalid protocol frame. Unknown rule fields are
 * retained for forward compatibility.
 */
export function normalizePersonalCorrectionRules(value: unknown): PersonalCorrectionRule[] {
  if (!Array.isArray(value)) return [];

  return value.flatMap((candidate) => {
    if (!isRecord(candidate)) return [];
    return [
      {
        // Keep unknown rule fields for forward-compatible settings round trips.
        ...candidate,
        // These casts preserve malformed scalar values for the validator while
        // keeping the normalized settings shape usable by the rest of the app.
        enabled:
          typeof candidate.enabled === 'boolean'
            ? candidate.enabled
            : (undefined as unknown as boolean),
        find: typeof candidate.find === 'string' ? candidate.find : '',
        id: typeof candidate.id === 'string' ? candidate.id.trim() : '',
        replace: typeof candidate.replace === 'string' ? candidate.replace : '',
      },
    ];
  });
}

export function compilePersonalCorrectionPreview(
  rules: readonly PersonalCorrectionRule[],
  input: string,
): PersonalCorrectionPreviewResult {
  const validation = validatePersonalCorrectionRules(rules);
  const firstError = validation.errors[0];
  if (firstError !== undefined) {
    return {
      error:
        firstError.index === undefined ? firstError : withRuleContext(firstError, firstError.index),
      ok: false,
    };
  }

  const originalLength = unicodeLength(input);
  let output = input;
  let replacements = 0;
  let rulesApplied = 0;
  for (const [index, rule] of rules.entries()) {
    if (!rule.enabled) continue;
    const application = preflightRule(output, rule, originalLength);
    if (!application.ok) {
      return { error: withRuleContext(application.error, index), ok: false };
    }
    if (application.application.matches.length === 0) continue;
    output = materializeRule(output, rule, application.application.matches);
    replacements += application.application.matches.length;
    rulesApplied += 1;
  }

  return {
    changed: output !== input,
    inputLength: originalLength,
    ok: true,
    output,
    outputLength: unicodeLength(output),
    replacements,
    rulesApplied,
  };
}

export function applyPersonalCorrectionRules(
  input: string,
  rules: readonly PersonalCorrectionRule[],
): string {
  const preview = compilePersonalCorrectionPreview(rules, input);
  if (!preview.ok) throw new PersonalCorrectionRuleError(preview.error);
  return preview.output;
}

type RuleApplication = { matches: RuleMatch[] };
type RuleApplicationResult =
  | { application: RuleApplication; ok: true }
  | { error: PersonalCorrectionRuleValidationError; ok: false };

type RuleMatch = { end: number; start: number };

type NormalizedInput = {
  chars: string[];
  firstScalarIndices: Map<string, number[]>;
  originalBoundaries: number[];
  originalChars: string[];
  originalPrefixLengths: number[] | null;
};

function preflightRule(
  input: string,
  rule: PersonalCorrectionRule,
  cascadeInputLength: number,
): RuleApplicationResult {
  const matches = findMatches(input, rule.find);
  const inputLength = unicodeLength(input);
  const replaceLength = unicodeLength(rule.replace);
  let removed = 0;
  for (const match of matches) {
    removed += unicodeLength(input.slice(match.start, match.end));
  }
  const outputLength = inputLength - removed + replaceLength * matches.length;

  if (!Number.isSafeInteger(outputLength) || outputLength > MAX_CORRECTION_OUTPUT_CHARS) {
    return {
      error: validationError(
        'absolute_amplification',
        'rules',
        t('settings.corrections.validation.absoluteAmplification', {
          max: MAX_CORRECTION_OUTPUT_CHARS,
        }),
      ),
      ok: false,
    };
  }
  const relativeLimit = Math.ceil(cascadeInputLength * MAX_CORRECTION_AMPLIFICATION);
  if (cascadeInputLength > 0 && outputLength > relativeLimit) {
    return {
      error: validationError(
        'relative_amplification',
        'rules',
        t('settings.corrections.validation.relativeAmplification', {
          max: MAX_CORRECTION_AMPLIFICATION,
        }),
      ),
      ok: false,
    };
  }

  return { application: { matches }, ok: true };
}

function materializeRule(
  input: string,
  rule: PersonalCorrectionRule,
  matches: readonly RuleMatch[],
): string {
  if (matches.length === 0) return input;
  const pieces: string[] = [];
  let cursor = 0;
  for (const match of matches) {
    pieces.push(input.slice(cursor, match.start), rule.replace);
    cursor = match.end;
  }
  pieces.push(input.slice(cursor));
  return pieces.join('');
}

function findMatches(input: string, find: string): RuleMatch[] {
  const normalized = normalizeInput(input);
  const findChars = Array.from(find.normalize('NFD'));
  if (findChars.length === 0) return [];

  const matches: RuleMatch[] = [];
  const firstScalar = findChars[0] ?? '';
  const candidateIndices = normalized.firstScalarIndices.get(firstScalar) ?? [];
  for (const index of candidateIndices) {
    if (index + findChars.length > normalized.chars.length) continue;
    if (!sameCodePoints(normalized.chars, index, findChars)) continue;
    if (!isSafeOriginalBoundary(normalized, index)) continue;
    if (!isSafeOriginalBoundary(normalized, index + findChars.length)) continue;

    const beforeIndex = index - 1;
    const afterIndex = index + findChars.length;
    const startEdge = wordEdge(findChars, 0, 1);
    const endEdge = wordEdge(findChars, findChars.length - 1, -1);
    if (
      isWordBoundary(startEdge, normalized.chars, beforeIndex, 1) ||
      isWordBoundary(endEdge, normalized.chars, afterIndex, -1)
    ) {
      continue;
    }

    matches.push({
      end: mapSafeBoundary(normalized, index + findChars.length),
      start: mapSafeBoundary(normalized, index),
    });
  }
  return matches;
}

function normalizeInput(input: string): NormalizedInput {
  const originalChars = Array.from(input);
  const originalPrefixLengths = originalChars.some(
    (char) => Array.from(char.normalize('NFD')).length > 1,
  )
    ? nfdPrefixLengths(originalChars)
    : null;
  const normalized = input.normalize('NFD');
  const chars = Array.from(normalized);
  const firstScalarIndices = new Map<string, number[]>();
  for (const [index, char] of chars.entries()) {
    const indices = firstScalarIndices.get(char);
    if (indices === undefined) firstScalarIndices.set(char, [index]);
    else indices.push(index);
  }
  return {
    chars,
    firstScalarIndices,
    originalBoundaries: originalCharBoundaries(originalChars),
    originalChars,
    originalPrefixLengths,
  };
}

function isSafeOriginalBoundary(normalized: NormalizedInput, normalizedIndex: number): boolean {
  if (normalizedIndex < 0 || normalizedIndex > normalized.chars.length) return false;
  if (
    normalized.originalPrefixLengths !== null &&
    !normalized.originalPrefixLengths.includes(normalizedIndex)
  ) {
    return false;
  }
  // Do not replace only the base of a decomposed canonical cluster. Doing so
  // would leave its combining mark behind as orphaned transcript text.
  return !isCombiningMark(normalized.originalChars[normalizedIndex] ?? '');
}

function mapSafeBoundary(normalized: NormalizedInput, normalizedIndex: number): number {
  if (normalized.originalPrefixLengths === null) {
    return (
      normalized.originalBoundaries[Math.min(normalized.originalChars.length, normalizedIndex)] ?? 0
    );
  }
  const scalarIndex = normalized.originalPrefixLengths.indexOf(normalizedIndex);
  return normalized.originalBoundaries[Math.max(0, scalarIndex)] ?? 0;
}

function wordEdge(chars: readonly string[], start: number, direction: 1 | -1): string | undefined {
  for (let index = start; index >= 0 && index < chars.length; index += direction) {
    const value = chars[index];
    if (value === undefined || !isCombiningMark(value)) return value;
  }
  return undefined;
}

function isWordBoundary(
  edge: string | undefined,
  adjacent: readonly string[],
  adjacentIndex: number,
  direction: 1 | -1,
): boolean {
  if (
    edge === undefined ||
    !isWordCharacter(edge) ||
    adjacentIndex < 0 ||
    adjacentIndex >= adjacent.length
  ) {
    return false;
  }
  let index = adjacentIndex;
  while (index >= 0 && index < adjacent.length && isCombiningMark(adjacent[index] ?? '')) {
    index += direction;
  }
  const value = adjacent[index];
  return value !== undefined && isWordCharacter(value);
}

function isWordCharacter(value: string): boolean {
  return /[\p{L}\p{N}_]/u.test(value);
}

function isCombiningMark(value: string): boolean {
  return /^[\p{Mn}\p{Mc}\p{Me}]$/u.test(value);
}

function sameCodePoints(
  input: readonly string[],
  start: number,
  expected: readonly string[],
): boolean {
  return expected.every((value, offset) => input[start + offset] === value);
}

function originalCharBoundaries(chars: readonly string[]): number[] {
  const boundaries = [0];
  let length = 0;
  for (const char of chars) {
    length += char.length;
    boundaries.push(length);
  }
  return boundaries;
}

function nfdPrefixLengths(chars: readonly string[]): number[] {
  const lengths = [0];
  let total = 0;
  for (const char of chars) {
    total += Array.from(char.normalize('NFD')).length;
    lengths.push(total);
  }
  return lengths;
}

function validateTextField(
  value: string,
  field: 'find' | 'replace',
  blankCode: 'blank_find' | 'blank_replace',
  oversizedCode: 'oversized_find' | 'oversized_replace',
  index: number,
  errors: PersonalCorrectionRuleValidationError[],
): void {
  if (value.trim().length === 0) {
    errors.push(
      validationError(
        blankCode,
        field,
        t(
          blankCode === 'blank_find'
            ? 'settings.corrections.validation.blankFind'
            : 'settings.corrections.validation.blankReplace',
        ),
        index,
      ),
    );
  } else if (unicodeLength(value) > PERSONAL_CORRECTION_RULE_MAX_CHARS) {
    errors.push(
      validationError(
        oversizedCode,
        field,
        t('settings.corrections.validation.oversized', {
          field: correctionFieldLabel(field),
          max: PERSONAL_CORRECTION_RULE_MAX_CHARS,
        }),
        index,
      ),
    );
  }
  if (hasLoneUtf16Surrogate(value)) {
    errors.push(
      validationError(
        'lone_surrogate',
        field,
        t('settings.corrections.validation.loneSurrogate'),
        index,
      ),
    );
  }
}

function withRuleContext(
  error: PersonalCorrectionRuleValidationError,
  index: number,
): PersonalCorrectionRuleValidationError {
  return {
    ...error,
    index,
    message: t('settings.corrections.validation.context', {
      field: correctionFieldLabel(error.field),
      index: index + 1,
      reason: error.message,
    }),
  };
}

function correctionFieldLabel(field: PersonalCorrectionRuleValidationError['field']): string {
  switch (field) {
    case 'enabled':
      return t('settings.corrections.field.enabled');
    case 'find':
      return t('settings.corrections.field.find');
    case 'id':
      return t('settings.corrections.field.id');
    case 'replace':
      return t('settings.corrections.field.replace');
    case 'rules':
      return t('settings.corrections.field.rules');
  }
}

function validationError(
  code: PersonalCorrectionRuleErrorCode,
  field: PersonalCorrectionRuleValidationError['field'],
  message: string,
  index?: number,
): PersonalCorrectionRuleValidationError {
  return index === undefined ? { code, field, message } : { code, field, index, message };
}

function hasLoneUtf16Surrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function unicodeLength(value: string): number {
  return Array.from(value).length;
}
