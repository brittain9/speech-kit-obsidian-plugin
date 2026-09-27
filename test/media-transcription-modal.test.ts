import { Modal, Setting } from 'obsidian';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AudioFileError } from '../src/audio/audio-file-decoder';
import type { MediaTranscriptionModelOption } from '../src/media/media-transcription-options';
import { DEFAULT_PLUGIN_SETTINGS } from '../src/settings/plugin-settings';
import { t } from '../src/shared/i18n';
import { MediaTranscriptionModalRegistry } from '../src/ui/media-transcription-modal';
import type { TestElement } from './__mocks__/obsidian';

interface SettingFixture {
  readonly name: string;
  readonly extraButtonComponents: Array<{ tooltip: string; click(): Promise<void> }>;
}

const settings = (): SettingFixture[] =>
  (Setting as unknown as { instances: SettingFixture[] }).instances;

function buttonNamed(name: string): { buttonEl: TestElement; click(): Promise<void> } {
  return (
    Setting as unknown as {
      buttonNamed(name: string): { buttonEl: TestElement; click(): Promise<void> };
    }
  ).buttonNamed(name);
}

afterEach(() => {
  settings().length = 0;
  (Modal as unknown as { instances: unknown[] }).instances.length = 0;
});

describe('local media transcription modal', () => {
  it('keeps the file workflow focused on audio and video files', async () => {
    const registry = new MediaTranscriptionModalRegistry();
    const onManagePresets = vi.fn();
    registry.open({} as never, {
      cancel: vi.fn(async () => {}),
      getModels: () => [],
      getLastError: () => null,
      getPartialTranscript: () => null,
      insertPartialTranscript: () => false,
      getProgress: () => null,
      getSettings: () => DEFAULT_PLUGIN_SETTINGS,
      isTranscribing: () => false,
      isDecoderInstalled: async () => true,
      openDecoderInstaller: vi.fn(),
      onManageModels: vi.fn(),
      onManagePresets,
      startFile: vi.fn(async () => {}),
      subscribeProgress: () => () => {},
    });

    const modal = (
      Modal as unknown as { instances: Array<{ contentEl: TestElement }> }
    ).instances.at(-1);
    expect(modal?.contentEl.findByClass('local-stt-media-drop-zone')).toBeDefined();
    expect(modal?.contentEl.findByClass('local-stt-media-source-tabs')).toBeUndefined();
    expect(settings().some(({ name }) => name === t('youtube.modal.urlName'))).toBe(false);
    expect(settings().some(({ name }) => name === t('media.modal.language'))).toBe(true);

    const opener = settings()
      .flatMap(({ extraButtonComponents }) => extraButtonComponents)
      .find(({ tooltip }) => tooltip === t('llm.preset.manager.title'));
    expect(opener).toBeDefined();
    await opener?.click();
    expect(onManagePresets).toHaveBeenCalledOnce();

    registry.closeAll();
  });

  it('offers decoder installation and retains the selected file after installation', async () => {
    const registry = new MediaTranscriptionModalRegistry();
    let decoderInstalled = false;
    const startFile = vi.fn(async () => {});
    const openDecoderInstaller = vi.fn((onInstalled: () => void) => {
      decoderInstalled = true;
      onInstalled();
    });
    registry.open({} as never, {
      cancel: vi.fn(async () => {}),
      getModels: () => [],
      getLastError: () => null,
      getPartialTranscript: () => null,
      insertPartialTranscript: () => false,
      getProgress: () => null,
      getSettings: () => DEFAULT_PLUGIN_SETTINGS,
      isTranscribing: () => false,
      isDecoderInstalled: async () => decoderInstalled,
      openDecoderInstaller,
      onManageModels: vi.fn(),
      onManagePresets: vi.fn(),
      startFile,
      subscribeProgress: () => () => {},
    });

    const modal = (
      Modal as unknown as { instances: Array<{ contentEl: TestElement }> }
    ).instances.at(-1);
    const content = modal?.contentEl;
    content?.findByClass('local-stt-media-drop-zone')?.dispatchEvent({
      type: 'drop',
      preventDefault: vi.fn(),
      dataTransfer: { files: [new File(['audio'], 'meeting.wav')] },
    } as never);

    await vi.waitFor(() => expect(content?.findByText(t('media.tools.description'))).toBeDefined());
    expect(content?.findByClass('local-stt-media-selected-file')?.textContent).toContain(
      'meeting.wav',
    );
    await buttonNamed(t('media.tools.install')).click();
    await vi.waitFor(() => expect(openDecoderInstaller).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(content?.findByClass('local-stt-media-decoder-requirement')?.style.display).toBe(
        'none',
      ),
    );
    expect(content?.findByText(t('media.tools.install'))).toBeUndefined();
    expect(content?.findByClass('local-stt-media-selected-file')?.textContent).toContain(
      'meeting.wav',
    );
    expect(startFile).not.toHaveBeenCalled();

    registry.closeAll();
  });

  it('offers decoder installation when decoding later reports it missing', async () => {
    const registry = new MediaTranscriptionModalRegistry();
    const model: MediaTranscriptionModelOption = {
      capabilities: {} as MediaTranscriptionModelOption['capabilities'],
      label: 'Whisper Large V3 Turbo',
      selection: {
        familyId: 'whisper',
        kind: 'catalog_model',
        modelId: 'whisper_large_v3_turbo_q8_0',
        runtimeId: 'whisper_cpp',
      },
    };
    const openDecoderInstaller = vi.fn();
    registry.open({} as never, {
      cancel: vi.fn(async () => {}),
      getModels: () => [model],
      getLastError: () => null,
      getPartialTranscript: () => null,
      insertPartialTranscript: () => false,
      getProgress: () => null,
      getSettings: () => DEFAULT_PLUGIN_SETTINGS,
      isTranscribing: () => false,
      isDecoderInstalled: async () => true,
      openDecoderInstaller,
      onManageModels: vi.fn(),
      onManagePresets: vi.fn(),
      startFile: async () => {
        throw new AudioFileError('decoder_missing', 'FFmpeg is not installed');
      },
      subscribeProgress: () => () => {},
    });

    const modal = (
      Modal as unknown as { instances: Array<{ contentEl: TestElement }> }
    ).instances.at(-1);
    const content = modal?.contentEl;
    content?.findByClass('local-stt-media-drop-zone')?.dispatchEvent({
      type: 'drop',
      preventDefault: vi.fn(),
      dataTransfer: { files: [new File(['audio'], 'meeting.wav')] },
    } as never);
    await vi.waitFor(() =>
      expect(content?.findByClass('local-stt-media-decoder-requirement')?.style.display).toBe(
        'none',
      ),
    );
    await buttonNamed(t('media.modal.start')).click();

    await vi.waitFor(() => expect(content?.findByText(t('media.tools.description'))).toBeDefined());
    expect(
      content?.findByText(t('media.modal.recoverableError', { detail: 'FFmpeg is not installed' })),
    ).toBeDefined();
    await buttonNamed(t('media.tools.install')).click();
    expect(openDecoderInstaller).toHaveBeenCalledOnce();

    registry.closeAll();
  });

  it('hides the repeat action after success and restores it for a new file', async () => {
    const registry = new MediaTranscriptionModalRegistry();
    const model: MediaTranscriptionModelOption = {
      capabilities: {} as MediaTranscriptionModelOption['capabilities'],
      label: 'Whisper Large V3 Turbo',
      selection: {
        familyId: 'whisper',
        kind: 'catalog_model',
        modelId: 'whisper_large_v3_turbo_q8_0',
        runtimeId: 'whisper_cpp',
      },
    };
    const startFile = vi.fn(async () => {});
    registry.open({} as never, {
      cancel: vi.fn(async () => {}),
      getModels: () => [model],
      getLastError: () => null,
      getPartialTranscript: () => null,
      insertPartialTranscript: () => false,
      getProgress: () => null,
      getSettings: () => DEFAULT_PLUGIN_SETTINGS,
      isTranscribing: () => false,
      isDecoderInstalled: async () => true,
      openDecoderInstaller: vi.fn(),
      onManageModels: vi.fn(),
      onManagePresets: vi.fn(),
      startFile,
      subscribeProgress: () => () => {},
    });

    const modal = (
      Modal as unknown as { instances: Array<{ contentEl: TestElement }> }
    ).instances.at(-1);
    const content = modal?.contentEl;
    const dropZone = content?.findByClass('local-stt-media-drop-zone');
    dropZone?.dispatchEvent({
      type: 'drop',
      preventDefault: vi.fn(),
      dataTransfer: { files: [new File(['first audio'], 'first.wav')] },
    } as never);
    await vi.waitFor(() =>
      expect(content?.findByClass('local-stt-media-decoder-requirement')?.style.display).toBe(
        'none',
      ),
    );

    const start = buttonNamed(t('media.modal.start'));
    const close = buttonNamed(t('common.close'));
    await start.click();
    await vi.waitFor(() => expect(start.buttonEl.style.display).toBe('none'));
    expect(start.buttonEl.disabled).toBe(true);
    expect(close.buttonEl.style.display).toBe('');
    expect(startFile).toHaveBeenCalledOnce();

    dropZone?.dispatchEvent({
      type: 'drop',
      preventDefault: vi.fn(),
      dataTransfer: { files: [new File(['second audio'], 'second.wav')] },
    } as never);
    expect(start.buttonEl.style.display).toBe('');
    expect(start.buttonEl.disabled).toBe(false);

    await start.click();
    await vi.waitFor(() => expect(startFile).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(start.buttonEl.style.display).toBe('none'));
    expect(close.buttonEl.style.display).toBe('');

    registry.closeAll();
  });

  it('keeps failed transcription retryable and retains partial recovery', async () => {
    const registry = new MediaTranscriptionModalRegistry();
    const model: MediaTranscriptionModelOption = {
      capabilities: {} as MediaTranscriptionModelOption['capabilities'],
      label: 'Whisper Large V3 Turbo',
      selection: {
        familyId: 'whisper',
        kind: 'catalog_model',
        modelId: 'whisper_large_v3_turbo_q8_0',
        runtimeId: 'whisper_cpp',
      },
    };
    const startFile = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('temporary transcription failure'))
      .mockResolvedValueOnce(undefined);
    const insertPartialTranscript = vi.fn(() => true);
    registry.open({} as never, {
      cancel: vi.fn(async () => {}),
      getModels: () => [model],
      getLastError: () => null,
      getPartialTranscript: () => 'recovered words',
      insertPartialTranscript,
      getProgress: () => null,
      getSettings: () => DEFAULT_PLUGIN_SETTINGS,
      isTranscribing: () => false,
      isDecoderInstalled: async () => true,
      openDecoderInstaller: vi.fn(),
      onManageModels: vi.fn(),
      onManagePresets: vi.fn(),
      startFile,
      subscribeProgress: () => () => {},
    });

    const modal = (
      Modal as unknown as { instances: Array<{ contentEl: TestElement }> }
    ).instances.at(-1);
    const content = modal?.contentEl;
    content?.findByClass('local-stt-media-drop-zone')?.dispatchEvent({
      type: 'drop',
      preventDefault: vi.fn(),
      dataTransfer: { files: [new File(['audio'], 'meeting.wav')] },
    } as never);
    await vi.waitFor(() =>
      expect(content?.findByClass('local-stt-media-decoder-requirement')?.style.display).toBe(
        'none',
      ),
    );

    const start = buttonNamed(t('media.modal.start'));
    await start.click();
    await vi.waitFor(() => expect(startFile).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(
        content?.findByText(
          t('media.modal.recoverableError', { detail: 'temporary transcription failure' }),
        ),
      ).toBeDefined(),
    );
    expect(start.buttonEl.style.display).toBe('');
    expect(start.buttonEl.disabled).toBe(false);

    const insert = content?.findByText(t('media.modal.insertPartial'));
    expect(insert).toBeDefined();
    await insert?.click();
    expect(insertPartialTranscript).toHaveBeenCalledOnce();

    await start.click();
    await vi.waitFor(() => expect(startFile).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(start.buttonEl.style.display).toBe('none'));

    registry.closeAll();
  });

  it('keeps a cancelled transcription retryable', async () => {
    const registry = new MediaTranscriptionModalRegistry();
    const model: MediaTranscriptionModelOption = {
      capabilities: {} as MediaTranscriptionModelOption['capabilities'],
      label: 'Whisper Large V3 Turbo',
      selection: {
        familyId: 'whisper',
        kind: 'catalog_model',
        modelId: 'whisper_large_v3_turbo_q8_0',
        runtimeId: 'whisper_cpp',
      },
    };
    const cancelledRun = { finish: null as (() => void) | null };
    const startFile = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            cancelledRun.finish = resolve;
          }),
      )
      .mockResolvedValueOnce(undefined);
    registry.open({} as never, {
      cancel: vi.fn(async () => {}),
      getModels: () => [model],
      getLastError: () => null,
      getPartialTranscript: () => 'partial words',
      insertPartialTranscript: () => true,
      getProgress: () => null,
      getSettings: () => DEFAULT_PLUGIN_SETTINGS,
      isTranscribing: () => false,
      isDecoderInstalled: async () => true,
      openDecoderInstaller: vi.fn(),
      onManageModels: vi.fn(),
      onManagePresets: vi.fn(),
      startFile,
      subscribeProgress: () => () => {},
    });

    const modal = (
      Modal as unknown as { instances: Array<{ contentEl: TestElement }> }
    ).instances.at(-1);
    const content = modal?.contentEl;
    content?.findByClass('local-stt-media-drop-zone')?.dispatchEvent({
      type: 'drop',
      preventDefault: vi.fn(),
      dataTransfer: { files: [new File(['audio'], 'meeting.wav')] },
    } as never);
    await vi.waitFor(() =>
      expect(content?.findByClass('local-stt-media-decoder-requirement')?.style.display).toBe(
        'none',
      ),
    );

    const start = buttonNamed(t('media.modal.start'));
    await start.click();
    await vi.waitFor(() => expect(startFile).toHaveBeenCalledOnce());
    await buttonNamed(t('media.modal.cancelJob')).click();
    await vi.waitFor(() => expect(content?.findByText(t('media.modal.cancelled'))).toBeDefined());
    expect(content?.findByText(t('media.modal.insertPartial'))).toBeDefined();
    expect(start.buttonEl.disabled).toBe(true);

    cancelledRun.finish?.();
    await vi.waitFor(() => expect(start.buttonEl.disabled).toBe(false));
    expect(start.buttonEl.style.display).toBe('');

    await start.click();
    await vi.waitFor(() => expect(startFile).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(start.buttonEl.style.display).toBe('none'));

    registry.closeAll();
  });
});
