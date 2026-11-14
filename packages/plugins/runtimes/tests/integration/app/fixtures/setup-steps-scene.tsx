/**
 * The browser entry for the machine-setup steps this plugin contributes: the REAL "Agent controls" and "Start from…"
 * step bodies, and the Export settings screen, over ONE FAKE machine that answers from memory. No daemon, no network.
 * Every name below is made up.
 *
 *   ?view=controls      Agent controls: the five switches and the default runtime (one switch flipped, so Save shows)
 *   ?view=start         Start from…: a fresh setup chosen
 *   ?view=start-clone   Start from…: a copy chosen (no other machine paired: the note that says so)
 *   ?view=export        Export settings, after it ran: the zip's listing, with one file left out
 *   ?theme=<family>-<mode>
 */

import type { PanelProps, SettingsProps } from '@ferretry/kernel/manifest';
import { createElement, type FunctionComponent } from 'react';
import { createRoot } from 'react-dom/client';
import { ExportSettings } from '../../../../app/features/fleet/setup/export-settings.tsx';
import { createAgentControlsStep } from '../../../../app/views/agent-controls-step.tsx';
import { createStartStep } from '../../../../app/views/setup-transfer.tsx';
import { READS, scripted } from '../../../unit/app/features/fleet/account-support.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const view = params.get('view') ?? 'controls';

const client = scripted({
  ...READS(),
  'GET /v1/config/status': {
    files: [
      { path: 'warden.yaml', state: 'ok' },
      { path: 'learning.yaml', state: 'ok' },
      { path: 'voice.yaml', state: 'ok' },
      { path: 'runtimes/claude-default.yaml', state: 'ok' },
      { path: 'logins/work.yaml', state: 'invalid' },
    ],
  },
  'GET /v1/config/file': (call: { readonly query: Readonly<Record<string, string>> | undefined }) => {
    const path = call.query?.['path'] ?? '';
    return { path, exists: true, text: `# ${path}\n`, etag: 'e', issues: [] };
  },
});

function Scene() {
  if (view === 'export')
    return (
      <ExportSettings
        client={client}
        machineName="studio-mac"
        save={() => undefined}
        now={() => new Date('2026-11-14T09:00:00Z')}
      />
    );
  const step = view === 'controls' ? createAgentControlsStep(client) : createStartStep(client);
  return createElement(
    step as unknown as FunctionComponent<SettingsProps & PanelProps>,
    {} as SettingsProps & PanelProps,
  );
}

const root = document.getElementById('root') as HTMLElement;
root.className = 'mx-auto max-w-[560px] p-4';
createRoot(root).render(<Scene />);
