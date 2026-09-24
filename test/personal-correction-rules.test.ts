import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  applyPersonalCorrectionRules,
  compilePersonalCorrectionPreview,
  MAX_CORRECTION_OUTPUT_CHARS,
  PERSONAL_CORRECTION_RULE_MAX_CHARS,
  type PersonalCorrectionRule,
  validatePersonalCorrectionRules,
} from '../src/settings/personal-correction-rules';

function rule(
  find: string,
  replace: string,
  overrides: Partial<PersonalCorrectionRule> = {},
): PersonalCorrectionRule {
  return { enabled: true, find, id: `${find}-${replace}`, replace, ...overrides };
}

const golden = JSON.parse(
  readFileSync(new URL('./fixtures/personal-correction-golden.json', import.meta.url), 'utf8'),
) as {
  cases: Array<{
    errorCode?: string;
    expected: string | null;
    expectedSegments?: Array<{ text: string }>;
    id: string;
    input: string;
    replacements?: number;
    rules: PersonalCorrectionRule[];
    rulesApplied?: number;
  }>;
};

describe('personal correction rule semantics', () => {
  it('applies enabled rules in order with Unicode whole-word boundaries', () => {
    const preview = compilePersonalCorrectionPreview(
      [rule('cat', 'dog'), rule('dog', 'fox')],
      'cat concatenate cat cat_2 2cat',
    );

    expect(preview).toMatchObject({
      changed: true,
      output: 'fox concatenate fox cat_2 2cat',
      replacements: 4,
      rulesApplied: 2,
    });
  });

  it('matches canonical-equivalent NFD text while inserting replacement literally', () => {
    expect(applyPersonalCorrectionRules('cafe\u0301', [rule('café', 'coffee')])).toBe('coffee');
    expect(applyPersonalCorrectionRules('café', [rule('cafe\u0301', 'tea')])).toBe('tea');
    expect(applyPersonalCorrectionRules('cafe\u0301', [rule('cafe', 'tea')])).toBe('cafe\u0301');
    expect(applyPersonalCorrectionRules('é é', [rule('é', 'e')])).toBe('e e');
  });

  it('rejects blank, oversized, and duplicate drafts before compiling a preview', () => {
    const validation = validatePersonalCorrectionRules([
      rule(' ', 'value', { id: 'blank-find' }),
      rule('valid', ' ', { id: 'blank-replace' }),
      rule('x'.repeat(PERSONAL_CORRECTION_RULE_MAX_CHARS + 1), 'value', {
        id: 'oversized',
      }),
      rule('valid', 'other', { id: 'duplicate' }),
    ]);

    expect(validation.valid).toBe(false);
    expect(validation.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining(['blank_find', 'blank_replace', 'oversized_find', 'duplicate_find']),
    );
    expect(
      compilePersonalCorrectionPreview([rule(' ', 'value', { id: 'invalid-preview' })], 'anything'),
    ).toMatchObject({ ok: false, error: { code: 'blank_find' } });
  });

  it('rejects relative amplification before materializing ordered doubling cascades', () => {
    const rules = [
      rule('a', 'aa', { id: 'double-1' }),
      rule('aa', 'aaaa', { id: 'double-2' }),
      rule('aaaa', 'aaaaaaaa', { id: 'double-3' }),
      rule('aaaaaaaa', 'aaaaaaaaaaaaaaaa', { id: 'double-4' }),
    ];

    expect(() => applyPersonalCorrectionRules('a', rules)).toThrow(/more than 8×|expansion/);
  });

  it('reports amplification validation with the offending rule context', () => {
    const result = compilePersonalCorrectionPreview([rule('a', 'aaaaaaaaa')], 'a');
    expect(result).toMatchObject({
      error: { code: 'relative_amplification', index: 0 },
      ok: false,
    });
    if (!result.ok) expect(result.error.message).toContain('Rule 1');
  });

  it('rejects absolute amplification independently of the relative budget', () => {
    const input = 'a '.repeat(MAX_CORRECTION_OUTPUT_CHARS / 2);
    expect(compilePersonalCorrectionPreview([rule('a', 'aa')], input)).toMatchObject({
      error: { code: 'absolute_amplification' },
      ok: false,
    });
  });

  it('rejects missing enabled, duplicate IDs, and lone UTF-16 surrogates', () => {
    const validation = validatePersonalCorrectionRules([
      { find: 'a', id: '', replace: 'b' } as unknown as PersonalCorrectionRule,
      rule('a', 'b', { id: 'same' }),
      rule('c', 'd', { id: 'same' }),
      rule('e', '\ud800', { id: 'surrogate' }),
    ]);
    expect(validation.errors.map((error) => error.code)).toEqual(
      expect.arrayContaining(['invalid_enabled', 'blank_id', 'duplicate_id', 'lone_surrogate']),
    );
  });

  it('rejects partial canonical scalar matches without dropping combining marks', () => {
    expect(applyPersonalCorrectionRules('café cafe', [rule('cafe', 'tea')])).toBe('café tea');
    expect(applyPersonalCorrectionRules('cafe\u0301', [rule('cafe', 'tea')])).toBe('cafe\u0301');
  });

  it('does not apply disabled rules but keeps them in the ordered snapshot', () => {
    expect(
      applyPersonalCorrectionRules('hello', [rule('hello', 'goodbye', { enabled: false })]),
    ).toBe('hello');
  });

  it('matches the shared cross-language golden vectors', () => {
    for (const testCase of golden.cases) {
      if (testCase.id === 'metadata-and-segments') {
        const output = compilePersonalCorrectionPreview(testCase.rules, testCase.input);
        expect(output.ok).toBe(true);
        if (output.ok) expect(output.output.split(' ')).toEqual(['1', 'two']);
        continue;
      }
      const result = compilePersonalCorrectionPreview(testCase.rules, testCase.input);
      if (testCase.expected === null) {
        expect(result).toMatchObject({ ok: false, error: { code: testCase.errorCode } });
      } else {
        expect(result).toMatchObject({
          ok: true,
          output: testCase.expected,
          replacements: testCase.replacements,
          rulesApplied: testCase.rulesApplied,
        });
      }
    }
  });
});
