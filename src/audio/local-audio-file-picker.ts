import { AudioFileError, createAudioFileCancellationError } from './audio-file-decoder';

export async function pickLocalAudioFile(
  signal: AbortSignal,
  ownerDocument: Document = document,
): Promise<File | null> {
  if (signal.aborted) {
    throw createAudioFileCancellationError();
  }

  const input = ownerDocument.body.createEl('input');
  input.type = 'file';
  input.accept = 'audio/*';
  input.hidden = true;
  input.setAttribute('aria-hidden', 'true');

  return await new Promise<File | null>((resolve, reject) => {
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort);
      input.removeEventListener('change', onChange);
      input.removeEventListener('cancel', onCancel);
      input.remove();
    };
    const onChange = (): void => {
      cleanup();
      resolve(input.files?.[0] ?? null);
    };
    const onCancel = (): void => {
      cleanup();
      resolve(null);
    };
    const onAbort = (): void => {
      cleanup();
      reject(createAudioFileCancellationError());
    };

    signal.addEventListener('abort', onAbort, { once: true });
    input.addEventListener('change', onChange, { once: true });
    input.addEventListener('cancel', onCancel, { once: true });
    ownerDocument.body.appendChild(input);
    try {
      input.click();
    } catch (error) {
      cleanup();
      reject(
        new AudioFileError('read_failed', 'The local audio file picker could not be opened.', {
          cause: error,
        }),
      );
    }
  });
}
