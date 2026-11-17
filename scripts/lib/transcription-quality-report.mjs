const LANGUAGE_LABELS = {
  de: 'German',
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  it: 'Italian',
  ja: 'Japanese',
  nl: 'Dutch',
  pt: 'Portuguese',
};

const REQUIRED_FIELDS = [
  'schemaVersion',
  'suite',
  'modelId',
  'modelName',
  'language',
  'selection',
  'fixtureId',
  'qualityMetric',
  'qualityErrorRate',
  'qualityBudget',
  'audioDurationMs',
  'processingDurationMs',
  'realTimeFactor',
  'realTimeFactorBudget',
  'passed',
];

const STRING_FIELDS = [
  'suite',
  'modelId',
  'modelName',
  'language',
  'selection',
  'fixtureId',
  'qualityMetric',
];

const NON_NEGATIVE_NUMBER_FIELDS = [
  'qualityErrorRate',
  'qualityBudget',
  'audioDurationMs',
  'processingDurationMs',
  'realTimeFactor',
  'realTimeFactorBudget',
];

export function parseQualityMeasurements(text, source = 'measurements.jsonl') {
  return text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      let measurement;
      try {
        measurement = JSON.parse(line);
      } catch (error) {
        throw new Error(`${source}:${index + 1}: invalid JSON: ${error.message}`);
      }
      for (const field of REQUIRED_FIELDS) {
        if (!(field in measurement)) {
          throw new Error(`${source}:${index + 1}: missing ${field}`);
        }
      }
      if (![1, 2].includes(measurement.schemaVersion)) {
        throw new Error(
          `${source}:${index + 1}: unsupported schemaVersion ${measurement.schemaVersion}`,
        );
      }
      if (measurement.schemaVersion === 2) validateEvidence(measurement, `${source}:${index + 1}`);
      for (const field of STRING_FIELDS) {
        if (typeof measurement[field] !== 'string' || measurement[field].trim().length === 0) {
          throw new Error(`${source}:${index + 1}: ${field} must be a non-empty string`);
        }
      }
      for (const field of NON_NEGATIVE_NUMBER_FIELDS) {
        if (typeof measurement[field] !== 'number' || !Number.isFinite(measurement[field])) {
          throw new Error(`${source}:${index + 1}: ${field} must be a finite number`);
        }
        if (measurement[field] < 0) {
          throw new Error(`${source}:${index + 1}: ${field} must not be negative`);
        }
      }
      if (measurement.audioDurationMs <= 0) {
        throw new Error(`${source}:${index + 1}: audioDurationMs must be greater than zero`);
      }
      if (measurement.qualityBudget <= 0 || measurement.realTimeFactorBudget <= 0) {
        throw new Error(`${source}:${index + 1}: acceptance budgets must be greater than zero`);
      }
      if (typeof measurement.passed !== 'boolean') {
        throw new Error(`${source}:${index + 1}: passed must be a boolean`);
      }
      for (const field of ['firstPartialAudioMs', 'firstPartialAudioBudgetMs']) {
        if (
          measurement[field] !== undefined &&
          (typeof measurement[field] !== 'number' ||
            !Number.isFinite(measurement[field]) ||
            measurement[field] < 0)
        ) {
          throw new Error(`${source}:${index + 1}: ${field} must be a non-negative number`);
        }
      }
      if (
        measurement.firstPartialAudioBudgetMs !== undefined &&
        measurement.firstPartialAudioMs === undefined
      ) {
        throw new Error(
          `${source}:${index + 1}: firstPartialAudioMs is required when its budget is present`,
        );
      }
      const derivedRealTimeFactor = measurement.processingDurationMs / measurement.audioDurationMs;
      if (Math.abs(measurement.realTimeFactor - derivedRealTimeFactor) > 1e-9) {
        throw new Error(`${source}:${index + 1}: realTimeFactor does not match measured durations`);
      }
      if (
        measurement.passed &&
        (measurement.qualityErrorRate > measurement.qualityBudget ||
          measurement.realTimeFactor > measurement.realTimeFactorBudget ||
          (measurement.firstPartialAudioBudgetMs !== undefined &&
            measurement.firstPartialAudioMs > measurement.firstPartialAudioBudgetMs))
      ) {
        throw new Error(`${source}:${index + 1}: passed measurement exceeds an acceptance budget`);
      }
      return measurement;
    });
}

function validateEvidence(measurement, source) {
  const evidence = measurement.evidence;
  if (
    !evidence ||
    ['reference', 'hypothesis', 'scoredReference', 'scoredHypothesis', 'normalization'].some(
      (field) => typeof evidence[field] !== 'string',
    ) ||
    !evidence.normalization
  ) {
    throw new Error(`${source}: version 2 requires exact text and scoring evidence`);
  }
  if (
    !/^[a-f0-9]{64}$/iu.test(evidence.fixture?.sha256 ?? '') ||
    typeof evidence.fixture?.manifest !== 'string' ||
    !evidence.fixture.manifest
  ) {
    throw new Error(`${source}: version 2 requires fixture provenance`);
  }
  const model = evidence.model;
  if (
    !model ||
    model.modelId !== measurement.modelId ||
    !model.sourceUrl ||
    !model.license ||
    !Array.isArray(model.artifacts) ||
    model.artifacts.length === 0 ||
    model.artifacts.some(
      (artifact) =>
        !artifact.filename ||
        !artifact.downloadUrl ||
        !/^[a-f0-9]{64}$/iu.test(artifact.expectedSha256 ?? '') ||
        !Number.isSafeInteger(artifact.expectedSizeBytes) ||
        artifact.expectedSizeBytes < 1 ||
        (artifact.actualSha256 !== null && !/^[a-f0-9]{64}$/iu.test(artifact.actualSha256 ?? '')) ||
        (artifact.actualSizeBytes !== null &&
          (!Number.isSafeInteger(artifact.actualSizeBytes) || artifact.actualSizeBytes < 0)),
    )
  ) {
    throw new Error(`${source}: version 2 requires model artifact identity`);
  }
  if (
    typeof evidence.correctness?.stopped !== 'boolean' ||
    !Array.isArray(evidence.correctness.errors) ||
    evidence.correctness.errors.some((error) => typeof error !== 'string')
  ) {
    throw new Error(`${source}: version 2 requires session correctness evidence`);
  }
  if (measurement.passed && (!evidence.correctness.stopped || evidence.correctness.errors.length)) {
    throw new Error(`${source}: passed measurement contradicts session correctness evidence`);
  }
  if (
    !['wer', 'cer'].includes(measurement.qualityMetric) ||
    Math.abs(
      scoredErrorRate(
        evidence.scoredReference,
        evidence.scoredHypothesis,
        measurement.qualityMetric,
      ) - measurement.qualityErrorRate,
    ) > 1e-9
  ) {
    throw new Error(`${source}: quality score does not match retained scoring text`);
  }
}

// Recompute only from the recorded scoring inputs. Never silently introduce a
// new normalization policy when rendering historical measurements.
function scoredErrorRate(reference, hypothesis, metric) {
  const tokens = (text) =>
    metric === 'cer' ? Array.from(text) : text.split(/\s+/u).filter(Boolean);
  const expected = tokens(reference);
  const actual = tokens(hypothesis);
  if (!expected.length) return actual.length ? 1 : 0;
  let previous = Array.from({ length: actual.length + 1 }, (_, index) => index);
  for (let i = 0; i < expected.length; i += 1) {
    const current = [i + 1];
    for (let j = 0; j < actual.length; j += 1) {
      current.push(
        Math.min(
          current[j] + 1,
          previous[j + 1] + 1,
          previous[j] + (expected[i] === actual[j] ? 0 : 1),
        ),
      );
    }
    previous = current;
  }
  return previous[actual.length] / expected.length;
}

function groupMeasurements(measurements) {
  const groups = new Map();
  const identities = new Set();
  for (const measurement of measurements) {
    const identity = [
      measurement.suite,
      measurement.modelId,
      measurement.selection,
      measurement.language,
      measurement.fixtureId,
    ].join('\u0000');
    if (identities.has(identity)) {
      throw new Error(
        `duplicate measurement for ${measurement.modelId}/${measurement.selection}/${measurement.language}/${measurement.fixtureId} in ${measurement.suite}`,
      );
    }
    identities.add(identity);

    const key = [
      measurement.suite,
      measurement.modelId,
      measurement.selection,
      measurement.language,
      measurement.qualityMetric,
    ].join('\u0000');
    const group = groups.get(key) ?? [];
    group.push(measurement);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function buildQualityReport(measurements, metadata = {}) {
  if (measurements.length === 0) {
    throw new Error('No transcription quality measurements were found.');
  }
  const rows = groupMeasurements(measurements)
    .map((group) => {
      const first = group[0];
      const audioDurationMs = group.reduce(
        (sum, measurement) => sum + measurement.audioDurationMs,
        0,
      );
      const processingDurationMs = group.reduce(
        (sum, measurement) => sum + measurement.processingDurationMs,
        0,
      );
      const partialLatencies = group
        .map((measurement) => measurement.firstPartialAudioMs)
        .filter((value) => typeof value === 'number');
      return {
        audioDurationMs,
        firstPartialAudioMs:
          partialLatencies.length === 0 ? null : Math.round(mean(partialLatencies)),
        fixtureCount: group.length,
        language: first.language,
        maxErrorRate: Math.max(...group.map((measurement) => measurement.qualityErrorRate)),
        maxQualityBudget: Math.max(...group.map((measurement) => measurement.qualityBudget)),
        maxRealTimeFactorBudget: Math.max(
          ...group.map((measurement) => measurement.realTimeFactorBudget),
        ),
        meanErrorRate: mean(group.map((measurement) => measurement.qualityErrorRate)),
        modelId: first.modelId,
        modelName: first.modelName,
        passed: group.every((measurement) => measurement.passed),
        processingDurationMs,
        qualityMetric: first.qualityMetric,
        realTimeFactor: processingDurationMs / Math.max(audioDurationMs, 1),
        firstPartialAudioBudgetMs:
          group.find((measurement) => measurement.firstPartialAudioBudgetMs !== undefined)
            ?.firstPartialAudioBudgetMs ?? null,
        selection: first.selection,
        suite: first.suite,
      };
    })
    .sort((left, right) =>
      [left.modelName, left.suite, left.selection, left.language]
        .join('\u0000')
        .localeCompare(
          [right.modelName, right.suite, right.selection, right.language].join('\u0000'),
        ),
    );

  const languages = [...new Set(measurements.map((measurement) => measurement.language))].sort();
  const models = [...new Set(measurements.map((measurement) => measurement.modelId))].sort();
  return {
    schemaVersion: 1,
    generatedAt: metadata.generatedAt ?? null,
    commitSha: metadata.commitSha ?? null,
    runner: metadata.runner ?? null,
    environment: metadata.environment ?? null,
    environments: metadata.environments ?? [],
    missingMeasurementSources: metadata.missingMeasurementSources ?? [],
    summary: {
      audioDurationMs: measurements.reduce(
        (sum, measurement) => sum + measurement.audioDurationMs,
        0,
      ),
      failedMeasurements: measurements.filter((measurement) => !measurement.passed).length,
      languages,
      measurementCount: measurements.length,
      models,
      passedMeasurements: measurements.filter((measurement) => measurement.passed).length,
    },
    rows,
    measurements,
  };
}

function formatDuration(milliseconds) {
  return `${(milliseconds / 1_000).toFixed(1)} s`;
}

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function scenarioLabel(suite) {
  switch (suite) {
    case 'english-product-path':
      return 'English corpus';
    case 'multilingual-product-path':
      return 'Multilingual product path';
    case 'nemotron-streaming-product-path':
      return 'Streaming acceptance';
    default:
      return suite;
  }
}

function selectionLabel(selection) {
  return selection === 'auto' ? 'automatic' : selection;
}

function firstPartialLabel(row) {
  if (row.firstPartialAudioMs === null) return '—';
  if (row.firstPartialAudioBudgetMs === null) {
    return `${row.firstPartialAudioMs} ms audio`;
  }
  return `${row.firstPartialAudioMs} / ≤ ${row.firstPartialAudioBudgetMs} ms audio`;
}

export function renderQualityReportMarkdown(report) {
  const environments = report.environments ?? [];
  const missingMeasurementSources = report.missingMeasurementSources ?? [];
  const lines = [
    '# Transcription quality report',
    '',
    `- Commit: ${report.commitSha ?? 'local working tree'}`,
    `- Runner label: ${report.runner ?? 'not recorded; see run environment'}`,
    `- Measurements: ${report.summary.measurementCount} across ${report.summary.models.length} models and ${report.summary.languages.length} languages`,
    `- Fixture audio exercised: ${formatDuration(report.summary.audioDurationMs)}`,
    `- Result: ${report.summary.failedMeasurements === 0 ? 'all measured acceptance budgets passed' : `${report.summary.failedMeasurements} measurements failed`}`,
    ...(missingMeasurementSources.length
      ? [
          `- Incomplete evidence: environment captured but no measurements for ${missingMeasurementSources.join(', ')}`,
        ]
      : []),
    '',
    '| Model | Scenario | Selection | Language | Fixtures | Quality mean / max | Quality budget | RTF / budget | Audio | Processing | First partial / budget | Result |',
    '| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
  ];

  for (const row of report.rows) {
    const quality = `${formatPercent(row.meanErrorRate)} / ${formatPercent(row.maxErrorRate)} ${row.qualityMetric.toUpperCase()}`;
    lines.push(
      `| ${row.modelName} | ${scenarioLabel(row.suite)} | ${selectionLabel(row.selection)} | ${LANGUAGE_LABELS[row.language] ?? row.language} | ${row.fixtureCount} | ${quality} | ≤ ${formatPercent(row.maxQualityBudget)} | ${row.realTimeFactor.toFixed(2)}× / ≤ ${row.maxRealTimeFactorBudget.toFixed(2)}× | ${formatDuration(row.audioDurationMs)} | ${formatDuration(row.processingDurationMs)} | ${firstPartialLabel(row)} | ${row.passed ? 'Pass' : 'Fail'} |`,
    );
  }

  lines.push(
    '',
    '## How to read this',
    '',
    '- WER is word error rate; CER is character error rate for Japanese. Lower is better.',
    '- RTF is model processing time divided by fixture audio duration. Below 1.0× is faster than real time.',
    '- First partial is the amount of utterance audio received before a useful streaming revision, not model download or startup time.',
    '- Manual and automatic language selection are separate cases; coverage is limited to the rows actually present.',
    '',
    '## Evidence boundary',
    '',
    '- The standard suites use public human speech from LibriSpeech, JFK and pinned Google FLEURS validation recordings. Their small read-speech corpus is not a substitute for broader native-speaker review.',
    '- Model quality and timing budgets are scoped fixture regression checks, not a universal model adoption threshold. Loading, cancellation, recovery and output preservation remain separate correctness requirements.',
    '- Standard product-path suites include app state, VAD, worker, adapter and transcript events. First-partial audio position is not wall-clock latency. Downloads and installation are excluded; do not assume model loading, warm state or accelerator use from a platform label.',
    '- Whisper Large V3 Turbo is a GPU-oriented catalog model. Its hosted-CPU timing budget is a portable regression ceiling, not a claim about accelerated desktop latency.',
    '- Model downloads and one-time installation are excluded. Full per-fixture measurements are retained in the adjacent JSON artifact.',
    '',
  );
  if (report.environment) {
    lines.push(
      '## Run environment',
      '',
      'Measured host and declared execution context are distinct. Effective acceleration may be unobserved.',
      '',
      ...fencedText(JSON.stringify(report.environment, null, 2)),
      '',
    );
  } else if (environments.length === 0) {
    lines.push(
      'Run environment was not recorded; hardware, effective acceleration and cache state are unknown.',
      '',
    );
  }
  for (const { source, context } of environments) {
    lines.push(
      `## Recorded environment: ${source}`,
      '',
      ...fencedText(JSON.stringify(context, null, 2)),
      '',
    );
  }
  const cases = report.measurements.filter((measurement) => measurement.evidence);
  if (cases.length) {
    const mismatched = cases.filter(({ evidence }) =>
      evidence.model.artifacts.some(
        (artifact) =>
          (artifact.actualSha256 !== null && artifact.actualSha256 !== artifact.expectedSha256) ||
          (artifact.actualSizeBytes !== null &&
            artifact.actualSizeBytes !== artifact.expectedSizeBytes),
      ),
    );
    const unverified = cases.filter(({ evidence }) =>
      evidence.model.artifacts.some(
        (artifact) => artifact.actualSha256 === null || artifact.actualSizeBytes === null,
      ),
    );
    lines.push(
      '## Per-case evidence',
      '',
      'Verbatim reference and recognition output are retained separately from the scoring text. Normalization does not equate digits, number words or unit abbreviations. Scores above remain unchanged.',
      '',
    );
    if (mismatched.length)
      lines.push(
        `${mismatched.length} cases used artifacts that differ from the nominal catalog model. Compare the actual hashes, not the catalog label.`,
        '',
      );
    if (unverified.length)
      lines.push(
        `${unverified.length} cases have incomplete actual artifact identity; matching catalog pins are not established.`,
        '',
      );
    for (const measurement of cases) {
      lines.push(
        `### ${measurement.modelId} / ${measurement.fixtureId} / ${measurement.selection}`,
        '',
        ...fencedText(JSON.stringify(measurement.evidence, null, 2)),
        '',
      );
    }
  }
  if (cases.length !== report.measurements.length) {
    lines.push(
      `${report.measurements.length - cases.length} legacy measurements have no per-case text/provenance evidence; it cannot be reconstructed from aggregate scores.`,
      '',
    );
  }
  return `${lines.join('\n')}\n`;
}

function fencedText(text) {
  const fence = '`'.repeat(
    Math.max(3, ...[...text.matchAll(/`+/gu)].map((match) => match[0].length + 1)),
  );
  return [`${fence}json`, text, fence];
}
