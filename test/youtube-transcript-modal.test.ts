import { Modal, Setting } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { MediaTranscriptionJobOptions } from '../src/media/media-transcription-options';
import { DEFAULT_PLUGIN_SETTINGS } from '../src/settings/plugin-settings';
import { t } from '../src/shared/i18n';
import { YouTubeTranscriptModalRegistry } from '../src/ui/youtube-transcript-modal';
import type { TestElement } from './__mocks__/obsidian';

type ModalFixture = { contentEl: TestElement };
interface SettingFixture {
  readonly name: string;
  readonly extraButtonComponents: Array<{ tooltip: string; click(): Promise<void> }>;
  readonly textComponents: Array<{ change(value: string): void }>;
  readonly dropdownComponents: Array<{ change(value: string): void }>;
  readonly buttonComponents: Array<{
    readonly buttonEl: TestElement;
    readonly disabled: boolean;
    readonly text: string;
    click(): Promise<void>;
  }>;
}
const settings = (): SettingFixture[] =>
  (Setting as unknown as { instances: SettingFixture[] }).instances;

function buttonNamed(name: string): SettingFixture['buttonComponents'][number] {
  const button = settings()
    .flatMap(({ buttonComponents }) => buttonComponents)
    .find((candidate) => candidate.text === name);
  if (button === undefined) throw new Error(`Button not found: ${name}`);
  return button;
}

afterEach(() => {
  settings().length = 0;
  (Modal as unknown as { instances: unknown[] }).instances.length = 0;
});

describe('YouTube transcript modal', () => {
  it('opens the preset editor and refreshes the selection after it closes', async () => {
    let onClosed: (() => void) | undefined;
    const onManagePresets = vi.fn((callback: () => void) => {
      onClosed = callback;
    });
    const registry = new YouTubeTranscriptModalRegistry();
    registry.open({} as never, {
      cancel: vi.fn(async () => {}),
      getProgress: () => null,
      getPartialTranscript: () => null,
      getResultSource: () => null,
      getAiOutcome: () => null,
      getSettings: () => DEFAULT_PLUGIN_SETTINGS,
      insertPartialTranscript: () => false,
      isBusy: () => false,
      onManagePresets,
      start: vi.fn(async () => {}),
      subscribeProgress: () => () => {},
    });

    const opener = settings()
      .flatMap(({ extraButtonComponents }) => extraButtonComponents)
      .find(({ tooltip }) => tooltip === t('llm.preset.manager.title'));
    expect(opener).toBeDefined();
    await opener?.click();
    expect(onManagePresets).toHaveBeenCalledOnce();
    onClosed?.();
    expect(settings().filter(({ name }) => name === t('youtube.modal.aiPreset'))).toHaveLength(2);
    registry.closeAll();
  });

  it('accepts a timestamped link and passes the job options without saving them', async () => {
    const saved = {
      ...DEFAULT_PLUGIN_SETTINGS,
      llmRoutingPolicy: { kind: 'fixed' as const, providerId: 'ollama' as const },
      timestampsEnabled: true,
    };
    const start = vi.fn(async (_url: string, _options: MediaTranscriptionJobOptions) => {});
    const registry = new YouTubeTranscriptModalRegistry();
    registry.open({} as never, {
      cancel: vi.fn(async () => {}),
      getProgress: () => null,
      getPartialTranscript: () => null,
      getResultSource: () => null,
      getAiOutcome: () => null,
      getSettings: () => saved,
      insertPartialTranscript: () => false,
      isBusy: () => false,
      onManagePresets: vi.fn(),
      start,
      subscribeProgress: () => () => {},
    });

    settings()
      .find(({ name }) => name === t('youtube.modal.urlName'))
      ?.textComponents[0]?.change('https://www.youtube.com/watch?v=8MxG6tOkdNY&t=407s');
    settings()
      .find(({ name }) => name === t('youtube.modal.timeGrouping'))
      ?.dropdownComponents[0]?.change('30');
    const primary = buttonNamed(t('media.modal.start'));
    expect(primary.disabled).toBe(false);
    await primary.click();
    await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());

    expect(start.mock.calls[0]?.[0]).toBe('https://www.youtube.com/watch?v=8MxG6tOkdNY&t=407s');
    expect(start.mock.calls[0]?.[1]).toMatchObject({
      language: 'auto',
      timestampSparseIntervalMs: 30_000,
      timestampsEnabled: true,
      transcriptFormatting: 'space',
    });
    expect(saved.timestampSparseIntervalMs).toBe(DEFAULT_PLUGIN_SETTINGS.timestampSparseIntervalMs);
    expect(saved.timestampsEnabled).toBe(true);
    registry.closeAll();
  });

  it('shows one cancel action and an accessible spinner while fetching captions', async () => {
    let finish!: () => void;
    const start = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const cancel = vi.fn(async () => {});
    const registry = new YouTubeTranscriptModalRegistry();
    registry.open({} as never, {
      cancel,
      getProgress: () => null,
      getPartialTranscript: () => null,
      getResultSource: () => null,
      getAiOutcome: () => null,
      getSettings: () => DEFAULT_PLUGIN_SETTINGS,
      insertPartialTranscript: () => false,
      isBusy: () => false,
      onManagePresets: vi.fn(),
      start,
      subscribeProgress: () => () => {},
    });

    settings()
      .find(({ name }) => name === t('youtube.modal.urlName'))
      ?.textComponents[0]?.change('https://youtu.be/8MxG6tOkdNY');
    const primary = buttonNamed(t('media.modal.start'));
    await primary.click();

    const modal = (Modal as unknown as { instances: ModalFixture[] }).instances.at(-1);
    expect(primary.text).toBe(t('media.modal.cancelJob'));
    expect(settings().flatMap(({ buttonComponents }) => buttonComponents)).toHaveLength(1);
    expect(
      modal?.contentEl.findByClass('local-stt-media-spinner')?.getAttribute('aria-hidden'),
    ).toBe('true');
    expect(modal?.contentEl.findByClass('local-stt-media-progress-text')?.textContent).toBe(
      t('media.progress.captions'),
    );

    await primary.click();
    expect(cancel).toHaveBeenCalledOnce();
    finish();
    await vi.waitFor(() => expect(primary.text).toBe(t('media.modal.start')));
    registry.closeAll();
  });

  it('keeps the note-facing action recoverable when captions are unavailable', async () => {
    const error = new Error('This video has no usable captions. The note was not changed.');
    const getPartialTranscript = vi.fn(() => 'partial caption text');
    const insertPartialTranscript = vi.fn(() => true);
    const start = vi.fn(async () => {
      throw error;
    });
    const registry = new YouTubeTranscriptModalRegistry();
    registry.open({} as never, {
      cancel: vi.fn(async () => {}),
      getProgress: () => null,
      getPartialTranscript,
      getResultSource: () => null,
      getAiOutcome: () => null,
      getSettings: () => DEFAULT_PLUGIN_SETTINGS,
      insertPartialTranscript,
      isBusy: () => false,
      onManagePresets: vi.fn(),
      start,
      subscribeProgress: () => () => {},
    });

    settings()
      .find(({ name }) => name === t('youtube.modal.urlName'))
      ?.textComponents[0]?.change('https://www.youtube.com/watch?v=8MxG6tOkdNY');
    await buttonNamed(t('media.modal.start')).click();

    const modal = (Modal as unknown as { instances: ModalFixture[] }).instances.at(-1);
    await vi.waitFor(() =>
      expect(modal?.contentEl.findByClass('local-stt-media-error')?.textContent).toBe(
        error.message,
      ),
    );
    expect(getPartialTranscript).toHaveBeenCalledOnce();
    expect(modal?.contentEl.findByClass('local-stt-media-error')?.textContent).toBe(error.message);
    expect(modal?.contentEl.findByClass('local-stt-media-progress')?.style.display).toBe('none');
    const partialActions = modal?.contentEl.findByClass('local-stt-media-partial-actions');
    expect(partialActions?.children[0]?.textContent).toBe(t('media.modal.partialAvailable'));
    const insert = partialActions?.children.at(-1);
    await insert?.click();
    expect(insertPartialTranscript).toHaveBeenCalledOnce();
    expect(getPartialTranscript).toHaveBeenCalled();
    expect(buttonNamed(t('media.modal.start')).disabled).toBe(false);
    registry.closeAll();
  });

  it('reports optional AI failure while keeping the inserted transcript and preventing duplicate submission', async () => {
    const start = vi.fn(async () => {});
    const registry = new YouTubeTranscriptModalRegistry();
    registry.open({} as never, {
      cancel: vi.fn(async () => {}),
      getProgress: () => null,
      getPartialTranscript: () => null,
      getResultSource: () => 'creator_captions',
      getAiOutcome: () => 'failed',
      getSettings: () => DEFAULT_PLUGIN_SETTINGS,
      insertPartialTranscript: () => false,
      isBusy: () => false,
      onManagePresets: vi.fn(),
      start,
      subscribeProgress: () => () => {},
    });
    settings()
      .find(({ name }) => name === t('youtube.modal.urlName'))
      ?.textComponents[0]?.change('https://www.youtube.com/watch?v=8MxG6tOkdNY');
    await buttonNamed(t('media.modal.start')).click();
    const modal = (Modal as unknown as { instances: ModalFixture[] }).instances.at(-1);
    await vi.waitFor(() =>
      expect(modal?.contentEl.findByClass('local-stt-media-error')?.textContent).toContain(
        'optional AI step could not finish',
      ),
    );
    expect(buttonNamed(t('common.done')).disabled).toBe(false);
    expect(start).toHaveBeenCalledOnce();
    registry.closeAll();
  });
});
