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
  | 'duplicate_id'
  | 'duplicate_find'
  | 'absolute_amplification'
  | 'relative_amplification';

export interface PersonalCorrectionRuleValidationError {
  code: PersonalCorrectionRuleErrorCode;
  field: 'find' | 'id' | 'replace' | 'rules';
  index?: number;
  message: string;
}

export interface PersonalCorrectionRulesValidation {
  errors: PersonalCorrectionRuleValidationError[];
  valid: boolean;
}

export interface PersonalCorrectionRuleApplication {
  matches: PersonalCorrectionRuleMatch[];
  outputLength: number;
}

export interface PersonalCorrectionRuleMatch {
  end: number;
  start: number;
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
    const id = rule.id.trim();
    if (id.length === 0) {
      errors.push(
        validationError('blank_id', 'id', t('settings.corrections.validation.blankId'), index),
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

    if (rule.find.trim().length === 0) {
      errors.push(
        validationError(
          'blank_find',
          'find',
          t('settings.corrections.validation.blankFind'),
          index,
        ),
      );
    } else if (unicodeLength(rule.find) > PERSONAL_CORRECTION_RULE_MAX_CHARS) {
      errors.push(
        validationError(
          'oversized_find',
          'find',
          t('settings.corrections.validation.oversized', {
            field: t('settings.corrections.field.find'),
            max: PERSONAL_CORRECTION_RULE_MAX_CHARS,
          }),
          index,
        ),
      );
    } else {
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

    if (rule.replace.trim().length === 0) {
      errors.push(
        validationError(
          'blank_replace',
          'replace',
          t('settings.corrections.validation.blankReplace'),
          index,
        ),
      );
    } else if (unicodeLength(rule.replace) > PERSONAL_CORRECTION_RULE_MAX_CHARS) {
      errors.push(
        validationError(
          'oversized_replace',
          'replace',
          t('settings.corrections.validation.oversized', {
            field: t('settings.corrections.field.replace'),
            max: PERSONAL_CORRECTION_RULE_MAX_CHARS,
          }),
          index,
        ),
      );
    }
  });

  return { errors, valid: errors.length === 0 };
}

export function normalizePersonalCorrectionRules(value: unknown): PersonalCorrectionRule[] {
  if (!Array.isArray(value)) return [];

  const ids = new Set<string>();
  const finds = new Set<string>();
  const normalized: PersonalCorrectionRule[] = [];
  for (const candidate of value) {
    if (!isPersonalCorrectionRule(candidate)) continue;
    const id = candidate.id.trim();
    const find = candidate.find.trim().length > 0 ? candidate.find : '';
    const findKey = find.normalize('NFD');
    if (
      id.length === 0 ||
      find.length === 0 ||
      candidate.replace.trim().length === 0 ||
      unicodeLength(find) > PERSONAL_CORRECTION_RULE_MAX_CHARS ||
      unicodeLength(candidate.replace) > PERSONAL_CORRECTION_RULE_MAX_CHARS ||
      ids.has(id) ||
      finds.has(findKey)
    ) {
      continue;
    }
    ids.add(id);
    finds.add(findKey);
    normalized.push({
      enabled: candidate.enabled,
      find: candidate.find,
      id,
      replace: candidate.replace,
    });
    if (normalized.length === PERSONAL_CORRECTION_RULE_MAX_COUNT) break;
  }
  return normalized;
}

export function compilePersonalCorrectionPreview(
  rules: readonly PersonalCorrectionRule[],
  input: string,
): PersonalCorrectionPreviewResult {
  const validation = validatePersonalCorrectionRules(rules);
  const firstError = validation.errors[0];
  if (firstError !== undefined) return { error: firstError, ok: false };

  const originalLength = unicodeLength(input);
  let output = input;
  let replacements = 0;
  let rulesApplied = 0;
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const application = preflightPersonalCorrectionRule(output, rule, originalLength);
    if (application.matches.length > 0) {
      output = materializePersonalCorrectionRule(output, rule, application.matches);
      replacements += application.matches.length;
      rulesApplied += 1;
    }
  }

  return {
    changed: output !== input,
    inputLength: unicodeLength(input),
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

export function preflightPersonalCorrectionRule(
  input: string,
  rule: PersonalCorrectionRule,
  cascadeInputLength = unicodeLength(input),
): PersonalCorrectionRuleApplication {
  const matches = findPersonalCorrectionMatches(input, rule.find);
  const inputLength = unicodeLength(input);
  const replaceLength = unicodeLength(rule.replace);
  const removed = matches.reduce(
    (total, match) => total + unicodeLength(input.slice(match.start, match.end)),
    0,
  );
  const added = replaceLength * matches.length;
  const outputLength = inputLength - removed + added;

  if (!Number.isSafeInteger(outputLength)) {
    throw new PersonalCorrectionRuleError(
      validationError(
        'absolute_amplification',
        'rules',
        t('settings.corrections.validation.absoluteAmplification', {
          max: MAX_CORRECTION_OUTPUT_CHARS,
        }),
      ),
    );
  }
  if (outputLength > MAX_CORRECTION_OUTPUT_CHARS) {
    throw new PersonalCorrectionRuleError(
      validationError(
        'absolute_amplification',
        'rules',
        t('settings.corrections.validation.absoluteAmplification', {
          max: MAX_CORRECTION_OUTPUT_CHARS,
        }),
      ),
    );
  }
  const relativeLimit = Math.ceil(cascadeInputLength * MAX_CORRECTION_AMPLIFICATION);
  if (cascadeInputLength > 0 && outputLength > relativeLimit) {
    throw new PersonalCorrectionRuleError(
      validationError(
        'relative_amplification',
        'rules',
        t('settings.corrections.validation.relativeAmplification', {
          max: MAX_CORRECTION_AMPLIFICATION,
        }),
      ),
    );
  }

  return { matches, outputLength };
}

export function materializePersonalCorrectionRule(
  input: string,
  rule: PersonalCorrectionRule,
  matches: readonly PersonalCorrectionRuleMatch[],
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

export function isPersonalCorrectionRule(value: unknown): value is PersonalCorrectionRule {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.enabled === 'boolean' &&
    typeof record.find === 'string' &&
    typeof record.id === 'string' &&
    typeof record.replace === 'string'
  );
}

function findPersonalCorrectionMatches(input: string, find: string): PersonalCorrectionRuleMatch[] {
  const normalizedInput = input.normalize('NFD');
  const normalizedFind = find.normalize('NFD');
  const inputChars = Array.from(normalizedInput);
  const findChars = Array.from(normalizedFind);
  const originalChars = Array.from(input);
  const originalBoundaries = originalCharBoundaries(originalChars);
  const matches: PersonalCorrectionRuleMatch[] = [];

  for (let index = 0; index + findChars.length <= inputChars.length; ) {
    if (!sameCodePoints(inputChars, index, findChars)) {
      index += 1;
      continue;
    }
    const beforeIndex = index - 1;
    const afterIndex = index + findChars.length;
    const startEdge = wordEdge(findChars, 0, 1);
    const endEdge = wordEdge(findChars, findChars.length - 1, -1);
    if (
      isWordBoundary(startEdge, inputChars, beforeIndex, 1) ||
      isWordBoundary(endEdge, inputChars, afterIndex, -1)
    ) {
      index += 1;
      continue;
    }

    const start = mapNormalizedBoundary(
      originalChars,
      originalBoundaries,
      index,
      inputChars.length,
    );
    const end = mapNormalizedBoundary(
      originalChars,
      originalBoundaries,
      afterIndex,
      inputChars.length,
    );
    matches.push({ end, start });
    index = afterIndex;
  }
  return matches;
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

function mapNormalizedBoundary(
  originalChars: readonly string[],
  originalBoundaries: readonly number[],
  normalizedIndex: number,
  normalizedLength: number,
): number {
  if (normalizedLength === originalChars.length) {
    return originalBoundaries[Math.min(originalChars.length, normalizedIndex)] ?? 0;
  }
  const approximate = Math.min(originalChars.length, Math.max(0, normalizedIndex));
  const start = Math.max(0, approximate - 8);
  const end = Math.min(originalChars.length, approximate + 9);
  let fallback = originalBoundaries[approximate] ?? 0;
  for (let candidate = start; candidate <= end; candidate += 1) {
    const prefix = originalChars.slice(0, candidate).join('').normalize('NFD');
    const prefixLength = Array.from(prefix).length;
    if (prefixLength === normalizedIndex) {
      fallback = originalBoundaries[candidate] ?? fallback;
      if (candidate === approximate) return fallback;
    }
  }
  return fallback;
}

function validationError(
  code: PersonalCorrectionRuleErrorCode,
  field: PersonalCorrectionRuleValidationError['field'],
  message: string,
  index?: number,
): PersonalCorrectionRuleValidationError {
  return index === undefined ? { code, field, message } : { code, field, index, message };
}

function unicodeLength(value: string): number {
  return Array.from(value).length;
}
