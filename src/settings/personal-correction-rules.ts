import { t } from '../shared/i18n';

export const PERSONAL_CORRECTION_RULE_MAX_COUNT = 100;
export const PERSONAL_CORRECTION_RULE_MAX_CHARS = 256;
export const MAX_CORRECTION_OUTPUT_CHARS = 1_000_000;
export const MAX_CORRECTION_INPUT_CHARS = 1_000_000;
export const MAX_CORRECTION_AMPLIFICATION = 8;
export const MAX_CORRECTION_NORMALIZED_SCAN_CHARS = 2_000_000;
export const MAX_CORRECTION_SEARCH_STEPS = 4_000_000;

export type PersonalCorrectionRuleInput =
  | Record<string, unknown>
  | readonly unknown[]
  | null
  | string
  | number
  | boolean
  | undefined;

export interface PersonalCorrectionRule {
  enabled: boolean;
  find: string;
  id: string;
  replace: string;
}

export type PersonalCorrectionRuleErrorCode =
  | 'invalid_rule'
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
  | 'work_budget'
  | 'absolute_amplification'
  | 'relative_amplification';

export interface PersonalCorrectionRuleValidationError {
  code: PersonalCorrectionRuleErrorCode;
  field: 'enabled' | 'find' | 'id' | 'replace' | 'rules';
  index?: number;
  message: string;
}

export interface PersonalCorrectionRuleDiagnostic {
  code: PersonalCorrectionRuleErrorCode;
  field: PersonalCorrectionRuleValidationError['field'];
  index: number;
  message: string;
  raw: unknown;
}

export interface PersonalCorrectionRulesValidation {
  errors: PersonalCorrectionRuleValidationError[];
  rules: PersonalCorrectionRule[];
  valid: boolean;
}

export interface NormalizedPersonalCorrectionRules {
  diagnostics: PersonalCorrectionRuleDiagnostic[];
  rules: PersonalCorrectionRule[];
}

export type PersonalCorrectionRuleDraft =
  | PersonalCorrectionRule
  | PersonalCorrectionRuleInput
  | InvalidRuleDraft;

export interface InvalidRuleDraft {
  diagnostic: PersonalCorrectionRuleDiagnostic;
  invalid: true;
  raw: unknown;
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

/** Validate raw persisted/draft input without coercing invalid values. */
export function validatePersonalCorrectionRules(
  rules: readonly unknown[],
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
  const validatedRules: PersonalCorrectionRule[] = [];
  rules.forEach((rawRule, index) => {
    if (!isRecord(rawRule)) {
      errors.push(
        validationError(
          'invalid_rule',
          'rules',
          t('settings.corrections.validation.invalidRule'),
          index,
        ),
      );
      return;
    }

    const ruleErrors: PersonalCorrectionRuleValidationError[] = [];
    const id = typeof rawRule.id === 'string' ? rawRule.id.trim() : '';
    if (typeof rawRule.id !== 'string') {
      ruleErrors.push(
        validationError('invalid_id', 'id', t('settings.corrections.validation.invalidId'), index),
      );
    } else if (id.length === 0) {
      ruleErrors.push(
        validationError('blank_id', 'id', t('settings.corrections.validation.blankId'), index),
      );
    } else if (unicodeLength(id) > PERSONAL_CORRECTION_RULE_MAX_CHARS) {
      ruleErrors.push(
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
      ruleErrors.push(
        validationError(
          'lone_surrogate',
          'id',
          t('settings.corrections.validation.loneSurrogate'),
          index,
        ),
      );
    } else if (ids.has(id)) {
      ruleErrors.push(
        validationError(
          'duplicate_id',
          'id',
          t('settings.corrections.validation.duplicateId'),
          index,
        ),
      );
    }

    if (
      typeof rawRule.id === 'string' &&
      id.length > 0 &&
      unicodeLength(id) <= PERSONAL_CORRECTION_RULE_MAX_CHARS &&
      !hasLoneUtf16Surrogate(id)
    ) {
      ids.add(id);
    }

    if (typeof rawRule.enabled !== 'boolean') {
      ruleErrors.push(
        validationError(
          'invalid_enabled',
          'enabled',
          t('settings.corrections.validation.invalidEnabled'),
          index,
        ),
      );
    }

    let normalizedFind: string | undefined;
    if (typeof rawRule.find !== 'string') {
      ruleErrors.push(
        validationError(
          'invalid_find',
          'find',
          t('settings.corrections.validation.invalidFind'),
          index,
        ),
      );
    } else {
      validateTextField(rawRule.find, 'find', 'blank_find', 'oversized_find', index, ruleErrors);
      if (
        rawRule.find.trim().length > 0 &&
        unicodeLength(rawRule.find) <= PERSONAL_CORRECTION_RULE_MAX_CHARS &&
        !hasLoneUtf16Surrogate(rawRule.find)
      ) {
        normalizedFind = rawRule.find.normalize('NFD');
        if (finds.has(normalizedFind)) {
          ruleErrors.push(
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

    if (typeof rawRule.replace !== 'string') {
      ruleErrors.push(
        validationError(
          'invalid_replace',
          'replace',
          t('settings.corrections.validation.invalidReplace'),
          index,
        ),
      );
    } else {
      validateTextField(
        rawRule.replace,
        'replace',
        'blank_replace',
        'oversized_replace',
        index,
        ruleErrors,
      );
    }

    errors.push(...ruleErrors);
    if (ruleErrors.length === 0 && normalizedFind !== undefined) {
      ids.add(id);
      finds.add(normalizedFind);
      validatedRules.push(toPersonalCorrectionRule(rawRule));
    }
  });

  return { errors, rules: validatedRules, valid: errors.length === 0 };
}

/**
 * Partition persisted raw input into active validated rules and diagnostics.
 * Invalid entries are not silently discarded: their raw values and validation
 * context are retained so settings can explain what needs repair.
 */
export function readPersonalCorrectionRuleDiagnostics(
  value: unknown,
): PersonalCorrectionRuleDiagnostic[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    if (!Object.hasOwn(entry, 'raw')) return [];
    if (
      !isPersonalCorrectionRuleErrorCode(entry.code) ||
      !isPersonalCorrectionRuleField(entry.field) ||
      typeof entry.index !== 'number' ||
      !Number.isInteger(entry.index) ||
      entry.index < 0 ||
      typeof entry.message !== 'string'
    ) {
      return [];
    }
    return [
      {
        code: entry.code,
        field: entry.field,
        index: entry.index,
        message: entry.message,
        raw: entry.raw,
      },
    ];
  });
}

export function normalizePersonalCorrectionRules(
  value: unknown,
): NormalizedPersonalCorrectionRules {
  if (value === undefined) return { diagnostics: [], rules: [] };
  if (!Array.isArray(value)) {
    return {
      diagnostics: [
        {
          code: 'invalid_rule',
          field: 'rules',
          index: 0,
          message: t('settings.corrections.validation.invalidRule'),
          raw: value,
        },
      ],
      rules: [],
    };
  }

  const diagnostics: PersonalCorrectionRuleDiagnostic[] = [];
  const rules: PersonalCorrectionRule[] = [];
  const ids = new Set<string>();
  const finds = new Set<string>();
  value.forEach((raw, index) => {
    if (!isRecord(raw)) {
      diagnostics.push({
        code: 'invalid_rule',
        field: 'rules',
        index,
        message: t('settings.corrections.validation.invalidRule'),
        raw,
      });
      return;
    }

    const validation = validatePersonalCorrectionRules([raw]);
    const firstError = validation.errors[0];
    if (!validation.valid || firstError !== undefined) {
      diagnostics.push({
        code: firstError?.code ?? 'invalid_rule',
        field: firstError?.field ?? 'rules',
        index,
        message: firstError?.message ?? t('settings.corrections.validation.invalidRule'),
        raw,
      });
      return;
    }

    const rule = validation.rules[0];
    if (rule === undefined) {
      diagnostics.push({
        code: 'invalid_rule',
        field: 'rules',
        index,
        message: t('settings.corrections.validation.invalidRule'),
        raw,
      });
      return;
    }
    const id = rule.id;
    const find = rule.find.normalize('NFD');
    if (ids.has(id) || finds.has(find)) {
      diagnostics.push({
        code: ids.has(id) ? 'duplicate_id' : 'duplicate_find',
        field: ids.has(id) ? 'id' : 'find',
        index,
        message: ids.has(id)
          ? t('settings.corrections.validation.duplicateId')
          : t('settings.corrections.validation.duplicateFind'),
        raw,
      });
      return;
    }
    ids.add(id);
    finds.add(find);
    rules.push(rule);
  });

  return { diagnostics, rules };
}

export function compilePersonalCorrectionPreview(
  rules: readonly unknown[],
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

  const validatedRules = validation.rules;
  const originalLength = unicodeLength(input);
  const budget = new CorrectionWorkBudget();
  let output = input;
  let replacements = 0;
  let rulesApplied = 0;
  for (const [index, rule] of validatedRules.entries()) {
    if (!rule.enabled) continue;
    const application = preflightRule(output, rule, originalLength, budget);
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

type RuleApplication = { matches: RuleMatch[] };
type RuleApplicationResult =
  | { application: RuleApplication; ok: true }
  | { error: PersonalCorrectionRuleValidationError; ok: false };

class CorrectionWorkBudget {
  private normalizedChars = 0;
  private searchSteps = 0;

  addNormalized(count: number): PersonalCorrectionRuleValidationError | null {
    const next = this.normalizedChars + count;
    if (!Number.isSafeInteger(next) || next > MAX_CORRECTION_NORMALIZED_SCAN_CHARS) {
      return workBudgetError(MAX_CORRECTION_NORMALIZED_SCAN_CHARS);
    }
    this.normalizedChars = next;
    return null;
  }

  addSearchWork(
    candidateCount: number,
    normalizedFindLength: number,
  ): PersonalCorrectionRuleValidationError | null {
    const comparisonWork = checkedMultiply(candidateCount, normalizedFindLength);
    const boundaryWork = checkedMultiply(candidateCount, 2);
    if (comparisonWork === null || boundaryWork === null)
      return workBudgetError(MAX_CORRECTION_SEARCH_STEPS);
    const next = this.searchSteps + comparisonWork + boundaryWork;
    if (!Number.isSafeInteger(next) || next > MAX_CORRECTION_SEARCH_STEPS) {
      return workBudgetError(MAX_CORRECTION_SEARCH_STEPS);
    }
    this.searchSteps = next;
    return null;
  }
}

type RuleMatch = { end: number; start: number };

type NormalizedInput = {
  boundaryMap: Array<number | undefined>;
  chars: string[];
  firstScalarIndices: Map<string, number[]>;
  nextWordBoundary: boolean[];
  previousWordBoundary: boolean[];
  safeBoundaries: boolean[];
};

function preflightRule(
  input: string,
  rule: PersonalCorrectionRule,
  cascadeInputLength: number,
  budget: CorrectionWorkBudget,
): RuleApplicationResult {
  const scan = findMatches(input, rule.find, budget);
  if (!scan.ok) return scan;
  const matches = scan.application.matches;
  const inputLength = unicodeLength(input);
  const replaceLength = unicodeLength(rule.replace);
  let removed = 0;
  for (const match of matches) {
    removed += unicodeLength(input.slice(match.start, match.end));
  }
  if (removed > inputLength) {
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
  const outputLength = inputLength - removed + replaceLength * matches.length;
  if (!Number.isSafeInteger(outputLength) || outputLength < 0) {
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
  if (outputLength > MAX_CORRECTION_OUTPUT_CHARS) {
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

function findMatches(
  input: string,
  find: string,
  budget: CorrectionWorkBudget,
): RuleApplicationResult {
  const normalizedResult = normalizeInput(input, budget);
  if (!normalizedResult.ok) return normalizedResult;
  const normalized = normalizedResult.normalized;
  const findChars = Array.from(find.normalize('NFD'));
  if (findChars.length === 0) return { application: { matches: [] }, ok: true };

  const firstScalar = findChars[0] ?? '';
  const candidateIndices = normalized.firstScalarIndices.get(firstScalar) ?? [];
  const workError = budget.addSearchWork(candidateIndices.length, findChars.length);
  if (workError !== null) return { error: workError, ok: false };

  const matches: RuleMatch[] = [];
  let nextAllowedStart = 0;
  for (const index of candidateIndices) {
    if (index < nextAllowedStart) continue;
    if (index + findChars.length > normalized.chars.length) continue;
    if (!sameCodePoints(normalized.chars, index, findChars)) continue;
    if (!normalized.safeBoundaries[index] || !normalized.safeBoundaries[index + findChars.length]) {
      continue;
    }

    const afterIndex = index + findChars.length;
    const startEdge = wordEdge(findChars, 0, 1);
    const endEdge = wordEdge(findChars, findChars.length - 1, -1);
    if (
      isWordBoundary(startEdge, normalized.previousWordBoundary, index) ||
      isWordBoundary(endEdge, normalized.nextWordBoundary, afterIndex)
    ) {
      continue;
    }

    const start = normalized.boundaryMap[index];
    const end = normalized.boundaryMap[index + findChars.length];
    if (start === undefined || end === undefined) continue;
    matches.push({ end, start });
    nextAllowedStart = index + findChars.length;
  }
  return { application: { matches }, ok: true };
}

type NormalizedInputResult =
  | { normalized: NormalizedInput; ok: true }
  | { error: PersonalCorrectionRuleValidationError; ok: false };

function normalizeInput(input: string, budget: CorrectionWorkBudget): NormalizedInputResult {
  if (unicodeLength(input) > MAX_CORRECTION_INPUT_CHARS) {
    return { error: workBudgetError(MAX_CORRECTION_INPUT_CHARS), ok: false };
  }
  const originalChars = Array.from(input);
  const normalized = input.normalize('NFD');
  const chars = Array.from(normalized);
  const normalizedError = budget.addNormalized(chars.length);
  if (normalizedError !== null) return { error: normalizedError, ok: false };
  const boundaryMap: Array<number | undefined> = Array.from(
    { length: chars.length + 1 },
    () => undefined,
  );
  const safeBoundaries: boolean[] = Array.from({ length: chars.length + 1 }, () => false);
  const firstScalarIndices = new Map<string, number[]>();
  const previousWordBoundary = Array.from({ length: chars.length + 1 }, () => false);
  const nextWordBoundary = Array.from({ length: chars.length + 1 }, () => false);
  let normalizedIndex = 0;
  let byteIndex = 0;
  for (const originalChar of originalChars) {
    const expansion = Array.from(originalChar.normalize('NFD'));
    const isCombining = isCombiningMark(originalChar);
    boundaryMap[normalizedIndex] = byteIndex;
    safeBoundaries[normalizedIndex] = !isCombining;
    for (let offset = 1; offset < expansion.length; offset += 1) {
      safeBoundaries[normalizedIndex + offset] = false;
    }
    const endBoundary = normalizedIndex + expansion.length;
    boundaryMap[endBoundary] = byteIndex + originalChar.length;
    safeBoundaries[endBoundary] = !isCombining;
    normalizedIndex += expansion.length;
    byteIndex += originalChar.length;
    for (let offset = 0; offset < expansion.length; offset += 1) {
      const index = normalizedIndex - expansion.length + offset;
      const indices = firstScalarIndices.get(expansion[offset] ?? '');
      if (indices === undefined) firstScalarIndices.set(expansion[offset] ?? '', [index]);
      else indices.push(index);
    }
  }
  boundaryMap[chars.length] = byteIndex;
  safeBoundaries[chars.length] = true;
  for (let index = 0; index < chars.length; index += 1) {
    previousWordBoundary[index + 1] = isCombiningMark(chars[index] ?? '')
      ? previousWordBoundary[index] === true
      : isWordCharacter(chars[index] ?? '');
  }
  for (let index = chars.length - 1; index >= 0; index -= 1) {
    nextWordBoundary[index] = isCombiningMark(chars[index] ?? '')
      ? nextWordBoundary[index + 1] === true
      : isWordCharacter(chars[index] ?? '');
  }
  return {
    normalized: {
      boundaryMap,
      chars,
      firstScalarIndices,
      nextWordBoundary,
      previousWordBoundary,
      safeBoundaries,
    },
    ok: true,
  };
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
  adjacentWordBoundary: readonly boolean[],
  boundaryIndex: number,
): boolean {
  return (
    edge !== undefined &&
    isWordCharacter(edge) &&
    boundaryIndex >= 0 &&
    boundaryIndex < adjacentWordBoundary.length &&
    adjacentWordBoundary[boundaryIndex] === true
  );
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

function checkedMultiply(left: number, right: number): number | null {
  const product = left * right;
  return Number.isSafeInteger(product) ? product : null;
}

function workBudgetError(max: number): PersonalCorrectionRuleValidationError {
  return validationError(
    'work_budget',
    'rules',
    t('settings.corrections.validation.workBudget', { max }),
  );
}

function validationError(
  code: PersonalCorrectionRuleErrorCode,
  field: PersonalCorrectionRuleValidationError['field'],
  message: string,
  index?: number,
): PersonalCorrectionRuleValidationError {
  return index === undefined ? { code, field, message } : { code, field, index, message };
}

function toPersonalCorrectionRule(raw: Record<string, unknown>): PersonalCorrectionRule {
  if (
    typeof raw.enabled !== 'boolean' ||
    typeof raw.find !== 'string' ||
    typeof raw.id !== 'string' ||
    typeof raw.replace !== 'string'
  ) {
    throw new Error('validated correction rule has an invalid shape');
  }
  return {
    ...raw,
    enabled: raw.enabled,
    find: raw.find,
    id: raw.id.trim(),
    replace: raw.replace,
  };
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

const PERSONAL_CORRECTION_RULE_ERROR_CODES: readonly PersonalCorrectionRuleErrorCode[] = [
  'invalid_rule',
  'too_many_rules',
  'blank_find',
  'blank_replace',
  'oversized_find',
  'oversized_replace',
  'blank_id',
  'oversized_id',
  'invalid_id',
  'invalid_enabled',
  'invalid_find',
  'invalid_replace',
  'duplicate_id',
  'duplicate_find',
  'lone_surrogate',
  'work_budget',
  'absolute_amplification',
  'relative_amplification',
];

function isPersonalCorrectionRuleErrorCode(
  value: unknown,
): value is PersonalCorrectionRuleErrorCode {
  return (
    typeof value === 'string' && PERSONAL_CORRECTION_RULE_ERROR_CODES.some((code) => code === value)
  );
}

function isPersonalCorrectionRuleField(
  value: unknown,
): value is PersonalCorrectionRuleValidationError['field'] {
  return (
    value === 'enabled' ||
    value === 'find' ||
    value === 'id' ||
    value === 'replace' ||
    value === 'rules'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unicodeLength(value: string): number {
  return Array.from(value).length;
}
