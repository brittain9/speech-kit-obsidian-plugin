import { execFileSync, spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { main } from '../scripts/transcription-quality-report.mjs';

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawnSync: vi.fn(),
}));

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

it('executes the real CLI from a checkout path containing spaces', async () => {
  const output = await mkdtemp(join(tmpdir(), 'speech kit quality command '));
  directories.push(output);
  await mkdir(join(output, 'lib'));
  for (const name of [
    'transcription-quality-report.mjs',
    'lib/transcription-quality-report.mjs',
    'lib/evaluation-environment.mjs',
  ]) {
    await copyFile(join('scripts', name), join(output, name));
  }
  const help = execFileSync(
    process.execPath,
    [join(output, 'transcription-quality-report.mjs'), '--help'],
    { encoding: 'utf8' },
  );
  expect(help).toContain('Usage: node scripts/transcription-quality-report.mjs');
  expect(help).toContain('--environment');
});

it('renders collected failed measurements without running further suites or hiding failure', async () => {
  const output = await mkdtemp(join(tmpdir(), 'speech-quality-command-'));
  directories.push(output);
  vi.mocked(spawnSync).mockImplementation((_command, _args, options) => {
    const reportPath = options?.env?.STT_QUALITY_REPORT_PATH;
    if (typeof reportPath !== 'string') throw new Error('Missing measurement destination');
    // The suite writes its measurements before returning its failed exit status.
    const line = JSON.stringify({
      schemaVersion: 1,
      suite: 'english-product-path',
      modelId: 'model',
      modelName: 'Model',
      language: 'en',
      selection: 'manual',
      fixtureId: 'fixture',
      qualityMetric: 'wer',
      qualityErrorRate: 0.4,
      qualityBudget: 0.2,
      audioDurationMs: 2000,
      processingDurationMs: 500,
      realTimeFactor: 0.25,
      realTimeFactorBudget: 1,
      passed: false,
    });
    // spawnSync is synchronous, matching the real model suite's completed output.
    writeFileSync(reportPath, `${line}\n`);
    return { pid: 1, output: [], stdout: '', stderr: '', status: 1, signal: null };
  });

  await expect(main(['--output-dir', output])).rejects.toThrow('test:sidecar:e2e failed');
  expect(spawnSync).toHaveBeenCalledTimes(1);
  const report = JSON.parse(await readFile(join(output, 'transcription-quality.json'), 'utf8'));
  expect(report.rows[0]).toMatchObject({ fixtureCount: 1, passed: false, maxErrorRate: 0.4 });
  expect(await readFile(join(output, 'transcription-quality.md'), 'utf8')).toContain('Fail');
});

it('preserves a suite startup failure when there are no measurements to render', async () => {
  const output = await mkdtemp(join(tmpdir(), 'speech-quality-command-'));
  directories.push(output);
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(spawnSync).mockReturnValue({
    pid: 1,
    output: [],
    stdout: '',
    stderr: '',
    status: 101,
    signal: null,
  });
  await expect(main(['--output-dir', output])).rejects.toThrow(
    'test:sidecar:e2e failed with exit status 101',
  );
  expect(diagnostic).toHaveBeenCalledWith(
    'Could not render partial transcription measurements:',
    'No transcription quality measurements were found.',
  );
});

it('renders recorded environment context without pretending a render machine ran inference', async () => {
  const output = await mkdtemp(join(tmpdir(), 'speech-quality-context-'));
  directories.push(output);
  const contextPath = join(output, 'environment.json');
  await writeFile(
    contextPath,
    JSON.stringify({
      schemaVersion: 1,
      host: { cpuModels: ['Recorded CPU'] },
      execution: { requestedAcceleration: 'cpu', effectiveAcceleration: 'unknown' },
    }),
  );
  await writeFile(
    join(output, 'case.jsonl'),
    `${JSON.stringify({
      schemaVersion: 1,
      suite: 'english-product-path',
      modelId: 'model',
      modelName: 'Model',
      language: 'en',
      selection: 'manual',
      fixtureId: 'fixture',
      qualityMetric: 'wer',
      qualityErrorRate: 0.1,
      qualityBudget: 0.2,
      audioDurationMs: 2000,
      processingDurationMs: 500,
      realTimeFactor: 0.25,
      realTimeFactorBudget: 1,
      passed: true,
    })}\n`,
  );
  await main([
    '--render-only',
    output,
    '--output-dir',
    join(output, 'rendered'),
    '--environment',
    contextPath,
  ]);
  const report = JSON.parse(
    await readFile(join(output, 'rendered', 'transcription-quality.json'), 'utf8'),
  );
  expect(report.environment.host.cpuModels).toEqual(['Recorded CPU']);
  expect(report.environment.execution.effectiveAcceleration).toBe('unknown');
  expect(spawnSync).not.toHaveBeenCalled();
});

it('keeps separate runner contexts attached to their own input measurements', async () => {
  const output = await mkdtemp(join(tmpdir(), 'speech-quality-runners-'));
  directories.push(output);
  for (const name of ['whisper', 'nemotron']) {
    await mkdir(join(output, name));
    await writeFile(
      join(output, name, 'results.environment.json'),
      JSON.stringify({
        schemaVersion: 1,
        host: { cpuModels: [`${name} CPU`] },
        execution: { effectiveAcceleration: 'unknown' },
      }),
    );
    await writeFile(
      join(output, name, 'results.jsonl'),
      `${JSON.stringify({
        schemaVersion: 1,
        suite: 'english-product-path',
        modelId: 'same-model',
        modelName: 'Same model',
        language: 'en',
        selection: 'manual',
        fixtureId: 'fixture',
        qualityMetric: 'wer',
        qualityErrorRate: 0.1,
        qualityBudget: 0.2,
        audioDurationMs: 2000,
        processingDurationMs: 500,
        realTimeFactor: 0.25,
        realTimeFactorBudget: 1,
        passed: true,
      })}\n`,
    );
  }
  await writeFile(
    join(output, 'failed.environment.json'),
    JSON.stringify({
      schemaVersion: 1,
      host: { cpuModels: ['failed CPU'] },
      execution: { effectiveAcceleration: 'unknown' },
    }),
  );
  await main(['--render-only', output, '--output-dir', join(output, 'rendered')]);
  const report = JSON.parse(
    await readFile(join(output, 'rendered', 'transcription-quality.json'), 'utf8'),
  );
  expect(report.environment).toBeNull();
  expect(report.environments).toHaveLength(3);
  expect(report.missingMeasurementSources).toEqual(['failed.jsonl']);
  expect(
    report.measurements.map((record: { environmentSource: string }) => record.environmentSource),
  ).toEqual(['nemotron/results.environment.json', 'whisper/results.environment.json']);
  expect(report.rows).toHaveLength(2);
  expect(
    report.environments.map(
      (record: { context: { host: { cpuModels: string[] } } }) => record.context.host.cpuModels,
    ),
  ).toEqual([['failed CPU'], ['nemotron CPU'], ['whisper CPU']]);
  expect(spawnSync).not.toHaveBeenCalled();
});
