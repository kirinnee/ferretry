import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { codexSettings } from './codex-settings.ts';

/**
 * Codex's app half: the `codex` Settings tab. Thin: the tab's controller is `codex-settings.ts` and its words are
 * `lib/model.ts`; the React view that draws them needs the app shell. The model-catalog and fast-mode choices ride on
 * Runtimes' picker, which reads Codex's read models, so they have no screen of their own here.
 */
export default implementApp(manifest, {
  build: ({ client }) => {
    const settings = codexSettings(client);
    return { settings: { codex: () => settings } };
  },
});
