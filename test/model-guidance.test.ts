import { describe, expect, it } from 'vitest';

import { formatModelTagLabel } from '../src/models/model-guidance';

describe('formatModelTagLabel', () => {
  it('uses a readable localized label for the license review tag', () => {
    expect(formatModelTagLabel('requires-terms-review')).toBe('License terms');
  });

  it('formats hardware abbreviations and readable fallback labels', () => {
    expect(formatModelTagLabel('cpu')).toBe('CPU');
    expect(formatModelTagLabel('full-precision')).toBe('Full precision');
    expect(formatModelTagLabel('gpu')).toBe('GPU');
    expect(formatModelTagLabel('reduced-size')).toBe('Reduced size');
    expect(formatModelTagLabel('balanced')).toBe('Balanced');
  });
});
