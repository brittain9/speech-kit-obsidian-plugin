import type { SelectedModel } from '../models/model-management-types';
import { asError } from '../shared/error-utils';
import type { TranslationErrorEvent } from '../sidecar/protocol';
import type { SidecarConnection } from '../sidecar/sidecar-connection';
import type { TranslationLanguage } from './languages';

export class HyMtTranslationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: string,
  ) {
    super(message);
    this.name = 'HyMtTranslationError';
  }
}

interface HyMtTranslationOptions {
  accelerationPreference: 'auto' | 'cpu_only';
  modelSelection: SelectedModel;
  modelStorePathOverride?: string;
  onProgress: (completed: number, total: number) => void;
  onReady: () => void;
  sidecarConnection: Pick<
    SidecarConnection,
    'cancelTranslation' | 'startTranslation' | 'subscribe'
  >;
  signal: AbortSignal;
  sourceLanguage: TranslationLanguage;
  targetLanguage: TranslationLanguage;
  texts: string[];
  translationId: string;
}

export async function translateWithHyMt(options: HyMtTranslationOptions): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    let settled = false;
    const onTimeout = () => {
      finish(() =>
        reject(new HyMtTranslationError('translation_timeout', 'Translation timed out.')),
      );
      try {
        options.sidecarConnection.cancelTranslation(options.translationId);
      } catch {
        // The request is already settled even if the sidecar cannot be reached.
      }
    };
    let timeout = window.setTimeout(onTimeout, 60_000);
    const resetTimeout = () => {
      window.clearTimeout(timeout);
      timeout = window.setTimeout(onTimeout, 60_000);
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      release();
      options.signal.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => {
      finish(() => reject(new DOMException('Translation canceled.', 'AbortError')));
      try {
        options.sidecarConnection.cancelTranslation(options.translationId);
      } catch {
        // Cancellation must settle even when writing to the sidecar fails.
      }
    };
    const release = options.sidecarConnection.subscribe((event) => {
      if (event.type === 'error' && event.code === 'sidecar_exited') {
        finish(() => reject(new Error(event.message)));
        return;
      }
      if (!('translationId' in event) || event.translationId !== options.translationId) return;
      switch (event.type) {
        case 'translation_started':
          resetTimeout();
          options.onReady();
          break;
        case 'translation_progress':
          resetTimeout();
          options.onProgress(event.completed, event.total);
          break;
        case 'translation_complete':
          finish(() => resolve(event.translations));
          break;
        case 'translation_cancelled':
          finish(() => reject(new DOMException('Translation canceled.', 'AbortError')));
          break;
        case 'translation_error':
          finish(() => reject(toTranslationError(event)));
          break;
      }
    });
    options.signal.addEventListener('abort', onAbort, { once: true });
    if (options.signal.aborted) {
      onAbort();
      return;
    }
    void options.sidecarConnection
      .startTranslation({
        accelerationPreference: options.accelerationPreference,
        modelSelection: options.modelSelection,
        ...(options.modelStorePathOverride === undefined
          ? {}
          : { modelStorePathOverride: options.modelStorePathOverride }),
        sourceLanguage: options.sourceLanguage,
        targetLanguage: options.targetLanguage,
        texts: options.texts,
        translationId: options.translationId,
      })
      .catch((error: unknown) =>
        finish(() => reject(asError(error, 'Translation could not be started.'))),
      );
  });
}

function toTranslationError(event: TranslationErrorEvent): HyMtTranslationError {
  return new HyMtTranslationError(event.code, event.message, event.details);
}
