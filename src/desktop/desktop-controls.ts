import type { DesktopActionEvent, DesktopState } from '../sidecar/protocol';

interface DesktopActions {
  toggle: () => Promise<void>;
  openTarget: () => void;
  openSettings: () => void;
  notify: (kind: 'recording' | 'stopped' | 'failed') => void;
  sound: (kind: 'start' | 'stop') => void;
}

/** Projects shared recording state into desktop actions without owning a second session. */
export class DesktopControls {
  private generation = '';
  private lastActionId = -1;
  private state: DesktopState = 'ready';
  constructor(private readonly actions: DesktopActions) {}

  setGeneration(generation: string): void {
    this.generation = generation;
    this.lastActionId = -1;
  }

  update(state: DesktopState, sounds: boolean, iconAvailable: boolean): void {
    const wasRecording = this.state === 'recording';
    this.state = state;
    if (wasRecording === (state === 'recording')) return;
    try {
      if (sounds) this.actions.sound(state === 'recording' ? 'start' : 'stop');
      if (!iconAvailable) this.actions.notify(state === 'recording' ? 'recording' : 'stopped');
    } catch {
      /* Optional desktop feedback must not interrupt recording. */
    }
  }

  async handleAction(
    event: Pick<DesktopActionEvent, 'generation' | 'actionId' | 'action'>,
  ): Promise<void> {
    if (event.generation !== this.generation || event.actionId <= this.lastActionId) return;
    this.lastActionId = event.actionId;
    if (event.action === 'open_target') this.actions.openTarget();
    else if (event.action === 'open_settings') this.actions.openSettings();
    else if (this.state !== 'finishing') {
      try {
        await this.actions.toggle();
      } catch {
        this.actions.notify('failed');
      }
    }
  }
}
