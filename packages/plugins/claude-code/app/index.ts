import type { AppComponent, PanelProps, SettingsProps } from '@ferretry/kernel/manifest';
import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { lazyComponent } from './lazy.ts';

type ViewName = 'claude-code-settings' | 'permission-panel' | 'dialog-panel';

/**
 * A view module (React), loaded on first use. The specifier is a Vite dynamic-import variable (`./views/*.tsx`), which
 * is also why the type-checker, which has no React in this workspace yet, does not follow it into the views.
 */
const loadView = (name: ViewName): Promise<Record<string, unknown>> => import(`./views/${name}.tsx`);

/**
 * Claude Code's app half: its Settings tab (where claude is, its version, the update) and the two cards that draw
 * above the composer when the ferret is stopped on a permission prompt or one of Claude's own dialogs.
 */
export default implementApp(manifest, {
  build: ({ client }) => ({
    settings: {
      'claude-code': lazyComponent<SettingsProps>(async () => {
        const view = await loadView('claude-code-settings');
        return (view.createSettings as (client: unknown) => AppComponent<SettingsProps>)(client);
      }),
    },
    panels: {
      'permission-request': lazyComponent<PanelProps>(async () => {
        const view = await loadView('permission-panel');
        return (view.createPanel as (client: unknown) => AppComponent<PanelProps>)(client);
      }),
      'harness-dialog': lazyComponent<PanelProps>(async () => {
        const view = await loadView('dialog-panel');
        return (view.createPanel as (client: unknown) => AppComponent<PanelProps>)(client);
      }),
    },
  }),
});
