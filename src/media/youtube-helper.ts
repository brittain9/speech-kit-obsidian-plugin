import { type ChildProcess, spawn } from 'node:child_process';
import { lstatSync } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

import type { AcquisitionFailureCode } from './media-source';

export const YOUTUBE_HELPER_PINNED_VERSION = '2026.08.19';
export const YOUTUBE_HELPER_MAX_VERSION_OUTPUT_BYTES = 8 * 1024;
export const YOUTUBE_HELPER_PROBE_TIMEOUT_MS = 10_000;

const VERSION_PATTERN = /(?:^|\s)yt-dlp\s+(\d{4}\.\d{2}\.\d{2})(?:\s|$)/iu;
const BARE_VERSION_PATTERN = /^(\d{4}\.\d{2}\.\d{2})$/u;

export class YouTubeHelperError extends Error {
  override readonly cause?: unknown;

  constructor(
    readonly code: Extract<
      AcquisitionFailureCode,
      | 'helper_unavailable'
      | 'helper_version_unsupported'
      | 'tool_failed'
      | 'cancelled'
      | 'resource_limit'
    >,
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
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly spawnProcess?: typeof spawn;
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

  const spawnProcess = options.spawnProcess ?? spawn;
  const timeoutMs = options.timeoutMs ?? YOUTUBE_HELPER_PROBE_TIMEOUT_MS;
  const child = spawnProcess(path, ['--version'], {
    cwd: process.cwd(),
    env: sanitizedProbeEnvironment(),
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const result = await collectVersionOutput(child, timeoutMs, options.signal);
  if (result.cancelled) {
    throw new YouTubeHelperError('cancelled', 'The yt-dlp version check was cancelled.');
  }
  if (result.timedOut || result.failed || result.version === null) {
    throw new YouTubeHelperError(
      'helper_unavailable',
      'The selected yt-dlp executable could not be run.',
    );
  }
  if (!isCompatibleYtDlpVersion(result.version)) {
    throw new YouTubeHelperError(
      'helper_version_unsupported',
      `yt-dlp ${YOUTUBE_HELPER_PINNED_VERSION} or newer is required.`,
    );
  }
  return { path, version: result.version };
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

async function collectVersionOutput(
  child: ChildProcess,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<{ cancelled: boolean; failed: boolean; timedOut: boolean; version: string | null }> {
  let stdout = '';
  let stderrBytes = 0;
  let settled = false;
  let timedOut = false;
  let cancelled = false;
  let resolveResult!: (result: {
    cancelled: boolean;
    failed: boolean;
    timedOut: boolean;
    version: string | null;
  }) => void;
  const resultPromise = new Promise<{
    cancelled: boolean;
    failed: boolean;
    timedOut: boolean;
    version: string | null;
  }>((resolve) => {
    resolveResult = resolve;
  });
  const finish = (failed: boolean): void => {
    if (settled) return;
    settled = true;
    window.clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    resolveResult({
      cancelled,
      failed,
      timedOut,
      version: parseYtDlpVersion(stdout),
    });
  };
  const abort = (): void => {
    cancelled = true;
    child.kill('SIGTERM');
  };
  const timer = window.setTimeout(
    () => {
      timedOut = true;
      child.kill('SIGKILL');
    },
    Math.max(1, timeoutMs),
  );
  signal?.addEventListener('abort', abort, { once: true });

  child.stdout?.on('data', (chunk: Buffer | string) => {
    const value = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (Buffer.byteLength(value, 'utf8') > YOUTUBE_HELPER_MAX_VERSION_OUTPUT_BYTES) {
      child.kill('SIGKILL');
      finish(true);
      return;
    }
    stdout += value;
  });
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderrBytes += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
    if (stderrBytes > YOUTUBE_HELPER_MAX_VERSION_OUTPUT_BYTES) {
      child.kill('SIGKILL');
      finish(true);
    }
  });
  child.once('error', () => finish(true));
  child.once('close', (code) => finish(code !== 0));
  return await resultPromise;
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
