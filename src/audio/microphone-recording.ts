import { type FileHandle, open } from 'node:fs/promises';
import type { App, FileSystemAdapter, TFile } from 'obsidian';

const MAX_PENDING_RECORDING_BYTES = 8 * 1024 * 1024;

type RecordingApp = Pick<App, 'fileManager' | 'vault'>;

export interface MicrophoneRecordingLike {
  discardSavedFile(): Promise<void>;
  start(stream: MediaStream): Promise<void>;
  stop(save: boolean): Promise<void>;
}

export class MicrophoneRecording implements MicrophoneRecordingLike {
  private recorder: MediaRecorder | null = null;
  private failed = false;
  private startup: Promise<void> = Promise.resolve();
  private stopped: Promise<void> | null = null;

  constructor(
    private readonly writer: MicrophoneRecordingWriter,
    private readonly onSaved: (link: string) => void,
    private readonly onError: (error: unknown) => void,
  ) {}

  start(stream: MediaStream): Promise<void> {
    this.startup = this.startRecorder(stream);
    return this.startup;
  }

  async stop(save: boolean): Promise<void> {
    await this.startup;
    const recorder = this.recorder;
    this.recorder = null;
    if (recorder !== null && recorder.state !== 'inactive') {
      this.stopped = new Promise((resolve) =>
        recorder.addEventListener('stop', () => resolve(), { once: true }),
      );
      recorder.stop();
      await this.stopped;
    }

    if (!save || this.failed) {
      try {
        await this.writer.cancel();
      } catch (error) {
        this.fail(error);
      }
      return;
    }

    try {
      this.onSaved(await this.writer.finish());
    } catch (error) {
      this.fail(error);
    }
  }

  discardSavedFile(): Promise<void> {
    return this.writer.discardSavedFile().catch((error: unknown) => this.fail(error));
  }

  private async startRecorder(stream: MediaStream): Promise<void> {
    try {
      const recorder = new MediaRecorder(stream);
      this.recorder = recorder;
      await this.writer.start(recorder.mimeType || 'audio/webm');
      recorder.addEventListener('dataavailable', (event) => {
        const chunk = event.data;
        void this.writer.write(chunk).catch((error: unknown) => this.fail(error));
      });
      recorder.addEventListener('error', (event) => this.fail(event));
      recorder.start(1_000);
    } catch (error) {
      this.fail(error);
      try {
        await this.writer.cancel();
      } catch (cleanupError) {
        this.fail(cleanupError);
      }
    }
  }

  private fail(error: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.onError(error);
    if (this.recorder?.state === 'recording') this.recorder.stop();
  }
}

export class MicrophoneRecordingWriter {
  private file: TFile | null = null;
  private fileHandle: FileHandle | null = null;
  private failure: Error | null = null;
  private pendingBytes = 0;
  private writeTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly app: RecordingApp,
    private readonly sourcePath: string,
  ) {}

  async start(mimeType: string): Promise<void> {
    if (this.file !== null) throw new Error('Microphone recording already started.');

    const extension = extensionForMimeType(mimeType);
    const filename = `Voice recording ${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`;
    const path = await this.app.fileManager.getAvailablePathForAttachment(
      filename,
      this.sourcePath,
    );
    this.file = await this.app.vault.createBinary(path, new ArrayBuffer(0));
    // The plugin is desktop-only, so the vault uses Obsidian's local adapter.
    const adapter = this.app.vault.adapter as FileSystemAdapter;
    this.fileHandle = await open(adapter.getFullPath(path), 'a');
  }

  write(chunk: Blob): Promise<void> {
    if (this.failure !== null) return Promise.reject(this.failure);
    if (this.file === null)
      return Promise.reject(new Error('Microphone recording has not started.'));
    if (chunk.size === 0) return Promise.resolve();

    if (this.pendingBytes + chunk.size > MAX_PENDING_RECORDING_BYTES) {
      this.failure = new Error('recording write queue exceeded its limit');
      return Promise.reject(this.failure);
    }

    const fileHandle = this.fileHandle;
    if (fileHandle === null) return Promise.reject(new Error('Microphone recording is closed.'));
    this.pendingBytes += chunk.size;
    const write = this.writeTail.then(async () => {
      await fileHandle.appendFile(new Uint8Array(await chunk.arrayBuffer()));
    });
    this.writeTail = write.finally(() => {
      this.pendingBytes -= chunk.size;
    });
    this.writeTail.catch((error: unknown) => {
      this.failure ??= error instanceof Error ? error : new Error(String(error));
    });
    return this.writeTail;
  }

  async finish(): Promise<string> {
    await this.finishWrites();
    await this.closeFileHandle();
    if (this.failure !== null) {
      await this.deleteIncompleteFile();
      throw this.failure;
    }
    if (this.file === null) throw new Error('Microphone recording has not started.');
    return this.app.fileManager.generateMarkdownLink(this.file, this.sourcePath);
  }

  async cancel(): Promise<void> {
    await this.finishWrites();
    await this.deleteIncompleteFile();
  }

  async discardSavedFile(): Promise<void> {
    await this.finishWrites();
    await this.deleteIncompleteFile();
  }

  private async finishWrites(): Promise<void> {
    await this.writeTail.catch(() => {});
  }

  private async closeFileHandle(): Promise<void> {
    const fileHandle = this.fileHandle;
    this.fileHandle = null;
    await fileHandle?.close();
  }

  private async deleteIncompleteFile(): Promise<void> {
    await this.closeFileHandle();
    const file = this.file;
    this.file = null;
    if (file !== null) await this.app.fileManager.trashFile(file);
  }
}

function extensionForMimeType(mimeType: string): string {
  const mediaType = mimeType.split(';', 1)[0]?.trim().toLowerCase();
  switch (mediaType) {
    case 'audio/ogg':
      return 'ogg';
    case 'audio/mp4':
      return 'm4a';
    case 'audio/webm':
      return 'webm';
    default:
      throw new Error(`Unsupported microphone recording format: ${mimeType}`);
  }
}
