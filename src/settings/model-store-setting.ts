import { type ButtonComponent, Setting, type TextComponent } from 'obsidian';
import { t } from '../shared/i18n';
import type { UserFeedback } from '../shared/user-feedback';
import { SidecarLifecycleConflictError } from '../sidecar/sidecar-lifecycle-gate';

export function renderModelStoreSetting(
  parent: HTMLElement,
  options: {
    currentPath: string;
    changeModelStore: (path: string) => Promise<void>;
    feedback: Pick<UserFeedback, 'show'>;
  },
): void {
  let appliedPath = options.currentPath;
  let draft = appliedPath;
  let busy = false;
  let input: TextComponent;
  let apply: ButtonComponent;
  const update = () => {
    input.setDisabled(busy);
    apply.setDisabled(busy || draft.trim() === appliedPath);
  };
  const setting = new Setting(parent)
    .setName(t('settings.modelStoreOverride.name'))
    .setDesc(t('settings.modelStoreOverride.desc'));
  setting.addText((text) => {
    input = text;
    text
      .setPlaceholder(t('settings.modelStoreOverride.placeholder'))
      .setValue(draft)
      .onChange((value) => {
        draft = value;
        update();
      });
  });
  setting.addButton((button) => {
    apply = button;
    button.setButtonText(t('settings.modelStoreOverride.apply')).onClick(async () => {
      const nextPath = draft.trim();
      busy = true;
      update();
      try {
        await options.changeModelStore(nextPath);
        appliedPath = nextPath;
        draft = nextPath;
        input.setValue(nextPath);
        options.feedback.show({
          intent: 'success',
          message: t('settings.modelStoreOverride.updated'),
        });
      } catch (error) {
        options.feedback.show({
          cause: error,
          intent: 'warning',
          message:
            error instanceof SidecarLifecycleConflictError
              ? t('settings.sidecar.operationInProgress')
              : t('settings.modelStoreOverride.failed'),
        });
      } finally {
        busy = false;
        update();
      }
    });
  });
  update();
}
