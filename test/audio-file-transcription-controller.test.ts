import type { EditorView } from '@codemirror/view';
import { Platform, type TFile } from 'obsidian';
import { describe, expect, it, vi } from 'vitest';
import type { DecodedAudioFile } from '../src/audio/audio-file-decoder';
import { AudioFileTranscriptionController } from '../src/dictation/audio-file-transcription-controller';
import type { NotePlacementOptions, SurfaceDesynchronization } from '../src/editor/note-surface';
import { LocalMediaSource } from '../src/media/local-media-source';
import { MEDIA_ACQUISITION_LIMITS } from '../src/media/media-policy';
import type {
  AcquisitionEvent,
  MediaAcquireRequest,
  MediaAcquireRequestBase,
  MediaLease,
  MediaSource,
} from '../src/media/media-source';
import type {
  EngineCapabilitiesRecord,
  SelectedModel,
  SelectedModelCapabilities,
} from '../src/models/model-management-types';
import type {
  SessionAcceptResult,
  SessionRangeReplacementResult,
  SessionTarget,
} from '../src/session/session';
import type { TranscriptRevision } from '../src/session/session-journal';
import { DEFAULT_PLUGIN_SETTINGS, type PluginSettings } from '../src/settings/plugin-settings';
import type {
  SidecarEvent,
  StartSessionCommand,
  TranscriptReadyEvent,
} from '../src/sidecar/protocol';
import type { CancelSessionResult } from '../src/sidecar/sidecar-connection';
import { SidecarLifecycleGate } from '../src/sidecar/sidecar-lifecycle-gate';
import type { TranscriptRenderOptions } from '../src/transcript/renderer';
import { createGeneratedWavFile } from './fixtures/audio-file';
import { createFakeLlmRouter } from './fixtures/llm';

function createTarget(kind: SessionTarget['kind'] = 'active'): SessionTarget {
  return {
    file: { path: 'test.md' } as TFile,
    kind,
    view: {} as EditorView,
  };
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
  readonly target: SessionTarget;
}

class FakeSession {
  public readonly accepted: TranscriptRevision[] = [];
  public readonly acceptTranscript = vi.fn((revision: TranscriptRevision): SessionAcceptResult => {
    this.accepted.push(revision);
    return { kind: 'accepted' };
  });
  public joinRawSessionText(): string {
    return this.accepted
      .filter((revision) => revision.isFinal)
      .map((revision) => revision.text)
      .join(' ');
  }
  public readonly clearSessionProcessingMark = vi.fn();
  public readonly dispose = vi.fn();
  public readonly insertAdjacentToSessionRange = vi.fn(
    (_blockText: string, _placement: 'above' | 'below', _options?: { rejectUserEdits?: boolean }) =>
      true,
  );
  public readonly markSessionRangeAsProcessing = vi.fn(() => true);
  public readonly readNoteGlossary = vi.fn(
    (_maxChars: number): { text: string; truncated: boolean } | null => null,
  );
  public readonly readNoteText = vi.fn(
    (_maxChars: number): { text: string; truncated: boolean } | null => ({
      text: 'Note context',
      truncated: false,
    }),
  );
  public readonly replaceSessionRangeWithCleaned = vi.fn(
    (
      text: string,
      options?: { rawTextForCallout?: string; rejectUserEdits?: boolean; showRawBelow?: boolean },
    ): SessionRangeReplacementResult => ({
      kind: 'replaced',
      recovery: {
        documentText: text,
        file: {} as TFile,
        filePath: 'test.md',
        from: 0,
        rawText: options?.rawTextForCallout ?? this.accepted.at(-1)?.text ?? '',
        to: text.length,
        transformedText: text,
        view: {} as never,
      },
    }),
  );
  public readonly setAnchorMode = vi.fn((_mode: 'hidden' | 'visible') => {});
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
  public readonly cancelSession = vi.fn(async (sessionId: string): Promise<CancelSessionResult> => {
    this.emit({ reason: 'user_cancel', sessionId, type: 'session_stopped' });
    return { reason: 'user_cancel', sessionId, type: 'session_stopped' } as const;
  });
  public readonly ensureStarted = vi.fn(async () => {});
  public readonly issuedSessionIds: string[] = [];
  public readonly listeners = new Set<(event: SidecarEvent) => void>();
  public readonly requestStopSession = vi.fn((_sessionId: string) => {});
  public readonly sendContextResponse = vi.fn((_correlationId: string, _context: unknown) => {});
  public readonly sendAudioFrameWithBackpressure = vi.fn(
    async (_sessionId: string, _frameBytes: Uint8Array, _signal: AbortSignal) => {},
  );
  public readonly startSessionWithControl = vi.fn(
    async (
      payload: Omit<StartSessionCommand, 'type'>,
      options: {
        abortSignal?: AbortSignal;
        beforeCommandWrite?: () => void;
        onCommandIssued?: () => void;
      },
    ) => {
      await this.ensureStarted();
      options.abortSignal?.throwIfAborted();
      options.beforeCommandWrite?.();
      options.onCommandIssued?.();
      this.issuedSessionIds.push(payload.sessionId);
      this.emit({ mode: payload.mode, sessionId: payload.sessionId, type: 'session_started' });
      return { mode: payload.mode, sessionId: payload.sessionId, type: 'session_started' } as const;
    },
  );
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

type HarnessOverrides = Omit<
  Partial<ConstructorParameters<typeof AudioFileTranscriptionController>[0]>,
  'mediaEntry'
> & {
  readonly mediaEntry?: ConstructorParameters<
    typeof AudioFileTranscriptionController
  >[0]['mediaEntry'];
  readonly mediaSource?: MediaSource;
};

function createHarness(overrides: HarnessOverrides = {}) {
  let target: SessionTarget | null = createTarget();
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
  const decoder = {
    decode: vi.fn(async (_file: File, _signal: AbortSignal) => createAudio()),
    decodeMedia: vi.fn(async (_lease: MediaLease, signal: AbortSignal) => {
      return await decoder.decode(
        createGeneratedWavFile('fixture.wav', {
          channelCount: 1,
          sampleRate: 16_000,
          samples: [new Float32Array([0, 0])],
        }),
        signal,
      );
    }),
  };
  let settings = createSettings();
  let modelCapabilities = readyCapabilities();
  const configuredDecoder = { ...decoder, ...overrides.decoder } as typeof decoder;
  if (overrides.decoder?.decodeMedia === undefined) {
    configuredDecoder.decodeMedia = vi.fn(async (_lease: MediaLease, signal: AbortSignal) =>
      configuredDecoder.decode(
        createGeneratedWavFile('fixture.wav', {
          channelCount: 1,
          sampleRate: 16_000,
          samples: [new Float32Array([0, 0])],
        }),
        signal,
      ),
    );
  }
  const {
    mediaEntry: overrideMediaEntry,
    mediaSource: overrideMediaSource,
    ...dependencyOverrides
  } = overrides;
  const mediaSource = overrideMediaSource ?? new LocalMediaSource({ pickFile: pickAudioFile });
  const mediaEntry: ConstructorParameters<
    typeof AudioFileTranscriptionController
  >[0]['mediaEntry'] = overrideMediaEntry ?? {
    createRequest: (_context, request: MediaAcquireRequestBase) => ({
      ...request,
      provider: undefined,
    }),
    id: mediaSource.id,
    isEnabled: () => true,
    source: mediaSource,
  };
  const dependencies: ConstructorParameters<typeof AudioFileTranscriptionController>[0] = {
    backpressureTimeoutMs: 100,
    createSession: (_options: CreateSessionOptions) => {
      const session = new FakeSession();
      sessions.push(session);
      return session;
    },
    feedback,
    getModelCapabilities: () => modelCapabilities,
    getSettings: () => settings,
    getTarget: () => target,
    isDictationBusy: () => false,
    logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn() },
    onSidecarMissing: vi.fn(),
    sessionStopTimeoutMs: 1_000,
    sidecarConnection,
    sidecarLifecycleGate,
    stopConflictingSpeech: vi.fn(),
    ...dependencyOverrides,
    decoder: configuredDecoder,
    mediaEntry,
  };
  const controller = new AudioFileTranscriptionController(dependencies);

  return {
    controller,
    decoder: configuredDecoder,
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
    setTarget: (next: SessionTarget | null) => {
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
  it('rechecks the provider kill switch before acquiring provider media', async () => {
    const acquire = vi.fn();
    const source: MediaSource = { acquire, adapterVersion: '1', id: 'provider' };
    const harness = createHarness();
    const entry = {
      createRequest: (_context: undefined, request: MediaAcquireRequestBase) => ({
        ...request,
        provider: undefined,
      }),
      id: 'provider',
      isEnabled: () => false,
      source,
    };

    await harness.controller.transcribeProvider(entry, undefined);

    expect(acquire).not.toHaveBeenCalled();
  });

  it('cancels a provider operation after media is ready without cancelling local work', async () => {
    let resolveStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const release = vi.fn(async () => {});
    const lease: MediaLease = {
      encodedBytes: 1,
      mediaId: 'provider-ready',
      openReadStream: vi.fn(async () => new ReadableStream<Uint8Array>()),
      provenance: {
        acquiredAt: new Date(0).toISOString(),
        adapterVersion: 'test',
        sourceId: 'provider',
        temporaryMedia: true,
      },
      release,
    };
    const source: MediaSource = {
      acquire: async function* () {
        yield { plan: { displayName: 'Provider', sourceId: 'provider' }, type: 'plan' };
        yield { lease, type: 'ready' };
      },
      adapterVersion: 'test',
      id: 'provider',
    };
    const decoder = {
      decode: vi.fn(async () => createAudio()),
      decodeMedia: vi.fn(async (_lease: MediaLease, signal: AbortSignal) => {
        resolveStarted();
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        return createAudio();
      }),
    };
    const harness = createHarness({ decoder, mediaSource: source });
    const entry = {
      createRequest: (_context: undefined, request: MediaAcquireRequestBase) => ({
        ...request,
        provider: undefined,
      }),
      id: 'youtube_yt_dlp',
      isEnabled: () => true,
      source,
    };
    const operation = harness.controller.transcribeProvider(entry, undefined);
    await started;
    await harness.controller.cancelProvider('youtube_yt_dlp');
    await operation;
    expect(release).toHaveBeenCalledOnce();
    expect(harness.sidecarConnection.startSessionWithControl).not.toHaveBeenCalled();
  });

  it('guards mobile before busy state, picker, and decoder work', async () => {
    const originalDesktop = Platform.isDesktopApp;
    Platform.isDesktopApp = false;
    try {
      const harness = createHarness();
      await harness.controller.transcribe();
      expect(harness.pickAudioFile).not.toHaveBeenCalled();
      expect(harness.decoder.decode).not.toHaveBeenCalled();
      expect(harness.controller.getState()).toBe('idle');
      expect(harness.feedback.show).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'audio-file-desktop-only' }),
      );
    } finally {
      Platform.isDesktopApp = originalDesktop;
    }
  });

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
    const payload = harness.sidecarConnection.startSessionWithControl.mock.calls[0]?.[0];
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
    expect(harness.sidecarConnection.startSessionWithControl).not.toHaveBeenCalled();
    expect(harness.feedback.show).not.toHaveBeenCalled();
  });

  it('returns to an idle retryable state after a preflight model failure', async () => {
    const harness = createHarness();
    harness.setCapabilities({ status: 'none' });

    await harness.controller.transcribe();
    expect(harness.controller.getState()).toBe('idle');
    expect(harness.pickAudioFile).not.toHaveBeenCalled();

    harness.setCapabilities(readyCapabilities());
    harness.pickAudioFile.mockImplementation(async () => null);
    await harness.controller.transcribe();
    expect(harness.pickAudioFile).toHaveBeenCalledOnce();
    expect(harness.controller.getState()).toBe('idle');
  });

  it('retries a sidecar start failure without retaining the failed session', async () => {
    const sidecarConnection = new FakeSidecarConnection();
    sidecarConnection.ensureStarted.mockRejectedValueOnce(new Error('sidecar unavailable'));
    const harness = createHarness({ sidecarConnection });

    await harness.controller.transcribe();
    expect(harness.controller.getState()).toBe('idle');
    expect(harness.sessions[0]?.dispose).toHaveBeenCalledOnce();

    const retry = harness.controller.transcribe();
    await vi.waitFor(() => expect(sidecarConnection.requestStopSession).toHaveBeenCalledOnce());
    const sessionId = sidecarConnection.startSessionWithControl.mock.calls[0]?.[0].sessionId;
    if (sessionId === undefined) throw new Error('Expected a retried sidecar session.');
    sidecarConnection.emit({ reason: 'user_stop', sessionId, type: 'session_stopped' });
    await retry;
    expect(harness.controller.getState()).toBe('idle');
  });

  it('retries after a target change during preparation', async () => {
    const harness = createHarness();
    harness.pickAudioFile.mockImplementationOnce(async () => {
      harness.setTarget(createTarget());
      return createGeneratedWavFile('retry.wav', {
        channelCount: 1,
        sampleRate: 16_000,
        samples: [new Float32Array([0, 0])],
      });
    });

    await harness.controller.transcribe();
    expect(harness.controller.getState()).toBe('idle');
    expect(harness.sidecarConnection.startSessionWithControl).not.toHaveBeenCalled();

    harness.setTarget(createTarget());
    harness.pickAudioFile.mockImplementation(async () => null);
    await harness.controller.transcribe();
    expect(harness.pickAudioFile).toHaveBeenCalledTimes(2);
    expect(harness.controller.getState()).toBe('idle');
  });

  it.each(['target', 'model', 'language'] as const)(
    'revalidates %s after ensureStarted and before issuing start_session',
    async (changed) => {
      let resolveEnsure: (() => void) | undefined;
      const sidecarConnection = new FakeSidecarConnection();
      sidecarConnection.ensureStarted.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveEnsure = resolve;
          }),
      );
      const harness = createHarness({ sidecarConnection });
      const transcribing = harness.controller.transcribe();
      await vi.waitFor(() => expect(sidecarConnection.ensureStarted).toHaveBeenCalledOnce());

      if (changed === 'target') harness.setTarget(createTarget());
      if (changed === 'model') harness.setCapabilities({ status: 'none' });
      if (changed === 'language') {
        harness.setCapabilities(
          readyCapabilities({
            capabilities: {
              ...batchCapabilities,
              family: { ...batchCapabilities.family, supportedLanguages: { kind: 'english_only' } },
            },
          }),
        );
      }
      resolveEnsure?.();
      await transcribing;

      expect(sidecarConnection.issuedSessionIds).toEqual([]);
      expect(sidecarConnection.cancelSession).not.toHaveBeenCalled();
      expect(harness.controller.getState()).toBe('idle');
    },
  );

  it('returns to idle after a decode failure and can start a fresh attempt', async () => {
    const harness = createHarness();
    harness.decoder.decode.mockRejectedValueOnce(new Error('decode failed'));

    await harness.controller.transcribe();
    expect(harness.controller.getState()).toBe('idle');
    expect(harness.sidecarConnection.startSessionWithControl).not.toHaveBeenCalled();

    const retry = harness.controller.transcribe();
    await vi.waitFor(() =>
      expect(harness.sidecarConnection.requestStopSession).toHaveBeenCalledOnce(),
    );
    const sessionId =
      harness.sidecarConnection.startSessionWithControl.mock.calls[0]?.[0].sessionId;
    if (sessionId === undefined) throw new Error('Expected a retried session.');
    harness.sidecarConnection.emit({ reason: 'user_stop', sessionId, type: 'session_stopped' });
    await retry;
    expect(harness.controller.getState()).toBe('idle');
  });

  it('reports an unexpected sidecar exit as an actionable runtime failure', async () => {
    const harness = createHarness();
    const transcribing = harness.controller.transcribe();
    await vi.waitFor(() =>
      expect(harness.sidecarConnection.requestStopSession).toHaveBeenCalledOnce(),
    );

    harness.sidecarConnection.emit({
      code: 'sidecar_exited',
      message: 'The local speech engine exited unexpectedly.',
      type: 'error',
    });
    await transcribing;

    expect(harness.feedback.show).toHaveBeenCalledOnce();
    expect(harness.feedback.show).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'audio-file-sidecar-failed' }),
    );
  });

  it('keeps user cancellation silent when the sidecar exits during native cancellation', async () => {
    let resolveCancel:
      | ((value: { reason: 'user_cancel'; sessionId: string; type: 'session_stopped' }) => void)
      | undefined;
    const sidecarConnection = new FakeSidecarConnection();
    sidecarConnection.cancelSession.mockImplementation(
      async (_sessionId) =>
        await new Promise((resolve) => {
          resolveCancel = resolve;
        }),
    );
    const harness = createHarness({ sidecarConnection });
    const transcribing = harness.controller.transcribe();
    await vi.waitFor(() => expect(sidecarConnection.requestStopSession).toHaveBeenCalledOnce());
    const sessionId = sidecarConnection.startSessionWithControl.mock.calls[0]?.[0].sessionId;
    if (sessionId === undefined) throw new Error('Expected a user-cancel session.');

    const cancelling = harness.controller.cancel();
    await vi.waitFor(() => expect(sidecarConnection.cancelSession).toHaveBeenCalledOnce());
    sidecarConnection.emit({
      code: 'sidecar_exited',
      message: 'The local speech engine exited unexpectedly.',
      type: 'error',
    });
    await transcribing;
    resolveCancel?.({ reason: 'user_cancel', sessionId, type: 'session_stopped' });
    await cancelling;

    expect(harness.feedback.show).not.toHaveBeenCalled();
  });

  it('keeps disposal cancellation silent when the sidecar exits during native cancellation', async () => {
    const sidecarConnection = new FakeSidecarConnection();
    const harness = createHarness({ sidecarConnection });
    const transcribing = harness.controller.transcribe();
    await vi.waitFor(() => expect(sidecarConnection.requestStopSession).toHaveBeenCalledOnce());

    await harness.controller.dispose();
    await transcribing;

    expect(harness.feedback.show).not.toHaveBeenCalled();
  });

  it('reports an unacknowledged native cancellation once with protected-lease guidance', async () => {
    const sidecarConnection = new FakeSidecarConnection();
    sidecarConnection.cancelSession.mockRejectedValue(new Error('native cancellation timed out'));
    const harness = createHarness({ sessionStopTimeoutMs: 5, sidecarConnection });
    const transcribing = harness.controller.transcribe();
    await vi.waitFor(() => expect(sidecarConnection.requestStopSession).toHaveBeenCalledOnce());
    await new Promise<void>((resolve) => window.setTimeout(resolve, 15));
    await transcribing;

    expect(harness.feedback.show).toHaveBeenCalledOnce();
    expect(harness.feedback.show).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'audio-file-shutdown-uncertain' }),
    );
  });

  it('keeps the first terminal notice when overload is followed by sidecar exit', async () => {
    let resolveCancel:
      | ((value: { reason: 'user_cancel'; sessionId: string; type: 'session_stopped' }) => void)
      | undefined;
    const sidecarConnection = new FakeSidecarConnection();
    sidecarConnection.cancelSession.mockImplementation(
      async (_sessionId) =>
        await new Promise((resolve) => {
          resolveCancel = resolve;
        }),
    );
    const harness = createHarness({ sidecarConnection });
    const transcribing = harness.controller.transcribe();
    await vi.waitFor(() => expect(sidecarConnection.requestStopSession).toHaveBeenCalledOnce());
    const sessionId = sidecarConnection.startSessionWithControl.mock.calls[0]?.[0].sessionId;
    if (sessionId === undefined) throw new Error('Expected an overload session.');

    sidecarConnection.emit({
      code: 'utterance_queue_overload',
      message: 'Queue overloaded.',
      sessionId,
      type: 'error',
    });
    sidecarConnection.emit({
      code: 'sidecar_exited',
      message: 'The local speech engine exited unexpectedly.',
      type: 'error',
    });
    await transcribing;
    resolveCancel?.({ reason: 'user_cancel', sessionId, type: 'session_stopped' });

    expect(harness.feedback.show).toHaveBeenCalledOnce();
    expect(harness.feedback.show).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'audio-file-queue-overload' }),
    );
  });

  it('releases the session locally when cancellation is acknowledged without a subscription callback', async () => {
    const sidecarConnection = new FakeSidecarConnection();
    sidecarConnection.cancelSession.mockImplementation(async (sessionId) => ({
      reason: 'user_cancel',
      sessionId,
      type: 'session_stopped' as const,
    }));
    const harness = createHarness({ sidecarConnection });
    const transcribing = harness.controller.transcribe();
    await vi.waitFor(() => expect(sidecarConnection.requestStopSession).toHaveBeenCalledOnce());
    const sessionId = sidecarConnection.startSessionWithControl.mock.calls[0]?.[0].sessionId;
    if (sessionId === undefined) throw new Error('Expected a cancellation session.');

    await harness.controller.cancel();
    await transcribing;

    expect(sidecarConnection.cancelSession).toHaveBeenCalledWith(sessionId);
    expect(harness.sessions[0]?.dispose).toHaveBeenCalledOnce();
    expect(() => {
      const lease = harness.sidecarLifecycleGate.acquireMutation();
      lease.release();
    }).not.toThrow();
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
    const cancelling = harness.controller.cancel();
    finishEnsureStarted?.();
    await cancelling;
    await transcribing;

    expect(sidecarConnection.startSessionWithControl).toHaveBeenCalledOnce();
    expect(sidecarConnection.cancelSession).not.toHaveBeenCalled();
    expect(decoded.dispose).toHaveBeenCalledOnce();
    expect(harness.sessions[0]?.dispose).toHaveBeenCalledOnce();
    expect(harness.feedback.show).not.toHaveBeenCalled();
  });

  it('finalizes locally when cancellation happens before start issuance and never sends cancel', async () => {
    let finishStart: (() => void) | undefined;
    let startSignal: AbortSignal | undefined;
    const sidecarConnection = new FakeSidecarConnection();
    sidecarConnection.startSessionWithControl.mockImplementationOnce(
      async (_payload, options) =>
        await new Promise((resolve, reject) => {
          startSignal = options.abortSignal;
          options.abortSignal?.addEventListener(
            'abort',
            () => reject(options.abortSignal?.reason),
            {
              once: true,
            },
          );
          finishStart = () => resolve({ type: 'session_started' } as never);
        }),
    );
    const harness = createHarness({ sidecarConnection });
    const transcribing = harness.controller.transcribe();
    await vi.waitFor(() => expect(startSignal).toBeDefined());

    await harness.controller.cancel();
    finishStart?.();
    await transcribing;

    expect(sidecarConnection.cancelSession).not.toHaveBeenCalled();
    expect(sidecarConnection.ensureStarted).not.toHaveBeenCalled();
    expect(harness.sessions[0]?.dispose).toHaveBeenCalledOnce();
    expect(harness.controller.getState()).toBe('idle');
  });

  it('deduplicates native cancellation across user cancel and startup rejection', async () => {
    let rejectStart: ((error: Error) => void) | undefined;
    const sidecarConnection = new FakeSidecarConnection();
    sidecarConnection.startSessionWithControl.mockImplementationOnce(async (payload, options) => {
      await sidecarConnection.ensureStarted();
      options.beforeCommandWrite?.();
      options.onCommandIssued?.();
      sidecarConnection.issuedSessionIds.push(payload.sessionId);
      await new Promise<never>((_resolve, reject) => {
        rejectStart = reject;
      });
      return { mode: payload.mode, sessionId: payload.sessionId, type: 'session_started' } as const;
    });
    const harness = createHarness({ sidecarConnection });
    const transcribing = harness.controller.transcribe();
    await vi.waitFor(() => expect(sidecarConnection.issuedSessionIds).toHaveLength(1));

    const cancelling = harness.controller.cancel();
    await vi.waitFor(() => expect(sidecarConnection.cancelSession).toHaveBeenCalledOnce());
    rejectStart?.(new Error('startup rejected'));
    await cancelling;
    await transcribing;

    expect(sidecarConnection.cancelSession).toHaveBeenCalledOnce();
  });

  it('treats a no_active_session warning as a local successful cancellation', async () => {
    const sidecarConnection = new FakeSidecarConnection();
    sidecarConnection.cancelSession.mockImplementation(async (sessionId) => ({
      code: 'no_active_session',
      message: 'No active session',
      sessionId,
      type: 'warning' as const,
    }));
    const harness = createHarness({ sidecarConnection });
    const transcribing = harness.controller.transcribe();
    await vi.waitFor(() => expect(sidecarConnection.requestStopSession).toHaveBeenCalledOnce());

    await harness.controller.cancel();
    await transcribing;

    expect(harness.sessions[0]?.dispose).toHaveBeenCalledOnce();
    expect(() => {
      const lease = harness.sidecarLifecycleGate.acquireMutation();
      lease.release();
    }).not.toThrow();
  });

  it('quarantines the speech lease after an unacknowledged cancel until process exit', async () => {
    const sidecarConnection = new FakeSidecarConnection();
    sidecarConnection.cancelSession.mockRejectedValue(new Error('sidecar still alive'));
    const harness = createHarness({ sessionStopTimeoutMs: 5, sidecarConnection });
    const transcribing = harness.controller.transcribe();
    await vi.waitFor(() => expect(sidecarConnection.requestStopSession).toHaveBeenCalledOnce());
    await new Promise<void>((resolve) => window.setTimeout(resolve, 15));
    await transcribing;

    expect(harness.controller.getState()).toBe('idle');
    expect(() => harness.sidecarLifecycleGate.acquireMutation()).toThrow();
    sidecarConnection.emit({
      code: 'sidecar_exited',
      message: 'Sidecar exited unexpectedly',
      type: 'error',
    });
    expect(() => {
      const lease = harness.sidecarLifecycleGate.acquireMutation();
      lease.release();
    }).not.toThrow();
  });

  it.each(['session_stopped', 'warning'] as const)(
    'releases quarantined session A for a correlated %s acknowledgement while B is active',
    async (acknowledgement) => {
      const sidecarConnection = new FakeSidecarConnection();
      sidecarConnection.cancelSession.mockRejectedValue(new Error('sidecar still alive'));
      const harness = createHarness({ sessionStopTimeoutMs: 1_000, sidecarConnection });

      const first = harness.controller.transcribe();
      await vi.waitFor(() => expect(sidecarConnection.requestStopSession).toHaveBeenCalledOnce());
      await harness.controller.cancel();
      await first;
      const firstSessionId = sidecarConnection.startSessionWithControl.mock.calls[0]?.[0].sessionId;
      if (firstSessionId === undefined) throw new Error('Expected quarantined session A.');

      const second = harness.controller.transcribe();
      await vi.waitFor(() => expect(sidecarConnection.requestStopSession).toHaveBeenCalledTimes(2));
      const secondSessionId =
        sidecarConnection.startSessionWithControl.mock.calls[1]?.[0].sessionId;
      const secondEditorSession = harness.sessions[1];
      if (secondSessionId === undefined || secondEditorSession === undefined) {
        throw new Error('Expected active session B.');
      }

      sidecarConnection.emit({
        code: 'no_active_session',
        message: 'Uncorrelated warning',
        type: 'warning',
      });
      await Promise.resolve();
      expect(secondEditorSession.dispose).not.toHaveBeenCalled();
      expect(() => harness.sidecarLifecycleGate.acquireMutation()).toThrow();

      sidecarConnection.emit(
        acknowledgement === 'session_stopped'
          ? { reason: 'user_stop', sessionId: firstSessionId, type: 'session_stopped' }
          : {
              code: 'no_active_session',
              message: 'No active session',
              sessionId: firstSessionId,
              type: 'warning',
            },
      );
      await Promise.resolve();
      expect(secondEditorSession.dispose).not.toHaveBeenCalled();

      sidecarConnection.emit({
        reason: 'user_stop',
        sessionId: secondSessionId,
        type: 'session_stopped',
      });
      await second;
      expect(secondEditorSession.dispose).toHaveBeenCalledOnce();
    },
  );

  it('awaits managed startup unwinding during dispose', async () => {
    let resolveEnsure: (() => void) | undefined;
    const sidecarConnection = new FakeSidecarConnection();
    sidecarConnection.ensureStarted.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveEnsure = resolve;
        }),
    );
    const harness = createHarness({ sidecarConnection });
    const transcribing = harness.controller.transcribe();
    await vi.waitFor(() => expect(sidecarConnection.ensureStarted).toHaveBeenCalledOnce());

    const disposing = harness.controller.dispose();
    resolveEnsure?.();
    await Promise.all([disposing, transcribing]);

    expect(sidecarConnection.issuedSessionIds).toEqual([]);
    expect(sidecarConnection.cancelSession).not.toHaveBeenCalled();
    expect(harness.controller.getState()).toBe('idle');
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
      staleTargetHarness.setTarget(createTarget());
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
    expect(harness.sidecarConnection.startSessionWithControl).not.toHaveBeenCalled();
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
      harness.setTarget(createTarget());
      return createAudio();
    });

    await harness.controller.transcribe();

    expect(order).toEqual(['pick', 'stop-read-aloud', 'decode']);
    expect(harness.sidecarConnection.startSessionWithControl).not.toHaveBeenCalled();
    expect(harness.feedback.show).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'audio-file-target-changed' }),
    );
  });

  it('does not deadlock when projection rejection precedes asynchronous session_stopped', async () => {
    let resolveCancel:
      | ((value: { reason: 'user_cancel'; sessionId: string; type: 'session_stopped' }) => void)
      | undefined;
    const sidecarConnection = new FakeSidecarConnection();
    sidecarConnection.cancelSession.mockImplementation(
      async (_sessionId) =>
        await new Promise((resolve) => {
          resolveCancel = resolve;
        }),
    );
    const harness = createHarness({ sidecarConnection });
    const transcribing = harness.controller.transcribe();
    await vi.waitFor(() => expect(sidecarConnection.requestStopSession).toHaveBeenCalledOnce());
    const sessionId = sidecarConnection.startSessionWithControl.mock.calls[0]?.[0].sessionId;
    const session = harness.sessions[0];
    if (sessionId === undefined || session === undefined) {
      throw new Error('Expected a projection test session.');
    }
    session.acceptTranscript.mockReturnValueOnce({ kind: 'rejected', reason: 'surface changed' });

    sidecarConnection.emit(transcriptReady(sessionId, 'rejected'));
    await vi.waitFor(() => expect(sidecarConnection.cancelSession).toHaveBeenCalledOnce());
    sidecarConnection.emit({ reason: 'user_stop', sessionId, type: 'session_stopped' });
    await transcribing;
    resolveCancel?.({ reason: 'user_cancel', sessionId, type: 'session_stopped' });

    expect(session.dispose).toHaveBeenCalledOnce();
    expect(harness.controller.getState()).toBe('idle');
  });

  it('disposes the editor session even when clearing its processing mark fails', async () => {
    const harness = createHarness();
    const transcribing = harness.controller.transcribe();
    await vi.waitFor(() =>
      expect(harness.sidecarConnection.requestStopSession).toHaveBeenCalledOnce(),
    );
    const session = harness.sessions[0];
    const sessionId =
      harness.sidecarConnection.startSessionWithControl.mock.calls[0]?.[0].sessionId;
    if (session === undefined || sessionId === undefined) {
      throw new Error('Expected a cleanup test session.');
    }
    session.clearSessionProcessingMark.mockImplementationOnce(() => {
      throw new Error('mark cleanup failed');
    });

    harness.sidecarConnection.emit({ reason: 'user_stop', sessionId, type: 'session_stopped' });
    await transcribing;

    expect(session.dispose).toHaveBeenCalledOnce();
    expect(harness.controller.getState()).toBe('idle');
  });

  it('does not request a graceful stop when cancellation wins the final-frame race', async () => {
    const sidecarConnection = new FakeSidecarConnection();
    const harness = createHarness({ sidecarConnection });
    sidecarConnection.sendAudioFrameWithBackpressure.mockImplementation(async () => {
      void harness.controller.cancel();
    });

    await harness.controller.transcribe();

    expect(sidecarConnection.requestStopSession).not.toHaveBeenCalled();
    expect(sidecarConnection.cancelSession).toHaveBeenCalledOnce();
    expect(harness.feedback.show).not.toHaveBeenCalled();
    expect(harness.controller.getState()).toBe('idle');
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
    const harness = createHarness({
      decoder: { decode: async () => decoded },
      sidecarConnection,
    });

    const transcribing = harness.controller.transcribe();
    await vi.waitFor(() => expect(writeSignal).toBeDefined());
    const sessionId = sidecarConnection.startSessionWithControl.mock.calls[0]?.[0].sessionId ?? '';
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
    expect(sidecarConnection.requestStopSession).not.toHaveBeenCalled();
    expect(sidecarConnection.cancelSession).toHaveBeenCalledOnce();
    expect(harness.feedback.show).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'audio-file-queue-overload' }),
    );
  });

  it('cancels natively when backpressure reaches its finite deadline', async () => {
    const sidecarConnection = new FakeSidecarConnection();
    let writes = 0;
    sidecarConnection.sendAudioFrameWithBackpressure.mockImplementation(async () => {
      writes += 1;
      if (writes === 1) {
        const sessionId = sidecarConnection.startSessionWithControl.mock.calls[0]?.[0].sessionId;
        if (sessionId !== undefined) {
          sidecarConnection.emit({
            queuedUtterances: 4,
            sessionId,
            tier: 'falling_behind',
            type: 'transcription_queue_changed',
          });
        }
      }
    });
    const decoded = new FakeDecodedAudio(48_000, 1, 1_950, [new Float32Array(1_950)]);
    const harness = createHarness({
      backpressureTimeoutMs: 5,
      decoder: { decode: async () => decoded },
      sidecarConnection,
    });
    const transcribing = harness.controller.transcribe();
    await vi.waitFor(() => expect(writes).toBeGreaterThanOrEqual(1));
    await new Promise<void>((resolve) => window.setTimeout(resolve, 15));
    await transcribing;

    expect(sidecarConnection.requestStopSession).not.toHaveBeenCalled();
    expect(sidecarConnection.cancelSession).toHaveBeenCalledOnce();
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

  it('adapts the local source lease into the provider-neutral pipeline and releases it', async () => {
    const release = vi.fn(async () => {});
    const lease: MediaLease & { readonly youtubeProvenance: { readonly title: string } } = {
      encodedBytes: 44,
      mediaId: 'media-test',
      openReadStream: vi.fn(async () => new ReadableStream<Uint8Array>()),
      provenance: {
        acquiredAt: new Date(0).toISOString(),
        adapterVersion: '1',
        sourceId: 'local_file',
        temporaryMedia: true,
      },
      youtubeProvenance: { title: 'Private title' },
      release,
    };
    let acquisitionRequest: MediaAcquireRequest | null = null;
    const source = {
      acquire: async function* (request: MediaAcquireRequest): AsyncIterable<AcquisitionEvent> {
        acquisitionRequest = request;
        yield {
          plan: { displayName: 'Local audio file', sourceId: 'local_file' },
          type: 'plan',
        };
        yield { bytes: 0, phase: 'read', totalBytes: lease.encodedBytes, type: 'progress' };
        yield { lease, type: 'ready' };
      },
      adapterVersion: '1',
      id: 'local_file' as const,
    };
    const progress: string[] = [];
    const decoded = createAudio();
    const decodeMedia = vi.fn(async (_lease: MediaLease, _signal: AbortSignal) => decoded);
    const harness = createHarness({
      decoder: {
        decode: async () => decoded,
        decodeMedia,
      },
      mediaSource: source,
      onMediaProgress: (event) => {
        if (event !== null) progress.push(event.phase);
      },
    });

    const transcribing = harness.controller.transcribe();
    await vi.waitFor(() =>
      expect(harness.sidecarConnection.requestStopSession).toHaveBeenCalledOnce(),
    );
    const payload = harness.sidecarConnection.startSessionWithControl.mock.calls[0]?.[0];
    if (payload === undefined) throw new Error('Expected a media session.');
    harness.sidecarConnection.emit(transcriptReady(payload.sessionId, 'Media transcript'));
    harness.sidecarConnection.emit({
      reason: 'user_stop',
      sessionId: payload.sessionId,
      type: 'session_stopped',
    });
    await transcribing;

    expect(acquisitionRequest).toMatchObject({
      kind: 'interactive',
      ...MEDIA_ACQUISITION_LIMITS,
    });
    expect(harness.pickAudioFile).not.toHaveBeenCalled();
    expect(decodeMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        encodedBytes: lease.encodedBytes,
        mediaId: lease.mediaId,
        provenance: lease.provenance,
      }),
      expect.any(AbortSignal),
    );
    expect(decodeMedia.mock.calls[0]?.[0]).not.toHaveProperty('youtubeProvenance');
    expect(release).toHaveBeenCalledOnce();
    expect(progress).toEqual(
      expect.arrayContaining(['acquire', 'decode', 'transcribe', 'format', 'insert']),
    );
  });

  it('does not create an LLM router when media processing is off', async () => {
    const createLlmRouter = vi.fn(() => null);
    const harness = createHarness({ createLlmRouter });
    const transcribing = harness.controller.transcribe();
    await vi.waitFor(() =>
      expect(harness.sidecarConnection.requestStopSession).toHaveBeenCalledOnce(),
    );
    const sessionId =
      harness.sidecarConnection.startSessionWithControl.mock.calls[0]?.[0].sessionId;
    if (sessionId === undefined) throw new Error('Expected a raw media session.');
    harness.sidecarConnection.emit(transcriptReady(sessionId, 'Raw transcript.'));
    harness.sidecarConnection.emit({ reason: 'user_stop', sessionId, type: 'session_stopped' });
    await transcribing;

    expect(createLlmRouter).not.toHaveBeenCalled();
  });

  it('keeps the raw media transcript until explicit LLM confirmation and records recovery', async () => {
    const cleanup = vi.fn(async (_options: unknown) => ({
      model: 'fake-model',
      providerId: 'ollama' as const,
      text: 'Clean media transcript.',
    }));
    const confirm = vi.fn(async () => true);
    const recoveries: unknown[] = [];
    const progress: string[] = [];
    const harness = createHarness({
      confirmMediaLlm: confirm,
      createLlmRouter: () => createFakeLlmRouter({ cleanup }),
      getSettings: () =>
        createSettings({
          llmProviderConfigurations: {
            ...DEFAULT_PLUGIN_SETTINGS.llmProviderConfigurations,
            ollama: { model: 'fake-model' },
          },
          llmRoutingPolicy: { kind: 'fixed', providerId: 'ollama' },
          mediaLlmProcessing: true,
        }),
      onMediaProgress: (event) => {
        if (event !== null) progress.push(event.phase);
      },
      onRawTranscriptRecoveryAvailable: (receipt) => recoveries.push(receipt),
    });

    const transcribing = harness.controller.transcribe();
    await vi.waitFor(() =>
      expect(harness.sidecarConnection.requestStopSession).toHaveBeenCalledOnce(),
    );
    const sessionId =
      harness.sidecarConnection.startSessionWithControl.mock.calls[0]?.[0].sessionId;
    if (sessionId === undefined) throw new Error('Expected a media LLM session.');
    harness.sidecarConnection.emit(transcriptReady(sessionId, 'Raw media transcript.'));
    harness.sidecarConnection.emit({ reason: 'user_stop', sessionId, type: 'session_stopped' });
    await transcribing;

    expect(cleanup).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: expect.stringContaining(
          '<media_transcript>\nRaw media transcript.\n</media_transcript>',
        ),
      }),
    );
    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({ output: 'replace', text: 'Clean media transcript.' }),
      expect.any(AbortSignal),
    );
    expect(progress).toContain('ai_processing');
    expect(harness.sessions[0]?.replaceSessionRangeWithCleaned).toHaveBeenCalledWith(
      'Clean media transcript.',
      expect.objectContaining({
        rawTextForCallout: 'Raw media transcript.',
        rejectUserEdits: true,
      }),
    );
    expect(recoveries).toHaveLength(1);
    expect(harness.feedback.show).not.toHaveBeenCalledWith(
      expect.objectContaining({ key: 'media-llm-failed' }),
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
