import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  encodeJsonFrame,
  FRAME_HEADER_LENGTH,
  JSON_FRAME_KIND,
  type SidecarEvent,
} from '../src/sidecar/protocol';
import { SidecarConnection } from '../src/sidecar/sidecar-connection';
import { SidecarProcess } from '../src/sidecar/sidecar-process';
import wireCorpus from './fixtures/sidecar-wire-contract.json';

// Frontend-only checks do not build Rust. The dedicated command requires a
// binary and enables this suite after CI's existing native build.
const binary = process.env.SPEECH_KIT_SIDECAR_BIN;
const activeConnections = new Set<SidecarConnection>();
const REQUEST_TIMEOUT_MS = 2_000;

function connect() {
  if (!binary) throw new Error('Set SPEECH_KIT_SIDECAR_BIN to the built sidecar executable.');
  let adapter: SidecarProcess | undefined;
  const connection = new SidecarConnection({
    createProcess: (resolve, handlers) => {
      adapter = new SidecarProcess(resolve, handlers);
      return adapter;
    },
    getRequestTimeoutMs: () => REQUEST_TIMEOUT_MS,
    resolveLaunchSpec: async () => ({ command: binary }),
  });
  if (!adapter) throw new Error('The production process adapter was not constructed.');
  activeConnections.add(connection);
  return { adapter, connection };
}

afterEach(async () => {
  // This also runs after failed assertions and request deadlines. Production
  // stop closes stdin, escalates after its grace period, and awaits child exit.
  await Promise.all(
    [...activeConnections].map(async (connection) => {
      await connection.shutdown();
      connection.dispose();
    }),
  );
  activeConnections.clear();
}, 10_000);

describe.skipIf(!binary)('production client with the real Rust sidecar', () => {
  it('round-trips health and system information without models or audio access', async () => {
    const { connection } = connect();
    await expect(connection.healthCheck()).resolves.toMatchObject({
      status: 'ready',
      type: 'health_ok',
    });
    const info = await connection.getSystemInfo();
    expect(info.type).toBe('system_info');
    expect(info.sidecarVersion).toMatch(/^\d{4}\.\d+\.\d+$/);
    expect(info.systemInfo.trim().length).toBeGreaterThan(0);
    expect(info.compiledRuntimes.length).toBeGreaterThan(0);
    expect(info.compiledAdapters.length).toBeGreaterThan(0);
  }, 10_000);

  it('round-trips the Qwen family, managed pair and unavailable probe through the production client', async () => {
    const { connection } = connect();
    const info = await connection.getSystemInfo();
    expect(info.compiledAdapters.find((adapter) => adapter.familyId === 'qwen3_asr')).toMatchObject(
      {
        runtimeId: 'llama_cpp',
        familyCapabilities: {
          task: 'stt',
          supportsStreaming: false,
          supportsWordTimestamps: false,
          supportsAutomaticLanguageDetection: true,
        },
      },
    );
    const catalog = await connection.listModelCatalog();
    const model = catalog.models.find((entry) => entry.modelId === 'qwen3_asr_0_6b_q8_0');
    expect(model).toMatchObject({ runtimeId: 'llama_cpp', familyId: 'qwen3_asr', task: 'stt' });
    expect(
      model?.artifacts.filter((artifact) => artifact.required).map((artifact) => artifact.filename),
    ).toEqual(['Qwen3-ASR-0.6B-Q8_0.gguf', 'mmproj-Qwen3-ASR-0.6B-Q8_0.gguf']);
    const result = await connection.probeModelSelection({
      modelSelection: {
        kind: 'external_file',
        runtimeId: 'llama_cpp',
        familyId: 'qwen3_asr',
        filePath: join(tmpdir(), 'speech-kit-missing-qwen-fixture', 'Qwen3-ASR-0.6B-Q8_0.gguf'),
      },
    });
    expect(result).toMatchObject({
      available: false,
      selection: { runtimeId: 'llama_cpp', familyId: 'qwen3_asr' },
    });
    await expect(connection.healthCheck()).resolves.toMatchObject({ type: 'health_ok' });
  }, 10_000);

  it('acknowledges disabled desktop configuration without OS registration and remains usable', async () => {
    const { connection } = connect();
    const fixture = wireCorpus.commands.find((entry) => entry.id === 'desktop-configure');
    if (!fixture) throw new Error('Desktop command fixture missing');
    const command = fixture.wire as import('../src/sidecar/protocol').ConfigureDesktopCommand;
    const events: SidecarEvent[] = [];
    connection.subscribe((event) => events.push(event));
    await connection.configureDesktop({ ...command, shortcut: null, showIcon: false });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'desktop_status',
        requestId: command.requestId,
        generation: command.generation,
        shortcutStatus: 'disabled',
        iconAvailable: false,
        owner: true,
      }),
    );
    await expect(connection.healthCheck()).resolves.toMatchObject({ type: 'health_ok' });
  }, 10_000);

  it('rejects an invalid public request with the server diagnostic and remains usable', async () => {
    const { connection } = connect();
    await expect(connection.getModelStore('relative-model-store')).rejects.toMatchObject({
      code: 'invalid_model_store',
      details: expect.stringContaining('absolute path'),
      name: 'SidecarError',
    });
    await expect(connection.healthCheck()).resolves.toMatchObject({ type: 'health_ok' });
  }, 10_000);

  it('reaps the child on expected shutdown without reporting a crash', async () => {
    const { adapter, connection } = connect();
    const events: SidecarEvent[] = [];
    const stopped = vi.fn();
    connection.subscribe((event) => events.push(event));
    connection.subscribeProcessStop(stopped);
    await connection.healthCheck();

    await connection.shutdown();

    expect(adapter.isRunning()).toBe(false);
    expect(adapter.isStarting()).toBe(false);
    expect(stopped).toHaveBeenCalledWith(false);
    expect(stopped.mock.calls.every(([unexpected]) => unexpected === false)).toBe(true);
    expect(events).not.toContainEqual(expect.objectContaining({ code: 'sidecar_exited' }));
  }, 10_000);

  it('rejects a pending request when an unsolicited server shutdown exits the child', async () => {
    const { adapter, connection } = connect();
    const events: SidecarEvent[] = [];
    const stopped = vi.fn();
    connection.subscribe((event) => events.push(event));
    connection.subscribeProcessStop(stopped);
    await connection.healthCheck();

    // Inject only at the public transport seam: the real server exits before
    // the following request can receive a reply. No production API is added.
    adapter.write(encodeJsonFrame({ type: 'shutdown' }));
    await expect(connection.getSystemInfo()).rejects.toThrow(/exited unexpectedly/);

    expect(adapter.isRunning()).toBe(false);
    expect(stopped).toHaveBeenCalledWith(true);
    expect(events).toContainEqual(expect.objectContaining({ code: 'sidecar_exited' }));
  }, 10_000);

  it('reports a mismatched wire command and recovers for the next valid request', async () => {
    const { adapter, connection } = connect();
    const events: SidecarEvent[] = [];
    connection.subscribe((event) => events.push(event));
    await connection.ensureStarted();

    const payload = new TextEncoder().encode('{"type":"unsupported_wire_command"}');
    const frame = new Uint8Array(FRAME_HEADER_LENGTH + payload.byteLength);
    frame[0] = JSON_FRAME_KIND;
    new DataView(frame.buffer).setUint32(1, payload.byteLength, true);
    frame.set(payload, FRAME_HEADER_LENGTH);
    adapter.write(frame);
    await vi.waitFor(
      () => expect(events).toContainEqual(expect.objectContaining({ code: 'invalid_frame' })),
      { timeout: REQUEST_TIMEOUT_MS },
    );
    await expect(connection.healthCheck()).resolves.toMatchObject({ type: 'health_ok' });
  }, 10_000);
});
