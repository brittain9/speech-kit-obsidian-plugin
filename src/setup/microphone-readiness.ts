export interface MicrophoneReadinessResult {
  error?: unknown;
  recovery: 'recheck' | 'reopen' | 'retryDevice';
  status: 'ready' | 'unavailable';
}

interface ReadinessNavigator {
  mediaDevices?: Pick<MediaDevices, 'getUserMedia'>;
  permissions?: Pick<Permissions, 'query'>;
}

export class MicrophoneReadiness {
  private lastResult: MicrophoneReadinessResult = {
    recovery: 'recheck',
    status: 'unavailable',
  };
  private mediaRequestAttempted = false;
  private pending: Promise<MicrophoneReadinessResult> | null = null;
  private ready = false;

  constructor(private readonly navigator: ReadinessNavigator | undefined = window.navigator) {}

  check(): Promise<MicrophoneReadinessResult> {
    if (this.ready) return Promise.resolve({ recovery: 'recheck', status: 'ready' });
    if (this.pending !== null) return this.pending;

    this.pending = this.runCheck().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async runCheck(): Promise<MicrophoneReadinessResult> {
    const permissionState = await this.readPermissionState();
    if (permissionState === 'denied') {
      return this.remember({
        error: namedError('NotAllowedError', 'Microphone permission denied.'),
        recovery: 'recheck',
        status: 'unavailable',
      });
    }
    if (this.mediaRequestAttempted && permissionState !== 'granted') {
      return this.remember(this.lastResult);
    }

    const mediaDevices = this.navigator?.mediaDevices;
    const getUserMedia = mediaDevices?.getUserMedia;
    if (mediaDevices === undefined || getUserMedia === undefined) {
      return this.remember({
        error: namedError('NotFoundError', 'Microphone capture is unavailable.'),
        recovery: permissionState === 'granted' ? 'retryDevice' : 'reopen',
        status: 'unavailable',
      });
    }

    this.mediaRequestAttempted = true;
    try {
      const stream = await getUserMedia.call(mediaDevices, {
        audio: true,
        video: false,
      });
      stopTracks(stream);
      this.ready = true;
      return this.remember({ recovery: 'recheck', status: 'ready' });
    } catch (error) {
      return this.remember({
        error,
        recovery: recoveryForCaptureError(error, permissionState),
        status: 'unavailable',
      });
    }
  }

  private async readPermissionState(): Promise<PermissionState | null> {
    const permissions = this.navigator?.permissions;
    const query = permissions?.query;
    if (permissions === undefined || query === undefined) return null;
    try {
      const status = await query.call(permissions, { name: 'microphone' });
      return status.state;
    } catch {
      // Electron and older Obsidian runtimes do not expose microphone in the
      // Permissions API. Fall back to one explicit getUserMedia request.
      return null;
    }
  }

  private remember(result: MicrophoneReadinessResult): MicrophoneReadinessResult {
    this.lastResult = result;
    return result;
  }
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // Continue releasing every track even if the runtime rejects one stop().
    }
  }
}

function isDeviceCaptureError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === 'NotFoundError' || name === 'NotReadableError';
}

function recoveryForCaptureError(
  error: unknown,
  permissionState: PermissionState | null,
): MicrophoneReadinessResult['recovery'] {
  if (isDeviceCaptureError(error)) {
    return permissionState === 'granted' ? 'retryDevice' : 'reopen';
  }
  return permissionState === null ? 'reopen' : 'recheck';
}

function namedError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}
