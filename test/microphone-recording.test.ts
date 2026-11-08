import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MicrophoneRecording, MicrophoneRecordingWriter } from '../src/audio/microphone-recording';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
  vi.unstubAllGlobals();
});

async function createWriter() {
  const directory = await mkdtemp(join(tmpdir(), 'speech-kit-mic-recording-'));
  temporaryDirectories.push(directory);
  const fullPath = join(directory, 'voice-recording.webm');
  const file = { path: 'Attachments/Voice recording.webm' };
  const app = {
    fileManager: {
      generateMarkdownLink: vi.fn(() => '[[Voice recording.webm]]'),
      getAvailablePathForAttachment: vi.fn(async () => file.path),
      trashFile: vi.fn(async () => {
        await rm(fullPath, { force: true });
      }),
    },
    vault: {
      adapter: { getFullPath: vi.fn(() => fullPath) },
      createBinary: vi.fn(async () => {
        await writeFile(fullPath, new Uint8Array());
        return file;
      }),
    },
  };
  return {
    app,
    file,
    fullPath,
    writer: new MicrophoneRecordingWriter(app as never, 'Notes/Meeting.md'),
  };
}

describe('MicrophoneRecordingWriter', () => {
  it('streams chunks into the configured Obsidian attachment and returns its native link', async () => {
    const { app, file, fullPath, writer } = await createWriter();

    await writer.start('audio/webm;codecs=opus');
    await writer.write(new Blob([new Uint8Array([1, 2, 3])]));
    await writer.write(new Blob([new Uint8Array([4, 5])]));
    const link = await writer.finish();

    expect(app.fileManager.getAvailablePathForAttachment).toHaveBeenCalledWith(
      expect.stringMatching(/^Voice recording .*\.webm$/),
      'Notes/Meeting.md',
    );
    expect(app.vault.createBinary).toHaveBeenCalledWith(file.path, new ArrayBuffer(0));
    expect(app.vault.adapter.getFullPath).toHaveBeenCalledWith(file.path);
    expect([...(await readFile(fullPath))]).toEqual([1, 2, 3, 4, 5]);
    expect(app.fileManager.generateMarkdownLink).toHaveBeenCalledWith(file, 'Notes/Meeting.md');
    expect(link).toBe('![[Voice recording.webm]]');
  });

  it('deletes an incomplete attachment when queued chunks exceed the limit', async () => {
    const { app, writer } = await createWriter();

    await writer.start('audio/webm');
    const firstWrite = writer.write(new Blob([new Uint8Array(5_000_000)]));
    const overflowWrite = writer.write(new Blob([new Uint8Array(5_000_000)]));
    await expect(overflowWrite).rejects.toThrow('recording write queue exceeded its limit');
    await firstWrite;
    await expect(writer.finish()).rejects.toThrow('recording write queue exceeded its limit');

    expect(app.fileManager.trashFile).toHaveBeenCalledWith({
      path: 'Attachments/Voice recording.webm',
    });
    expect(app.fileManager.generateMarkdownLink).not.toHaveBeenCalled();
  });
});

describe('MicrophoneRecording', () => {
  it('discards an unstarted recording when stopped during attachment setup', async () => {
    const { app, writer } = await createWriter();
    let releaseAttachmentPath = (_path: string) => {};
    app.fileManager.getAvailablePathForAttachment.mockImplementationOnce(
      () => new Promise((resolve) => (releaseAttachmentPath = resolve)),
    );
    const startRecorder = vi.fn(() => {
      throw new Error('inactive stream');
    });
    class FakeMediaRecorder extends EventTarget {
      mimeType = 'audio/webm';
      state: RecordingState = 'inactive';
      start = startRecorder;
      constructor(_stream: MediaStream) {
        super();
      }
    }
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    const onSaved = vi.fn();
    const onError = vi.fn();
    const recording = new MicrophoneRecording(writer, onSaved, onError);
    const starting = recording.start({} as MediaStream);
    const stopping = recording.stop(true);
    releaseAttachmentPath('Attachments/Voice recording.webm');
    await Promise.all([starting, stopping]);
    expect(startRecorder).not.toHaveBeenCalled();
    expect(app.fileManager.trashFile).toHaveBeenCalledOnce();
    expect(onSaved).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('waits for the final chunk when the recorder stops before dictation stops', async () => {
    const { fullPath, writer } = await createWriter();
    class FakeMediaRecorder extends EventTarget {
      mimeType = 'audio/webm';
      state: RecordingState = 'inactive';
      static last: FakeMediaRecorder;
      constructor(_stream: MediaStream) {
        super();
        FakeMediaRecorder.last = this;
      }
      start(): void {
        this.state = 'recording';
      }
      endTrack(): void {
        this.state = 'inactive';
      }
      flush(): void {
        this.dispatchEvent(
          Object.assign(new Event('dataavailable'), { data: new Blob([new Uint8Array([7, 8])]) }),
        );
        this.dispatchEvent(new Event('stop'));
      }
    }
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    const onSaved = vi.fn();
    const recording = new MicrophoneRecording(writer, onSaved, vi.fn());
    await recording.start({} as MediaStream);
    FakeMediaRecorder.last.endTrack();
    const stopping = recording.stop(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onSaved).not.toHaveBeenCalled();
    FakeMediaRecorder.last.flush();
    await stopping;
    expect([...(await readFile(fullPath))]).toEqual([7, 8]);
    expect(onSaved).toHaveBeenCalledOnce();
  });

  it('waits for recorder startup before cancelling during capture startup', async () => {
    const { app, writer } = await createWriter();
    let releaseAttachmentPath = (_path: string) => {};
    app.fileManager.getAvailablePathForAttachment.mockImplementationOnce(
      () => new Promise((resolve) => (releaseAttachmentPath = resolve)),
    );
    class FakeMediaRecorder extends EventTarget {
      mimeType = 'audio/webm';
      state: RecordingState = 'inactive';
      static last: FakeMediaRecorder;

      constructor(_stream: MediaStream) {
        super();
        FakeMediaRecorder.last = this;
      }

      start(): void {
        this.state = 'recording';
      }

      stop(): void {
        this.state = 'inactive';
        this.dispatchEvent(Object.assign(new Event('dataavailable'), { data: new Blob([]) }));
        this.dispatchEvent(new Event('stop'));
      }
    }
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    const onSaved = vi.fn();
    const recording = new MicrophoneRecording(writer, onSaved, vi.fn());

    const starting = recording.start({} as MediaStream);
    const stopping = recording.stop(false);
    releaseAttachmentPath('Attachments/Voice recording.webm');
    await Promise.all([starting, stopping]);

    expect(FakeMediaRecorder.last.state).toBe('inactive');
    expect(app.fileManager.trashFile).toHaveBeenCalledOnce();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('records MediaRecorder chunks to the vault and finishes with a native link', async () => {
    const { app, fullPath, writer } = await createWriter();
    class FakeMediaRecorder extends EventTarget {
      mimeType = 'audio/webm;codecs=opus';
      state: RecordingState = 'inactive';
      static last: FakeMediaRecorder;

      constructor(_stream: MediaStream) {
        super();
        FakeMediaRecorder.last = this;
      }

      start(): void {
        this.state = 'recording';
      }

      stop(): void {
        this.state = 'inactive';
        this.dispatchEvent(Object.assign(new Event('dataavailable'), { data: new Blob([]) }));
        this.dispatchEvent(new Event('stop'));
      }
    }
    vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
    const onSaved = vi.fn();
    const recording = new MicrophoneRecording(writer, onSaved, vi.fn());

    await recording.start({} as MediaStream);
    const chunk = new Blob([new Uint8Array([1, 2, 3])]);
    FakeMediaRecorder.last.dispatchEvent(
      Object.assign(new Event('dataavailable'), { data: chunk }),
    );
    await recording.stop(true);

    expect([...(await readFile(fullPath))]).toEqual([1, 2, 3]);
    expect(onSaved).toHaveBeenCalledWith('![[Voice recording.webm]]');
    expect(app.fileManager.generateMarkdownLink).toHaveBeenCalledOnce();
  });
});
