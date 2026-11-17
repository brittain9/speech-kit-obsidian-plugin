export function planOrphanCaches(branches: unknown, pulls: unknown, caches: unknown): number[];
export function cleanupActionsCaches(
  repository: string,
  run?: (command: string, args: string[], options: { encoding: 'utf8' }) => string,
): number[];
