import { describe, expect, it } from 'vitest';

import {
  buildQualityReport,
  parseQualityMeasurements,
  renderQualityReportMarkdown,
} from '../scripts/lib/transcription-quality-report.mjs';

function measurement(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    suite: 'multilingual-product-path',
    modelId: 'model',
    modelName: 'Model',
    language: 'es',
    selection: 'manual',
    fixtureId: 'fixture',
    qualityMetric: 'wer',
    qualityErrorRate: 0.1,
    qualityBudget: 0.45,
    audioDurationMs: 2_000,
    processingDurationMs: 500,
    realTimeFactor: 0.25,
    realTimeFactorBudget: 1,
    passed: true,
    ...overrides,
  };
}

describe('transcription quality report', () => {
  it('separates host comparisons and rejects duplicate cases within the same context', () => {
    const first = measurement({ environmentSource: 'linux/run.environment.json' });
    const second = measurement({
      environmentSource: 'mac/run.environment.json',
      processingDurationMs: 1000,
      realTimeFactor: 0.5,
    });
    const report = buildQualityReport([first, second]);
    expect(report.rows).toHaveLength(2);
    expect(report.rows.map((row) => row.environmentSource)).toEqual([
      'linux/run.environment.json',
      'mac/run.environment.json',
    ]);
    expect(report.rows.map((row) => row.realTimeFactor)).toEqual([0.25, 0.5]);
    const markdown = renderQualityReportMarkdown(report);
    expect(markdown).toContain('linux/run.environment.json');
    expect(markdown).toContain('mac/run.environment.json');
    expect(() => buildQualityReport([first, first])).toThrow('duplicate measurement');
  });

  it('retains auditable case evidence without imposing language or hardware claims', () => {
    const record = measurement({
      schemaVersion: 2,
      qualityErrorRate: 0.75,
      qualityBudget: 0.8,
      evidence: {
        reference: 'At 4,892 m.',
        hypothesis: 'At 4892 meters.',
        scoredReference: 'at 4 892 m',
        scoredHypothesis: 'at 4892 meters',
        normalization: 'unicode-alphanumeric-lowercase-v1',
        fixture: { sha256: 'a'.repeat(64), manifest: 'tests/fixtures/long-german.json' },
        model: {
          modelId: 'model',
          sourceUrl: 'https://example.com/pinned',
          license: 'Apache-2.0',
          artifacts: [
            {
              filename: 'model.bin',
              downloadUrl: 'https://example.com/model.bin',
              expectedSha256: 'b'.repeat(64),
              expectedSizeBytes: 10,
              actualSha256: 'c'.repeat(64),
              actualSizeBytes: 11,
            },
          ],
        },
        correctness: { stopped: true, errors: [] },
      },
    });
    const parsed = parseQualityMeasurements(`${JSON.stringify(record)}\n`);
    const report = buildQualityReport(parsed);
    expect(report.measurements[0]?.evidence).toMatchObject({
      reference: 'At 4,892 m.',
      hypothesis: 'At 4892 meters.',
      scoredReference: 'at 4 892 m',
      scoredHypothesis: 'at 4892 meters',
      normalization: 'unicode-alphanumeric-lowercase-v1',
    });
    const markdown = renderQualityReportMarkdown(report);
    expect(markdown).toContain('At 4,892 m.');
    expect(markdown).toContain('At 4892 meters.');
    expect(markdown).toContain('unicode-alphanumeric-lowercase-v1');
    expect(markdown).toContain('not a universal model adoption threshold');
    expect(markdown).toContain('artifacts that differ from the nominal catalog model');
    expect(markdown).not.toContain('Measurements are CPU-only');
    expect(markdown).not.toContain('seven non-English');
    expect(() =>
      parseQualityMeasurements(JSON.stringify({ ...record, qualityErrorRate: 0.1 })),
    ).toThrow('score does not match');
  });

  it('aggregates processing-weighted RTF and renders release-readable definitions', () => {
    const report = buildQualityReport([
      measurement(),
      measurement({
        audioDurationMs: 1_000,
        fixtureId: 'fixture-2',
        processingDurationMs: 500,
        qualityErrorRate: 0.2,
      }),
    ]);

    expect(report.rows[0]).toMatchObject({
      fixtureCount: 2,
      maxErrorRate: 0.2,
      maxRealTimeFactorBudget: 1,
      realTimeFactor: 1 / 3,
    });
    expect(report.rows[0]?.meanErrorRate).toBeCloseTo(0.15);
    const markdown = renderQualityReportMarkdown(report);
    expect(markdown).toContain('15.0% / 20.0% WER');
    expect(markdown).toContain('0.33× / ≤ 1.00×');
    expect(markdown).toContain('RTF is model processing time divided by fixture audio duration');
    expect(markdown).toContain('pinned Google FLEURS validation recordings');
    expect(markdown).toContain('not a substitute for broader native-speaker review');
    expect(markdown).toContain('hosted-CPU timing budget is a portable regression ceiling');
  });

  it('rejects malformed and duplicate measurements instead of hiding bad evidence', () => {
    expect(() => parseQualityMeasurements('{"schemaVersion":1}\n')).toThrow('missing suite');
    expect(() =>
      parseQualityMeasurements(
        `${JSON.stringify(measurement({ realTimeFactor: 0.5 }))}\n`,
        'invalid.jsonl',
      ),
    ).toThrow('realTimeFactor does not match measured durations');
    expect(() =>
      parseQualityMeasurements(
        `${JSON.stringify(measurement({ qualityErrorRate: 0.6 }))}\n`,
        'invalid.jsonl',
      ),
    ).toThrow('passed measurement exceeds an acceptance budget');
    expect(() => buildQualityReport([measurement(), measurement()])).toThrow(
      'duplicate measurement',
    );
  });
});
