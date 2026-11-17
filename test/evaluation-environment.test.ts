import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { main } from '../scripts/evaluation-environment.mjs';
import { collectEvaluationEnvironment } from '../scripts/lib/evaluation-environment.mjs';

const host = vi.hoisted(() => ({ platform: 'darwin', cpuDetailsAvailable: true }));
vi.mock('node:os', async (original) => ({
  ...(await original<typeof import('node:os')>()),
  platform: () => host.platform,
  arch: () => 'arm64',
  machine: () => 'arm64',
  release: () => 'test-release',
  cpus: () =>
    host.cpuDetailsAvailable ? Array.from({ length: 12 }, () => ({ model: 'Apple M2 Pro' })) : [],
  availableParallelism: () => 10,
  totalmem: () => 16 * 1024 ** 3,
  freemem: () => 4 * 1024 ** 3,
  loadavg: () => [0.5, 0.3, 0.2],
  hostname: () => {
    throw new Error('hostname must not be collected');
  },
}));

afterEach(() => {
  host.platform = 'darwin';
  host.cpuDetailsAvailable = true;
});

it('records measured host capacity without claiming GPU execution or physical core counts', async () => {
  const result = await collectEvaluationEnvironment();
  expect(result.host).toMatchObject({
    platform: 'darwin',
    processArchitecture: 'arm64',
    machineArchitecture: 'arm64',
    cpuModels: ['Apple M2 Pro'],
    logicalCpuCount: 12,
    availableParallelism: 10,
    memoryBytes: 16 * 1024 ** 3,
    loadAverage: [0.5, 0.3, 0.2],
  });
  expect(result.execution).toEqual({
    requestedAcceleration: 'unknown',
    effectiveAcceleration: 'unknown',
    effectiveAccelerationSource: 'unobserved',
    inferenceThreads: null,
    modelState: 'unknown',
    filesystemCache: 'uncontrolled',
    declarationSource: 'caller configuration',
  });
  expect(JSON.stringify(result)).not.toMatch(/hostname|physicalCoreCount|serialNumber/);
  expect(result.software.nodeVersion).toBe(process.version);
  expect(result.limitations.length).toBeGreaterThan(0);
});

it('keeps Windows load averages unavailable instead of reporting zero load', async () => {
  host.platform = 'win32';
  expect((await collectEvaluationEnvironment()).host.loadAverage).toBeNull();
});

it('keeps declared request, model residency and threads distinct from measured hardware', async () => {
  const result = await collectEvaluationEnvironment({
    requestedAcceleration: 'metal',
    inferenceThreads: 8,
    modelState: 'warm-model',
  });
  expect(result.execution).toMatchObject({
    requestedAcceleration: 'metal',
    effectiveAcceleration: 'unknown',
    inferenceThreads: 8,
    modelState: 'warm-model',
    filesystemCache: 'uncontrolled',
  });
  expect(result.host.logicalCpuCount).toBe(12);
});

it('rejects invalid execution declarations', async () => {
  for (const inferenceThreads of [0, -1, 1.5, Number.NaN]) {
    await expect(collectEvaluationEnvironment({ inferenceThreads })).rejects.toThrow(/threads/i);
  }
});

it('writes a portable CLI artifact without requiring a Git repository or a model', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'speech-kit-environment-'));
  try {
    const output = join(directory, 'environment with spaces.json');
    execFileSync(
      process.execPath,
      [
        resolve('scripts/evaluation-environment.mjs'),
        '--output',
        output,
        '--requested-acceleration',
        'cpu',
        '--inference-threads',
        '8',
        '--model-state',
        'cold-process',
      ],
      { cwd: directory },
    );
    const result = JSON.parse(await readFile(output, 'utf8'));
    expect(result.schemaVersion).toBe(1);
    expect(result.software.gitCommit).toBeNull();
    expect(result.software.trackedWorktreeDirty).toBeNull();
    expect(result.execution).toMatchObject({
      requestedAcceleration: 'cpu',
      inferenceThreads: 8,
      modelState: 'cold-process',
      effectiveAcceleration: 'unknown',
    });
    expect(result.host.memoryBytes).toBeGreaterThan(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('records missing OS CPU descriptors as unknown instead of zero cores', async () => {
  host.cpuDetailsAvailable = false;
  const result = await collectEvaluationEnvironment();
  expect(result.host.cpuModels).toEqual([]);
  expect(result.host.logicalCpuCount).toBeNull();
  expect(result.host.availableParallelism).toBe(10);
  expect(result.limitations.join(' ')).toMatch(/CPU descriptors/);
});

it('rejects flags that could mislabel an unobserved backend or overwrite a declaration', async () => {
  await expect(main(['--effective-acceleration', 'metal'])).rejects.toThrow(/option/);
  await expect(
    main(['--model-state', 'warm-model', '--model-state', 'cold-process']),
  ).rejects.toThrow(/duplicate/);
  await expect(main(['--inference-threads', '8x'])).rejects.toThrow(/threads/);
});
