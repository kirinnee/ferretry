import { createElement } from 'react';
import { forSubject } from '@ferretry/app';
import type { PanelProps } from '@ferretry/kernel/manifest';
import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { codexSettings } from './codex-settings.ts';
import { CodexSettingsView } from './settings-view.tsx';

export default implementApp(manifest, {
  build: ({ client }) => {
    const settings = codexSettings(client);
    const view = () => createElement(CodexSettingsView, { settings });
    return {
      settings: { codex: view },
      // The first-run step's body: the same view, only for its own step.
      panels: {
        'onboarding-step': forSubject('codex.harness', view as (props: PanelProps) => ReturnType<typeof view>),
      },
    };
  },
});
