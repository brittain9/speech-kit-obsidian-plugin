export function planChecks(paths: string[], full?: boolean): { native: boolean; platform: boolean };
export function changedFiles(base: string, head: string, cwd?: string): string[];
export function assertCiSuccess(
  needs: Record<string, { result: string; outputs?: Record<string, string> }>,
): void;
