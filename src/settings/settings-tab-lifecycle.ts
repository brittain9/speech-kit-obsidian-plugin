const FOCUSABLE_CONTROL_SELECTOR = [
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

interface SettingsTabRefreshHost {
  containerEl: HTMLElement;
  display(): void;
  update?: () => void;
}

export interface SettingsFocus {
  controlIndex: number;
  settingName: string;
}

export class SettingsTabLifecycle {
  private visible = false;
  private visibilityGeneration = 0;
  private dialogGeneration = 0;

  constructor(private readonly host: SettingsTabRefreshHost) {}

  markVisible(): void {
    if (!this.visible) this.visibilityGeneration += 1;
    this.visible = true;
  }

  markHidden(): void {
    this.visible = false;
  }

  focusAfterDialog(focus: SettingsFocus): () => void {
    const visibility = this.visibilityGeneration;
    const dialog = ++this.dialogGeneration;
    return () => {
      const container = this.host.containerEl;
      const document = container.ownerDocument;
      const active = document.activeElement;
      if (
        !this.visible ||
        visibility !== this.visibilityGeneration ||
        dialog !== this.dialogGeneration ||
        !container.isConnected
      )
        return;
      if (active !== null && active !== document.body && active !== document.documentElement)
        return;
      if (
        Array.from(document.querySelectorAll('.modal-container')).some(
          (modal) => !modal.contains(container),
        )
      )
        return;
      restoreSettingsFocus(container, focus);
    };
  }

  refresh(): void {
    if (!this.visible) {
      return;
    }

    const focus = captureSettingsFocus(this.host.containerEl);
    if (typeof this.host.update === 'function') {
      this.host.update();
    } else {
      this.host.display();
    }
    restoreSettingsFocus(this.host.containerEl, focus);
  }
}

export function captureSettingsFocus(containerEl: HTMLElement): SettingsFocus | null {
  const activeElement = containerEl.ownerDocument.activeElement;
  if (activeElement === null || !containerEl.contains(activeElement)) {
    return null;
  }

  const settingEl = activeElement.closest('.setting-item');
  if (settingEl === null || !containerEl.contains(settingEl)) {
    return null;
  }

  const settingName = settingEl.querySelector('.setting-item-name')?.textContent?.trim() ?? '';
  if (settingName.length === 0) {
    return null;
  }

  const controls = Array.from(settingEl.querySelectorAll<HTMLElement>(FOCUSABLE_CONTROL_SELECTOR));
  const controlIndex = controls.indexOf(activeElement as HTMLElement);
  return controlIndex < 0 ? null : { controlIndex, settingName };
}

export function restoreSettingsFocus(containerEl: HTMLElement, focus: SettingsFocus | null): void {
  if (focus === null) {
    return;
  }

  for (const settingEl of containerEl.querySelectorAll<HTMLElement>('.setting-item')) {
    const settingName = settingEl.querySelector('.setting-item-name')?.textContent?.trim() ?? '';
    if (settingName !== focus.settingName) {
      continue;
    }

    const controls = settingEl.querySelectorAll<HTMLElement>(FOCUSABLE_CONTROL_SELECTOR);
    controls[focus.controlIndex]?.focus();
    return;
  }
}
