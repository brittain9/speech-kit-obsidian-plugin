import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

it('keeps Linux native release archives on the Ubuntu 24.04 runtime and CUDA baseline', async () => {
  const workflow = await readFile('.github/workflows/release.yml', 'utf8');
  const linuxArchives = [
    ...workflow.matchAll(
      /^[\t ]*- runner:[\t ]+([^\r\n]+)\r?\n[\t ]+asset_name:[\t ]+(sidecar-linux-[^\r\n]+)/gm,
    ),
  ].map((entry) => ({ runner: entry[1], asset: entry[2] }));

  expect(linuxArchives).toEqual([
    { runner: 'ubuntu-24.04', asset: 'sidecar-linux-x86_64-cpu' },
    { runner: 'ubuntu-24.04-arm', asset: 'sidecar-linux-arm64' },
    { runner: 'ubuntu-24.04', asset: 'sidecar-linux-x86_64-cuda' },
  ]);
});
