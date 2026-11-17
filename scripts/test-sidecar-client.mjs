import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const binary = resolve(
  root,
  process.env.SPEECH_KIT_SIDECAR_BIN ??
    `${process.env.CARGO_TARGET_DIR ?? 'native/target'}/debug/local-dictation-sidecar${process.platform === 'win32' ? '.exe' : ''}`,
);
try {
  accessSync(binary, constants.X_OK);
} catch {
  console.error(`Sidecar executable not found or not executable: ${binary}`);
  console.error('Run npm run build:sidecar first, or set SPEECH_KIT_SIDECAR_BIN.');
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  [
    resolve(root, 'node_modules/vitest/vitest.mjs'),
    'run',
    'test/sidecar-real-process.test.ts',
    ...process.argv.slice(2),
  ],
  {
    cwd: root,
    env: { ...process.env, SPEECH_KIT_SIDECAR_BIN: binary },
    stdio: 'inherit',
  },
);
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
