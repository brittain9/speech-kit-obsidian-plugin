type Hold = { release: () => Promise<void> };

export class PushToTalkControl {
  private hold: Hold | null = null;
  private gesture: { kind: 'pointer'; id: number } | { kind: 'key'; key: string } | null = null;
  private enabled = false;
  private readonly hostWindow: Window;

  constructor(
    private readonly element: HTMLElement,
    private readonly start: () => Hold | null,
  ) {
    const hostWindow = element.ownerDocument.defaultView;
    if (hostWindow === null) throw new Error('Push-to-talk control requires a window.');
    this.hostWindow = hostWindow;
    element.addEventListener('pointerdown', this.onPointerDown);
    element.addEventListener('pointerup', this.onPointerEnd);
    element.addEventListener('pointercancel', this.onPointerEnd);
    element.addEventListener('lostpointercapture', this.onPointerEnd);
    element.addEventListener('keydown', this.onKeyDown);
    element.addEventListener('keyup', this.onKeyUp);
    element.addEventListener('blur', this.onBlur);
    hostWindow.addEventListener('blur', this.onBlur);
    this.setEnabled(false);
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    this.element.style.display = enabled ? '' : 'none';
    if (!enabled) this.release();
  }

  dispose(): void {
    this.setEnabled(false);
    this.element.removeEventListener('pointerdown', this.onPointerDown);
    this.element.removeEventListener('pointerup', this.onPointerEnd);
    this.element.removeEventListener('pointercancel', this.onPointerEnd);
    this.element.removeEventListener('lostpointercapture', this.onPointerEnd);
    this.element.removeEventListener('keydown', this.onKeyDown);
    this.element.removeEventListener('keyup', this.onKeyUp);
    this.element.removeEventListener('blur', this.onBlur);
    this.hostWindow.removeEventListener('blur', this.onBlur);
    this.element.remove();
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.enabled || event.button !== 0 || this.gesture !== null) return;
    const hold = this.start();
    if (hold === null) return;
    this.hold = hold;
    this.gesture = { kind: 'pointer', id: event.pointerId };
    try {
      this.element.setPointerCapture(event.pointerId);
    } catch {
      this.release();
    }
  };

  private readonly onPointerEnd = (event: PointerEvent): void => {
    if (this.gesture?.kind === 'pointer' && this.gesture.id === event.pointerId) this.release();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.enabled || (event.key !== ' ' && event.key !== 'Enter')) return;
    event.preventDefault();
    if (event.repeat || this.gesture !== null) return;
    const hold = this.start();
    if (hold === null) return;
    this.hold = hold;
    this.gesture = { kind: 'key', key: event.key };
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    if (this.gesture?.kind === 'key' && this.gesture.key === event.key) {
      event.preventDefault();
      this.release();
    }
  };

  private readonly onBlur = (): void => {
    this.release();
  };

  private release(): void {
    const hold = this.hold;
    this.hold = null;
    this.gesture = null;
    if (hold !== null) void hold.release();
  }
}
