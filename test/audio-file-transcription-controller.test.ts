import { describe, expect, it, vi } from 'vitest';
import type { DecodedAudioFile } from '../src/audio/audio-file-decoder';
import { AudioFileTranscriptionController } from '../src/dictation/audio-file-transcription-controller';
import type { NotePlacementOptions, SurfaceDesynchronization } from '../src/editor/note-surface';
import type {
  EngineCapabilitiesRecord,
  SelectedModel,
  SelectedModelCapabilities,
} from '../src/models/model-management-types';
import type { SessionAcceptResult } from '../src/session/session';
import type { TranscriptRevision } from '../src/session/session-journal';
import { DEFAULT_PLUGIN_SETTINGS, type PluginSettings } from '../src/settings/plugin-settings';
import type {
  SidecarEvent,
  StartSessionCommand,
  TranscriptReadyEvent,
} from '../src/sidecar/protocol';
import { SidecarLifecycleGate } from '../src/sidecar/sidecar-lifecycle-gate';
import type { TranscriptRenderOptions } from '../src/transcript/renderer';
import { createGeneratedWavFile } from './fixtures/audio-file';

interface Target {
  readonly id: string;
}

interface CreateSessionOptions {
  readonly callbacks: {
    onLockedNoteClosed: () => void;
    onLockedNoteDeleted: () => void;
    onSurfaceDesynchronized: (failure: SurfaceDesynchronization) => void;
  };
  readonly placement: NotePlacementOptions;
  readonly rendererOptions: TranscriptRenderOptions;
  readonly sessionId: string;
  readonly target: object;
}

class FakeSession {
  public readonly accepted: TranscriptRevision[] = [];
  public readonly acceptTranscript = vi.fn((revision: TranscriptRevision): SessionAcceptResult => {
    this.accepted.push(revision);
    return { kind: 'accepted' };
  });
  public readonly clearSessionProcessingMark = vi.fn();
  public readonly dispose = vi.fn();
  public readonly readNoteGlossary = vi.fn(
    (_maxChars: number): { text: string; truncated: boolean } | null => null,
  );
}

class FakeDecodedAudio implements DecodedAudioFile {
  public readonly dispose = vi.fn();

  constructor(
    public readonly sampleRate: number,
    public readonly numberOfChannels: number,
    public readonly length: number,
    private readonly channels: Float32Array[],
  ) {}

  getChannelData(channel: number): Float32Array {
    const samples = this.channels[channel];
    if (samples === undefined) {
      throw new Error(`Missing fake decoded channel ${String(channel)}.`);
    }
    return samples;
  }
}

class FakeSidecarConnection {
  public readonly cancelSession = vi.fn(async (sessionId: string) => {
    this.emit({ reason: 'user_cancel', sessionId, type: 'session_stopped' });
    return { reason: 'user_cancel', sessionId, type: 'session_stopped' } as const;
  });
  public readonly ensureStarted = vi.fn(async () => {});
  public readonly listeners = new Set<(event: SidecarEvent) => void>();
  public readonly requestStopSession = vi.fn((_sessionId: string) => {});
  public readonly sendContextResponse = vi.fn((_correlationId: string, _context: unknown) => {});
  public readonly sendAudioFrameWithBackpressure = vi.fn(
    async (_sessionId: string, _frameBytes: Uint8Array, _signal: AbortSignal) => {},
  );
  public readonly startSession = vi.fn(async (payload: Omit<StartSessionCommand, 'type'>) => {
    this.emit({ mode: payload.mode, sessionId: payload.sessionId, type: 'session_started' });
    return { mode: payload.mode, sessionId: payload.sessionId, type: 'session_started' } as const;
  });
  public readonly subscribe = vi.fn((listener: (event: SidecarEvent) => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  });

  emit(event: SidecarEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

const selectedModel: SelectedModel = {
  familyId: 'whisper',
  filePath: '/models/whisper.bin',
  kind: 'external_file',
  runtimeId: 'whisper_cpp',
};

const batchCapabilities: EngineCapabilitiesRecord = {
  family: {
    availableVoices: [],
    maxAudioDurationSecs: null,
    outputSampleRate: null,
    producesPunctuation: true,
    supportsAutomaticLanguageDetection: false,
    supportsHardwareAcceleration: true,
    supportsInitialPrompt: true,
    supportsLanguageSelection: true,
    supportsSegmentTimestamps: true,
    supportsSpeedControl: false,
    supportsStreaming: false,
    supportsWordTimestamps: true,
    supportedLanguages: { kind: 'all' },
    task: 'stt',
  },
  familyId: 'whisper',
  runtime: {
    acceleratorDetails: {},
    availableAccelerators: ['cpu'],
    supportedModelFormats: ['ggml'],
  },
  runtimeId: 'whisper_cpp',
};

function readyCapabilities(
  overrides: Partial<Extract<SelectedModelCapabilities, { status: 'ready' }>> = {},
): SelectedModelCapabilities {
  return {
    capabilities: batchCapabilities,
    selection: selectedModel,
    status: 'ready',
    ...overrides,
  };
}

function createAudio(): FakeDecodedAudio {
  return new FakeDecodedAudio(16_000, 1, 639, [new Float32Array(639)]);
}

function transcriptReady(sessionId: string, text: string): TranscriptReadyEvent {
  return {
    isFinal: true,
    pauseMsBeforeUtterance: null,
    processingDurationMs: 5,
    revision: 0,
    segments: [
      {
        endMs: 1000,
        speaker: null,
        startMs: 0,
        text,
        timestampGranularity: 'utterance',
        timestampSource: 'vad',
      },
    ],
    sessionId,
    speakerIndex: null,
    stageResults: [],
    text,
    type: 'transcript_ready',
    utteranceDurationMs: 1000,
    utteranceEndMsInSession: 1000,
    utteranceId: 'utterance-1',
    utteranceIndex: 0,
    utteranceStartMsInSession: 0,
    warnings: [],
  };
}

function createHarness(
  overrides: Partial<ConstructorParameters<typeof AudioFileTranscriptionController>[0]> = {},
) {
  let target: Target | null = { id: 'original-note' };
  const sessions: FakeSession[] = [];
  const feedback = { show: vi.fn() };
  const sidecarConnection = new FakeSidecarConnection();
  const sidecarLifecycleGate = new SidecarLifecycleGate();
  const pickAudioFile = vi.fn(
    async (_signal: AbortSignal): Promise<File | null> =>
      createGeneratedWavFile('fixture.wav', {
        channelCount: 1,
        sampleRate: 16_000,
        samples: [new Float32Array([0, 0])],
      }),
  );
  const decoder = { decode: vi.fn(async (_file: File, _signal: AbortSignal) => createAudio()) };
  let settings = createSettings();
  let modelCapabilities = readyCapabilities();
  const dependencies: ConstructorParameters<typeof AudioFileTranscriptionController>[0] = {
    backpressureTimeoutMs: 100,
    createSession: (_options: CreateSessionOptions) => {
      const session = new FakeSession();
      sessions.push(session);
      return session;
    },
    decoder,
    feedback,
    getModelCapabilities: () => modelCapabilities,
    getSettings: () => settings,
    getTarget: () => target,
    isDictationBusy: () => false,
    isSameTarget: (left, right) =>
      typeof left === 'object' &&
      left !== null &&
      typeof right === 'object' &&
      right !== null &&
      'id' in left &&
      'id' in right &&
      left.id === right.id,
    logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
    onSidecarMissing: vi.fn(),
    pickAudioFile,
    sessionStopTimeoutMs: 1_000,
    sidecarConnection,
    sidecarLifecycleGate,
    stopConflictingSpeech: vi.fn(),
    ...overrides,
  };
  const controller = new AudioFileTranscriptionController(dependencies);

  return {
    controller,
    decoder,
    feedback,
    pickAudioFile,
    sessions,
    sidecarConnection,
    sidecarLifecycleGate,
    setCapabilities: (next: SelectedModelCapabilities) => {
      modelCapabilities = next;
    },
    setSettings: (next: PluginSettings) => {
      settings = next;
    },
    setTarget: (next: Target | null) => {
      target = next;
    },
  };
}

function createSettings(overrides: Partial<PluginSettings> = {}): PluginSettings {
  return {
    ...DEFAULT_PLUGIN_SETTINGS,
    dictationLanguage: 'ja',
    selectedModel,
    ...overrides,
  };
}

describe('AudioFileTranscriptionController', () => {
  it('preflights the exact target and selected batch model before opening the local picker', async () => {
    const harness = createHarness();
    harness.pickAudioFile.mockImplementation(async () => null);

    await harness.controller.transcribe();

    expect(harness.pickAudioFile).toHaveBeenCalledOnce();
    expect(harness.sidecarConnection.ensureStarted).not.toHaveBeenCalled();
    expect(harness.decoder.decode).not.toHaveBeenCalled();
    expect(harness.feedback.show).not.toHaveBeenCalled();
  });

  it('uses configured language and selected model, inserts one complete transcript, and disposes', async () => {
    const harness = createHarness();

    const transcribing = harness.controller.transcribe();
    await vi.waitFor(() =>
      expect(harness.sidecarConnection.requestStopSession).toHaveBeenCalledOnce(),
    );
    const payload = harness.sidecarConnection.startSession.mock.calls[0]?.[0];
    const session = harness.sessions[0];
    if (payload === undefined || session === undefined) {
      throw new Error('Expected an audio-file session fixture.');
    }

    expect(payload).toMatchObject({
      includeSystemAudio: false,
      language: 'ja',
      mode: 'always_on',
      modelSelection: selectedModel,
    });
    expect(harness.sidecarConnection.sendAudioFrameWithBackpressure).toHaveBeenCalledOnce();

    harness.sidecarConnection.emit(
      transcriptReady(payload.sessionId, 'Complete local transcript.'),
    );
    harness.sidecarConnection.emit({
      reason: 'user_stop',
      sessionId: payload.sessionId,
      type: 'session_stopped',
    });
    await transcribing;

    expect(session.acceptTranscript).toHaveBeenCalledOnce();
    expect(session.acceptTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ isFinal: true, text: 'Complete local transcript.' }),
    );
    expect(session.dispose).toHaveBeenCalledOnce();
    expect(harness.controller.isBusy()).toBe(false);
    expect(() => {
      const lease = harness.sidecarLifecycleGate.acquireMutation();
      lease.release();
    }).not.toThrow();
  });

  it('holds a speech lease across picker and pending decode, then cancellation unwinds it', async () => {
    let rejectDecode: ((error: unknown) => void) | undefined;
    const decoder = {
      decode: vi.fn(
        (_file: File, signal: AbortSignal) =>
          new Promise<DecodedAudioFile>((_resolve, reject) => {
            rejectDecode = reject;
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }),
      ),
    };
    const harness = createHarness({ decoder });
    const transcribing = harness.controller.transcribe();
    await vi.waitFor(() => expect(decoder.decode).toHaveBeenCalledOnce());

    expect(() => harness.sidecarLifecycleGate.acquireMutation()).toThrow();
    await harness.controller.cancel();
    rejectDecode?.(new Error('late decoder rejection'));
    await transcribing;

    expect(() => {
      const lease = harness.sidecarLifecycleGate.acquireMutation();
      lease.release();
    }).not.toThrow();
    expect(harness.sidecarConnection.startSession).not.toHaveBeenCalled();
    expect(harness.feedback.show).not.toHaveBeenCalled();
  });

  it('cancels after decode but before session start without starting the sidecar session', async () => {
    let finishEnsureStarted: (() => void) | undefined;
    const sidecarConnection = new FakeSidecarConnection();
    sidecarConnection.ensureStarted.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishEnsureStarted = resolve;
        }),
    );
    const decoded = createAudio();
    const harness = createHarness({
      decoder: { decode: async () => decoded },
      sidecarConnection,
    });

    const transcribing = harness.controller.transcribe();
    await vi.waitFor(() => expect(sidecarConnection.ensureStarted).toHaveBeenCalledOnce());
    await harness.controller.cancel();
    finishEnsureStarted?.();
    await transcribing;

    expect(sidecarConnection.startSession).not.toHaveBeenCalled();
    expect(sidecarConnection.cancelSession).toHaveBeenCalledOnce();
    expect(decoded.dispose).toHaveBeenCalledOnce();
    expect(harness.sessions[0]?.dispose).toHaveBeenCalledOnce();
    expect(harness.feedback.show).not.toHaveBeenCalled();
  });

  it('does not open the picker during sidecar maintenance and reports the conflict', async () => {
    const harness = createHarness();
    const maintenance = harness.sidecarLifecycleGate.acquireMutation();

    await harness.controller.transcribe();

    expect(harness.pickAudioFile).not.toHaveBeenCalled();
    expect(harness.feedback.show).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'audio-file-maintenance' }),
    );
    maintenance.release();
  });

  it('rejects a streaming-only model before opening the picker', async () => {
    const streamingCapabilities = {
      ...batchCapabilities,
      family: { ...batchCapabilities.family, supportsStreaming: true },
    };
    const harness = createHarness();
    harness.setCapabilities(
      readyCapabilities({ capabilities: streamingCapabilities, selection: selectedModel }),
    );

    await harness.controller.transcribe();

    expect(harness.pickAudioFile).not.toHaveBeenCalled();
    expect(harness.feedback.show).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'audio-file-model-not-batch' }),
    );
  });

  it('rejects a model-language mismatch before opening the picker', async () => {
    const harness = createHarness();
    harness.setCapabilities(
      readyCapabilities({
        capabilities: {
          ...batchCapabilities,
          family: {
            ...batchCapabilities.family,
            supportedLanguages: { kind: 'english_only' },
          },
        },
        selection: selectedModel,
      }),
    );

    await harness.controller.transcribe();

    expect(harness.pickAudioFile).not.toHaveBeenCalled();
    expect(harness.feedback.show).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'audio-file-language-unsupported' }),
    );
  });

  it('rejects a target or model changed while the picker was open', async () => {
    const staleTargetHarness = createHarness();
    staleTargetHarness.pickAudioFile.mockImplementation(async () => {
      staleTargetHarness.setTarget({ id: 'different-note' });
      return createSelectedFile();
    });

    await staleTargetHarness.controller.transcribe();

    expect(staleTargetHarness.decoder.decode).not.toHaveBeenCalled();
    expect(staleTargetHarness.feedback.show).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'audio-file-target-changed' }),
    );

    const staleModelHarness = createHarness();
    staleModelHarness.pickAudioFile.mockImplementation(async () => {
      staleModelHarness.setCapabilities({ status: 'none' });
      return createSelectedFile();
    });

    await staleModelHarness.controller.transcribe();

    expect(staleModelHarness.decoder.decode).not.toHaveBeenCalled();
    expect(staleModelHarness.feedback.show).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'audio-file-model-changed' }),
    );
  });

  it('disposes decoded audio when model capabilities become unavailable during decode', async () => {
    const decoded = createAudio();
    const harness = createHarness();
    harness.decoder.decode.mockImplementation(async () => {
      harness.setCapabilities({ status: 'none' });
      return decoded;
    });

    await harness.controller.transcribe();

    expect(decoded.dispose).toHaveBeenCalledOnce();
    expect(harness.sidecarConnection.startSession).not.toHaveBeenCalled();
    expect(harness.feedback.show).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'audio-file-model-required' }),
    );
  });

  it('stops conflicting read aloud before decoding and revalidates again before session start', async () => {
    const order: string[] = [];
    const stopConflictingSpeech = vi.fn(() => {
      order.push('stop-read-aloud');
    });
    const harness = createHarness({ stopConflictingSpeech });
    harness.pickAudioFile.mockImplementation(async () => {
      order.push('pick');
      return createSelectedFile();
    });
    harness.decoder.decode.mockImplementation(async () => {
      order.push('decode');
      harness.setTarget({ id: 'different-note' });
      return createAudio();
    });

    await harness.controller.transcribe();

    expect(order).toEqual(['pick', 'stop-read-aloud', 'decode']);
    expect(harness.sidecarConnection.startSession).not.toHaveBeenCalled();
    expect(harness.feedback.show).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'audio-file-target-changed' }),
    );
  });

  it('aborts a source blocked on bounded sidecar backpressure as soon as overload is reported', async () => {
    const decoded = createAudio();
    let writeSignal: AbortSignal | undefined;
    const sidecarConnection = new FakeSidecarConnection();
    sidecarConnection.sendAudioFrameWithBackpressure.mockImplementation(
      async (_sessionId, _frame, signal) => {
        writeSignal = signal;
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    );
    const harness = createHarness({ decoder: { decode: async () => decoded }, sidecarConnection });

    const transcribing = harness.controller.transcribe();
    await vi.waitFor(() => expect(writeSignal).toBeDefined());
    const sessionId = sidecarConnection.startSession.mock.calls[0]?.[0].sessionId ?? '';
    sidecarConnection.emit({
      code: 'utterance_queue_overload',
      message: 'queue full',
      sessionId,
      type: 'error',
    });

    await vi.waitFor(() => expect(decoded.dispose).toHaveBeenCalledOnce());
    expect(writeSignal?.aborted).toBe(true);
    sidecarConnection.emit({ reason: 'queue_overload', sessionId, type: 'session_stopped' });
    await transcribing;
    expect(harness.feedback.show).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'audio-file-queue-overload' }),
    );
  });

  it('localizes decoder, model-duration, and sidecar failures with actionable copy', async () => {
    const decoderFailure = createHarness({
      decoder: {
        decode: async () => {
          throw new (await import('../src/audio/audio-file-decoder')).AudioFileError(
            'decode_failed',
            'raw decoder detail',
          );
        },
      },
    });
    await decoderFailure.controller.transcribe();
    expect(decoderFailure.feedback.show).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'audio-file-decode-failed' }),
    );

    const modelDuration = createHarness({
      decoder: {
        decode: async () => createAudio(),
      },
    });
    modelDuration.setCapabilities(
      readyCapabilities({
        capabilities: {
          ...batchCapabilities,
          family: { ...batchCapabilities.family, maxAudioDurationSecs: 0.01 },
        },
        selection: selectedModel,
      }),
    );
    await modelDuration.controller.transcribe();
    expect(modelDuration.feedback.show).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'audio-file-model-duration' }),
    );

    const sidecarFailure = createHarness();
    sidecarFailure.sidecarConnection.ensureStarted.mockRejectedValueOnce(new Error('spawn failed'));
    await sidecarFailure.controller.transcribe();
    expect(sidecarFailure.feedback.show).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'audio-file-start-failed' }),
    );
  });
});

function createSelectedFile(): File {
  return createGeneratedWavFile('selected.wav', {
    channelCount: 1,
    sampleRate: 16_000,
    samples: [new Float32Array([0, 0])],
  });
}
