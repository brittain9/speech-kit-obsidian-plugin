import { describe, expect, it } from 'vitest';

import {
  applyPersonalCorrectionRules,
  compilePersonalCorrectionPreview,
  MAX_CORRECTION_OUTPUT_CHARS,
  PERSONAL_CORRECTION_RULE_MAX_CHARS,
  type PersonalCorrectionRule,
  preflightPersonalCorrectionRule,
  validatePersonalCorrectionRules,
} from '../src/settings/personal-correction-rules';

function rule(
  find: string,
  replace: string,
  overrides: Partial<PersonalCorrectionRule> = {},
): PersonalCorrectionRule {
  return { enabled: true, find, id: `${find}-${replace}`, replace, ...overrides };
}

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

  it('rejects absolute amplification independently of the relative budget', () => {
    const input = 'a '.repeat(MAX_CORRECTION_OUTPUT_CHARS / 2);
    expect(() => preflightPersonalCorrectionRule(input, rule('a', 'aa'))).toThrow(
      /1000000-character/,
    );
  });

  it('does not apply disabled rules but keeps them in the ordered snapshot', () => {
    expect(
      applyPersonalCorrectionRules('hello', [rule('hello', 'goodbye', { enabled: false })]),
    ).toBe('hello');
  });
});
