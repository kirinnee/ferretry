import { createElement } from 'react';
import { implementApp } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { codexSettings } from './codex-settings.ts';
import { CodexSettingsView } from './settings-view.tsx';

export default implementApp(manifest, {
  build: ({ client }) => {
    const settings = codexSettings(client);
    return { settings: { codex: () => createElement(CodexSettingsView, { settings }) } };
  },
});
