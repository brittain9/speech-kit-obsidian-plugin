import { execFileSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';

import { buildRustQualityCommands } from '../scripts/check-rust.mjs';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
const originalPlatform = process.platform;
const originalArgv = process.argv;

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  process.argv = originalArgv;
  vi.clearAllMocks();
  vi.resetModules();
});

it.each(['darwin', 'linux', 'win32'])(
  'normal %s builds include the isolated ASR helper feature and all binaries',
  async (platform) => {
    Object.defineProperty(process, 'platform', { value: platform });
    process.argv = ['node', 'scripts/build-sidecar.mjs', '--release'];
    await import('../scripts/build-sidecar.mjs');
    expect(execFileSync).toHaveBeenCalledOnce();
    const args = vi.mocked(execFileSync).mock.calls[0]?.[1];
    if (!Array.isArray(args)) throw new Error('expected cargo arguments');
    expect(args).toContain('--bins');
    expect(args).toContain('--release');
    expect(args).toContain('--locked');
    const features = String(args[args.indexOf('--features') + 1]).split(',');
    expect(features).toContain('engine-qwen-asr');
    expect(features.includes('gpu-metal')).toBe(platform === 'darwin');
    for (const command of buildRustQualityCommands()) {
      if (!command.args.includes('--features')) continue;
      expect(command.args[command.args.indexOf('--features') + 1]).toBe(features.join(','));
    }
  },
);
