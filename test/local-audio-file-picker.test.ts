import { describe, expect, it, vi } from 'vitest';
import { pickLocalAudioFile } from '../src/audio/local-audio-file-picker';

class FakeInput {
  public accept = '';
  public readonly click = vi.fn(() => {});
  public files: FileList | null = null;
  public hidden = false;
  public type = '';
  private readonly listeners = new Map<string, Set<() => void>>();
  public readonly remove = vi.fn(() => {
    this.ownerDocument.body.removeChild(this);
  });

  constructor(private readonly ownerDocument: FakeDocument) {}

  addEventListener(type: string, listener: () => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  setAttribute(): void {}

  dispatch(type: string): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener();
    }
  }
}

class FakeDocument {
  public readonly win = this;
  public readonly append = vi.fn((input: FakeInput) => {
    this.body.appendChild(input);
  });
  public readonly body = {
    children: [] as FakeInput[],
    createEl: (tag: string): FakeInput => this.createEl(tag),
    appendChild(input: FakeInput): FakeInput {
      this.children.push(input);
      return input;
    },
    removeChild(input: FakeInput): void {
      this.children = this.children.filter((candidate) => candidate !== input);
    },
  };

  createEl(tag: string): FakeInput {
    if (tag !== 'input') {
      throw new Error(`Unexpected fake element ${tag}.`);
    }
    return new FakeInput(this);
  }
}

function asDocument(fake: FakeDocument): Document {
  return fake as unknown as Document;
}

describe('pickLocalAudioFile', () => {
  it('uses a local audio-only file input and resolves the selected File', async () => {
    const fakeDocument = new FakeDocument();
    const picking = pickLocalAudioFile(new AbortController().signal, asDocument(fakeDocument));
    const input = fakeDocument.body.children[0];
    if (input === undefined) {
      throw new Error('Expected the picker input to be attached.');
    }

    expect(input.type).toBe('file');
    expect(input.accept).toBe('audio/*,video/*,.mkv,.webm,.mov,.mp4');
    expect(input.hidden).toBe(true);
    expect(input.click).toHaveBeenCalledOnce();

    const file = new File(['audio'], 'local.wav', { type: 'audio/wav' });
    input.files = { 0: file, length: 1 } as unknown as FileList;
    input.dispatch('change');

    await expect(picking).resolves.toBe(file);
    expect(fakeDocument.body.children).toEqual([]);
  });

  it('treats picker cancellation as a normal no-op', async () => {
    const fakeDocument = new FakeDocument();
    const picking = pickLocalAudioFile(new AbortController().signal, asDocument(fakeDocument));
    const input = fakeDocument.body.children[0];
    if (input === undefined) {
      throw new Error('Expected the picker input to be attached.');
    }
    input.dispatch('cancel');

    await expect(picking).resolves.toBeNull();
  });

  it('removes the temporary input and rejects when the pending start is cancelled', async () => {
    const fakeDocument = new FakeDocument();
    const abortController = new AbortController();
    const picking = pickLocalAudioFile(abortController.signal, asDocument(fakeDocument));
    const assertion = expect(picking).rejects.toMatchObject({ code: 'cancelled' });

    abortController.abort();

    await assertion;
    expect(fakeDocument.body.children).toEqual([]);
  });
});
