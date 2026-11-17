import { execFile } from 'node:child_process';
import * as os from 'node:os';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const ACCELERATION = new Set(['cpu', 'gpu', 'metal', 'cuda', 'auto', 'unknown']);
const MODEL_STATES = new Set(['cold-process', 'warm-model', 'mixed', 'unknown']);

/** Capture host observations once per run. Execution settings are declarations,
 * not evidence of effective GPU offload, model residency, or a cold file cache. */
export async function collectEvaluationEnvironment(options = {}) {
  const requestedAcceleration = options.requestedAcceleration ?? 'unknown';
  const modelState = options.modelState ?? 'unknown';
  const inferenceThreads = options.inferenceThreads ?? null;
  if (!ACCELERATION.has(requestedAcceleration)) throw new Error('Invalid requested acceleration.');
  if (!MODEL_STATES.has(modelState)) throw new Error('Invalid model state.');
  if (
    inferenceThreads !== null &&
    (!Number.isSafeInteger(inferenceThreads) || inferenceThreads < 1)
  ) {
    throw new Error('Inference threads must be a positive integer.');
  }
  const limitations = [
    'CPU labels, host capacity and compiled support do not establish effective acceleration.',
    'Execution settings and model residency are caller declarations; effective acceleration is unobserved.',
    'Filesystem caches and concurrent workloads are uncontrolled; a new process does not prove cold storage.',
    'Core counts are logical, memory is OS-visible, and available parallelism is not an inference thread count.',
    'Git identity describes the checkout, not a compiled binary or untracked inputs.',
  ];
  let gitCommit = null;
  let trackedWorktreeDirty = null;
  try {
    const gitOptions = {
      cwd: options.cwd ?? process.cwd(),
      timeout: 2_000,
      maxBuffer: 1024 * 1024,
    };
    const { stdout: commit } = await execute('git', ['rev-parse', '--verify', 'HEAD'], gitOptions);
    if (!/^[a-f0-9]{40,64}$/i.test(commit.trim())) throw new Error('Invalid Git commit.');
    const { stdout: status } = await execute(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=no'],
      gitOptions,
    );
    gitCommit = commit.trim();
    trackedWorktreeDirty = status.trim().length > 0;
  } catch {
    limitations.push(
      'Git source identity was unavailable; commit and tracked worktree state are unknown.',
    );
  }
  const cpus = os.cpus();
  if (cpus.length === 0)
    limitations.push(
      'OS CPU descriptors were unavailable; logical CPU count and model are unknown.',
    );
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    host: {
      platform: os.platform(),
      processArchitecture: os.arch(),
      machineArchitecture: os.machine(),
      osRelease: os.release(),
      cpuModels: [...new Set(cpus.map((cpu) => cpu.model.trim()).filter(Boolean))],
      logicalCpuCount: cpus.length || null,
      availableParallelism: os.availableParallelism(),
      memoryBytes: os.totalmem(),
      osFreeMemoryBytes: os.freemem(),
      loadAverage: os.platform() === 'win32' ? null : os.loadavg(),
    },
    software: { nodeVersion: process.version, gitCommit, trackedWorktreeDirty },
    execution: {
      requestedAcceleration,
      effectiveAcceleration: 'unknown',
      effectiveAccelerationSource: 'unobserved',
      inferenceThreads,
      modelState,
      filesystemCache: 'uncontrolled',
      declarationSource: 'caller configuration',
    },
    limitations,
  };
}
