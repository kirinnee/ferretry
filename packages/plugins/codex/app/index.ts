import { createElement } from 'react';
import { forSubject } from '@ferretry/app';
import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { codexSettings } from './codex-settings.ts';
import { stepBody } from './features/onboarding/pages.tsx';
import { CodexSettingsView } from './settings-view.tsx';

export default implementApp(manifest, {
  build: ({ client }) => {
    const settings = codexSettings(client);
    const view = () => createElement(CodexSettingsView, { settings });
    return {
      settings: { codex: view },
      // The body of each Codex setup step, one panel per declared step (`step-<id>`, as the manifest names them), drawn
      // for its own `codex.<id>` subject only.
      panels: Object.fromEntries(
        (manifest.onboarding ?? []).map(step => [
          `step-${step.id}`,
          forSubject(`codex.${step.id}`, stepBody(step.id, client)),
        ]),
      ),
    };
  },
});
