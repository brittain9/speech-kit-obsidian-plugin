import type { spawn } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

import { type ManagedProcessResult, runManagedProcess } from './process-runner';

export const YOUTUBE_HELPER_PINNED_VERSION = '2026.08.19';
export const YOUTUBE_HELPER_MAX_VERSION_OUTPUT_BYTES = 8 * 1024;
export const YOUTUBE_HELPER_PROBE_TIMEOUT_MS = 10_000;

export type YouTubeHelperFailureCode =
  | 'helper_unavailable'
  | 'helper_version_unsupported'
  | 'tool_failed'
  | 'cancelled'
  | 'resource_limit';

const VERSION_PATTERN = /(?:^|\s)yt-dlp\s+(\d{4}\.\d{2}\.\d{2})(?:\s|$)/iu;
const BARE_VERSION_PATTERN = /^(\d{4}\.\d{2}\.\d{2})$/u;

export class YouTubeHelperError extends Error {
  override readonly cause?: unknown;

  constructor(
    readonly code: YouTubeHelperFailureCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'YouTubeHelperError';
    this.cause = options?.cause;
  }
}

export interface YtDlpCandidateOptions {
  readonly pathEntries?: readonly string[];
  readonly platform?: NodeJS.Platform;
  readonly isExistingFile?: (path: string) => boolean;
}

export interface YtDlpVersionProbeOptions {
  readonly cwd?: string;
  readonly platform?: NodeJS.Platform;
  readonly signal?: AbortSignal;
  readonly spawnProcess?: typeof spawn;
  readonly timeoutMs?: number;
}

export interface YtDlpVersion {
  readonly path: string;
  readonly version: string;
}

export function normalizeYouTubeHelperPath(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || !isAbsolute(trimmed)) return null;
  return resolve(trimmed);
}

export function discoverYtDlpCandidates(options: YtDlpCandidateOptions = {}): string[] {
  const platform = options.platform ?? process.platform;
  const entries = options.pathEntries ?? (process.env.PATH ?? '').split(delimiter);
  const isExistingFile = options.isExistingFile ?? defaultExistingFile;
  const names = helperNames(platform);
  const seen = new Set<string>();
  const candidates: string[] = [];

  for (const entry of entries) {
    const trimmed = entry.trim();
    if (trimmed.length === 0 || !isAbsolute(trimmed)) continue;
    const directory = resolve(trimmed);
    for (const name of names) {
      const candidate = resolve(join(directory, name));
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      if (isExistingFile(candidate)) candidates.push(candidate);
    }
  }
  return candidates;
}

export function parseYtDlpVersion(output: string): string | null {
  const normalized = output.trim();
  const match = VERSION_PATTERN.exec(normalized) ?? BARE_VERSION_PATTERN.exec(normalized);
  return match?.[1] ?? null;
}

export function isCompatibleYtDlpVersion(version: string): boolean {
  const parsed = parseYtDlpVersion(version) ?? version.trim();
  const actual = parseVersionParts(parsed);
  const minimum = parseVersionParts(YOUTUBE_HELPER_PINNED_VERSION);
  return actual !== null && minimum !== null && compareVersionParts(actual, minimum) >= 0;
}

export async function probeYtDlpVersion(
  executablePath: string,
  options: YtDlpVersionProbeOptions = {},
): Promise<YtDlpVersion> {
  const path = normalizeYouTubeHelperPath(executablePath);
  if (path === null) {
    throw new YouTubeHelperError(
      'helper_unavailable',
      'Select an absolute yt-dlp executable path.',
    );
  }
  if (options.signal?.aborted === true) {
    throw new YouTubeHelperError('cancelled', 'The yt-dlp version check was cancelled.');
  }

  const result = await runManagedProcess(
    path,
    ['--version'],
    {
      cwd: options.cwd ?? tmpdir(),
      env: sanitizedProbeEnvironment(),
      ...(options.platform === undefined ? {} : { platform: options.platform }),
      shell: false,
      ...(options.spawnProcess === undefined ? {} : { spawnProcess: options.spawnProcess }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
    {
      maxOutputBytes: YOUTUBE_HELPER_MAX_VERSION_OUTPUT_BYTES,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      stderrLimitBytes: YOUTUBE_HELPER_MAX_VERSION_OUTPUT_BYTES,
      timeoutMs: options.timeoutMs ?? YOUTUBE_HELPER_PROBE_TIMEOUT_MS,
    },
  );
  return interpretVersionResult(path, result);
}

export function interpretVersionResult(path: string, result: ManagedProcessResult): YtDlpVersion {
  if (result.cancelled) {
    throw new YouTubeHelperError('cancelled', 'The yt-dlp version check was cancelled.');
  }
  if (result.timedOut) {
    throw new YouTubeHelperError('helper_unavailable', 'The selected yt-dlp executable timed out.');
  }
  if (result.outputLimitExceeded) {
    throw new YouTubeHelperError(
      'resource_limit',
      'The yt-dlp version output exceeded its safety limit.',
    );
  }
  if (result.failed || result.exitCode !== 0) {
    throw new YouTubeHelperError(
      'helper_unavailable',
      'The selected yt-dlp executable could not be run.',
    );
  }
  const version = parseYtDlpVersion(result.stdout);
  if (version === null) {
    throw new YouTubeHelperError(
      'helper_unavailable',
      'The selected yt-dlp executable returned no version.',
    );
  }
  if (!isCompatibleYtDlpVersion(version)) {
    throw new YouTubeHelperError(
      'helper_version_unsupported',
      `yt-dlp ${YOUTUBE_HELPER_PINNED_VERSION} or newer is required.`,
    );
  }
  return { path, version };
}

function defaultExistingFile(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function helperNames(platform: NodeJS.Platform): readonly string[] {
  return platform === 'win32'
    ? ['yt-dlp.exe', 'yt-dlp_x86.exe', 'yt-dlp_arm64.exe']
    : ['yt-dlp', 'yt-dlp_linux', 'yt-dlp_macos'];
}

function sanitizedProbeEnvironment(): NodeJS.ProcessEnv {
  return {
    LANG: 'C',
    LC_ALL: 'C',
  };
}

function parseVersionParts(value: string): [number, number, number] | null {
  const match = /^(\d{4})\.(\d{2})\.(\d{2})$/u.exec(value.trim());
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersionParts(
  left: [number, number, number],
  right: [number, number, number],
): number {
  for (const [index, leftValue] of left.entries()) {
    const rightValue = right[index];
    if (rightValue !== undefined && leftValue !== rightValue) return leftValue - rightValue;
  }
  return 0;
}
