import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/audio/pcm-recorder-worklet-source', () => ({
  PCM_RECORDER_WORKLET_SOURCE: 'registerProcessor("pcm-recorder", class {});',
}));

import { AudioCaptureStream } from '../src/audio/audio-capture-stream';

class FakeMediaStreamTrack {
  private readonly endedListeners = new Set<EventListenerOrEventListenerObject>();
  public readyState: MediaStreamTrackState = 'live';
  public readonly stop = vi.fn(() => {
    this.readyState = 'ended';
    this.emitEnded();
  });

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (type === 'ended' && listener !== null) {
      this.endedListeners.add(listener);
    }
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
    if (type === 'ended' && listener !== null) {
      this.endedListeners.delete(listener);
    }
  }

  endUnexpectedly(): void {
    this.readyState = 'ended';
    this.emitEnded();
  }

  listenerCount(): number {
    return this.endedListeners.size;
  }

  private emitEnded(): void {
    const event = new Event('ended');
    for (const listener of this.endedListeners) {
      if (typeof listener === 'function') {
        listener(event);
      } else {
        listener.handleEvent(event);
      }
    }
  }
}

class FakeMediaStream {
  constructor(private readonly track: FakeMediaStreamTrack) {}

  getAudioTracks(): MediaStreamTrack[] {
    return [this.track as unknown as MediaStreamTrack];
  }

  getTracks(): MediaStreamTrack[] {
    return this.getAudioTracks();
  }
}

class FakeAudioNode {
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
}

class FakeAudioContext {
  readonly audioWorklet = { addModule: vi.fn(async (_url: string) => {}) };
  readonly destination = new FakeAudioNode();
  readonly close = vi.fn(async () => {
    this.state = 'closed';
  });
  readonly createGain = vi.fn(() => ({
    ...new FakeAudioNode(),
    gain: { value: 1 },
  }));
  readonly createMediaStreamSource = vi.fn((_stream: MediaStream) => new FakeAudioNode());
  readonly resume = vi.fn(async () => {});
  state: AudioContextState = 'running';
}

class FakeAudioWorkletNode extends FakeAudioNode {
  readonly port = { onmessage: null as ((event: MessageEvent<ArrayBuffer>) => void) | null };
}

describe('AudioCaptureStream', () => {
  beforeEach(() => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:recorder-worklet');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('releases a cancelled microphone request without disturbing a newer capture', async () => {
    const oldTrack = new FakeMediaStreamTrack();
    const newTrack = new FakeMediaStreamTrack();
    let grantOldRequest!: (stream: MediaStream) => void;
    const getUserMedia = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<MediaStream>((resolve) => {
            grantOldRequest = resolve;
          }),
      )
      .mockResolvedValueOnce(new FakeMediaStream(newTrack) as unknown as MediaStream);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    const capture = new AudioCaptureStream({});

    const oldStart = capture.start({ sessionId: 'old' }, vi.fn());
    await capture.stop(false);
    await capture.start({ sessionId: 'new' }, vi.fn());
    grantOldRequest(new FakeMediaStream(oldTrack) as unknown as MediaStream);
    await oldStart;

    expect(oldTrack.stop).toHaveBeenCalledOnce();
    expect(newTrack.stop).not.toHaveBeenCalled();
    expect(capture.isCapturing()).toBe(true);
    await capture.stop();
    expect(newTrack.stop).toHaveBeenCalledOnce();
  });

  it('releases the microphone while worklet installation is still pending', async () => {
    const track = new FakeMediaStreamTrack();
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn(async () => new FakeMediaStream(track) as unknown as MediaStream),
      },
    });
    let finishInstallation!: () => void;
    class DelayedAudioContext extends FakeAudioContext {
      override readonly audioWorklet = {
        addModule: vi.fn(
          () =>
            new Promise<void>((resolve) => {
              finishInstallation = resolve;
            }),
        ),
      };
    }
    vi.stubGlobal('AudioContext', DelayedAudioContext);
    const capture = new AudioCaptureStream({});
    const starting = capture.start({ sessionId: 'old' }, vi.fn());
    await vi.waitFor(() => expect(finishInstallation).toBeDefined());

    await capture.stop(false);
    expect(track.stop).toHaveBeenCalledOnce();
    finishInstallation();
    await starting;
    expect(capture.isCapturing()).toBe(false);
  });

  it('releases capture when microphone recording startup fails', async () => {
    const track = new FakeMediaStreamTrack();
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn(async () => new FakeMediaStream(track) as unknown as MediaStream),
      },
    });
    const recording = {
      start: vi.fn(async () => {
        throw new Error('recording failed');
      }),
      stop: vi.fn(async () => {}),
    };
    const capture = new AudioCaptureStream({});

    await expect(capture.start({ sessionId: 'failed' }, vi.fn(), recording)).rejects.toThrow(
      'recording failed',
    );
    expect(track.stop).toHaveBeenCalledOnce();
    expect(track.listenerCount()).toBe(0);
    expect(recording.stop).toHaveBeenCalledWith(false);
    expect(capture.isCapturing()).toBe(false);
  });

  it('releases the microphone while recording startup is still pending', async () => {
    const track = new FakeMediaStreamTrack();
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn(async () => new FakeMediaStream(track) as unknown as MediaStream),
      },
    });
    let finishRecordingStartup!: () => void;
    const recordingStartup = new Promise<void>((resolve) => {
      finishRecordingStartup = resolve;
    });
    const recording = {
      start: vi.fn(() => recordingStartup),
      stop: vi.fn(async () => {
        await recordingStartup;
      }),
    };
    const capture = new AudioCaptureStream({});
    const starting = capture.start({ sessionId: 'old' }, vi.fn(), recording);
    await vi.waitFor(() => expect(recording.start).toHaveBeenCalledOnce());

    const stopping = capture.stop(false);
    await vi.waitFor(() => expect(track.stop).toHaveBeenCalledOnce());
    finishRecordingStartup();
    await Promise.all([starting, stopping]);
    expect(capture.isCapturing()).toBe(false);
  });

  it('waits for recording finalization when closing the audio context fails', async () => {
    const track = new FakeMediaStreamTrack();
    vi.stubGlobal('navigator', {
      mediaDevices: {
        getUserMedia: vi.fn(async () => new FakeMediaStream(track) as unknown as MediaStream),
      },
    });
    class FailingAudioContext extends FakeAudioContext {
      override readonly close = vi.fn(async () => {
        throw new Error('close failed');
      });
    }
    vi.stubGlobal('AudioContext', FailingAudioContext);
    let finishRecording!: () => void;
    const onSaved = vi.fn();
    const recording = {
      start: vi.fn(async () => {}),
      stop: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishRecording = () => {
              onSaved();
              resolve();
            };
          }),
      ),
    };
    const capture = new AudioCaptureStream({});
    await capture.start({ sessionId: 'recording' }, vi.fn(), recording);
    let stopSettled = false;
    let stopError: unknown;
    const stopping = capture.stop(true).then(
      () => {
        stopSettled = true;
      },
      (error: unknown) => {
        stopError = error;
        stopSettled = true;
      },
    );
    await vi.waitFor(() => expect(track.stop).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stopSettled).toBe(false);
    finishRecording();
    await stopping;
    expect(stopSettled).toBe(true);
    expect(onSaved).toHaveBeenCalledOnce();
    expect(stopError).toEqual(new Error('close failed'));
  });

  it('does not retry a cancelled request with the default microphone', async () => {
    let rejectRequest!: (error: unknown) => void;
    const getUserMedia = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<MediaStream>((_resolve, reject) => {
            rejectRequest = reject;
          }),
      )
      .mockRejectedValueOnce(new Error('unexpected retry'));
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    const capture = new AudioCaptureStream({});
    const starting = capture.start({ sessionId: 'old', audioInputDeviceId: 'missing' }, vi.fn());
    await capture.stop(false);
    rejectRequest({ name: 'OverconstrainedError', constraint: 'deviceId' });
    await starting;
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it('reports an unexpected microphone track end once for the owning session', async () => {
    const track = new FakeMediaStreamTrack();
    const mediaStream = new FakeMediaStream(track);
    const getUserMedia = vi.fn(async () => mediaStream as unknown as MediaStream);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    const onUnexpectedEnd = vi.fn();
    const capture = new AudioCaptureStream({ onUnexpectedEnd });

    await capture.start({ sessionId: 'session-a' }, vi.fn());
    track.endUnexpectedly();
    track.endUnexpectedly();

    expect(onUnexpectedEnd).toHaveBeenCalledOnce();
    expect(onUnexpectedEnd).toHaveBeenCalledWith('session-a');
    expect(track.listenerCount()).toBe(1);
  });

  it('starts and finalizes an optional microphone recording with capture', async () => {
    const track = new FakeMediaStreamTrack();
    const mediaStream = new FakeMediaStream(track);
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn(async () => mediaStream as unknown as MediaStream) },
    });
    const recording = {
      discardSavedFile: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
    };
    const capture = new AudioCaptureStream({});

    await capture.start({ sessionId: 'session-recording' }, vi.fn(), recording);
    await capture.stop(true);

    expect(recording.start).toHaveBeenCalledOnce();
    expect(recording.start).toHaveBeenCalledWith(mediaStream);
    expect(recording.stop).toHaveBeenCalledOnce();
    expect(recording.stop).toHaveBeenCalledWith(true);
  });

  it('reports a device that ends while the capture graph is being initialized', async () => {
    const track = new FakeMediaStreamTrack();
    track.readyState = 'ended';
    const mediaStream = new FakeMediaStream(track);
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn(async () => mediaStream as unknown as MediaStream) },
    });
    const onUnexpectedEnd = vi.fn();
    const capture = new AudioCaptureStream({ onUnexpectedEnd });

    await capture.start({ sessionId: 'session-raced' }, vi.fn());

    expect(onUnexpectedEnd).toHaveBeenCalledOnce();
    expect(onUnexpectedEnd).toHaveBeenCalledWith('session-raced');
    await capture.stop();
    expect(onUnexpectedEnd).toHaveBeenCalledOnce();
  });

  it('removes the old track listener before teardown and rapid restart', async () => {
    const firstTrack = new FakeMediaStreamTrack();
    const secondTrack = new FakeMediaStreamTrack();
    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce(new FakeMediaStream(firstTrack) as unknown as MediaStream)
      .mockResolvedValueOnce(new FakeMediaStream(secondTrack) as unknown as MediaStream);
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    const onUnexpectedEnd = vi.fn();
    const capture = new AudioCaptureStream({ onUnexpectedEnd });

    await capture.start({ sessionId: 'session-a' }, vi.fn());
    await capture.stop();
    await capture.start({ sessionId: 'session-b' }, vi.fn());
    firstTrack.endUnexpectedly();

    expect(firstTrack.listenerCount()).toBe(0);
    expect(secondTrack.listenerCount()).toBe(1);
    expect(onUnexpectedEnd).not.toHaveBeenCalled();

    secondTrack.endUnexpectedly();
    expect(onUnexpectedEnd).toHaveBeenCalledOnce();
    expect(onUnexpectedEnd).toHaveBeenCalledWith('session-b');
  });
});
