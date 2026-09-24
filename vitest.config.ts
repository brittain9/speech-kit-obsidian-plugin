import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      electron: new URL('test/electron.ts', import.meta.url).pathname,
      obsidian: new URL('test/__mocks__/obsidian.ts', import.meta.url).pathname,
      'virtual:build-mode': new URL('test/virtual-build-mode.ts', import.meta.url).pathname,
      'virtual:pcm-recorder-worklet-source': new URL(
        'test/virtual-pcm-recorder-worklet-source.ts',
        import.meta.url,
      ).pathname,
      'virtual:bergamot-worker-source': new URL(
        'test/virtual-bergamot-worker-source.ts',
        import.meta.url,
      ).pathname,
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup.ts'],
    passWithNoTests: false,
  },
});
