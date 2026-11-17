export type AccelerationRequest = 'cpu' | 'gpu' | 'metal' | 'cuda' | 'auto' | 'unknown';
export type ModelState = 'cold-process' | 'warm-model' | 'mixed' | 'unknown';
export interface EvaluationEnvironmentOptions {
  requestedAcceleration?: AccelerationRequest;
  inferenceThreads?: number;
  modelState?: ModelState;
  cwd?: string;
}
export interface EvaluationEnvironment {
  schemaVersion: 1;
  capturedAt: string;
  host: {
    platform: string;
    processArchitecture: string;
    machineArchitecture: string;
    osRelease: string;
    cpuModels: string[];
    logicalCpuCount: number | null;
    availableParallelism: number;
    memoryBytes: number;
    osFreeMemoryBytes: number;
    loadAverage: number[] | null;
  };
  software: { nodeVersion: string; gitCommit: string | null; trackedWorktreeDirty: boolean | null };
  execution: {
    requestedAcceleration: AccelerationRequest;
    effectiveAcceleration: 'unknown';
    effectiveAccelerationSource: 'unobserved';
    inferenceThreads: number | null;
    modelState: ModelState;
    filesystemCache: 'uncontrolled';
    declarationSource: 'caller configuration';
  };
  limitations: string[];
}
export function collectEvaluationEnvironment(
  options?: EvaluationEnvironmentOptions,
): Promise<EvaluationEnvironment>;
