import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const result = spawnSync(
  'uv',
  ['run', '--locked', '--project', 'tools/graphify', 'graphify', ...process.argv.slice(2)],
  {
    cwd: root,
    env: {
      ...process.env,
      GRAPHIFY_BACKEND: 'none',
      UV_CACHE_DIR: fileURLToPath(new URL('../tools/graphify/.cache/', import.meta.url)),
    },
    stdio: 'inherit',
  },
);

if (result.error) {
  console.error(`Could not start Graphify: ${result.error.message}. Install uv first.`);
}
process.exit(result.status ?? 1);
