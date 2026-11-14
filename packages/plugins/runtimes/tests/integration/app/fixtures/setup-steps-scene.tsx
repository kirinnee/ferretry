/**
 * The browser entry for the machine-setup steps this plugin contributes: the REAL "Agent controls" and "Start from…"
 * step bodies, and the Export settings screen, over ONE FAKE machine that answers from memory. No daemon, no network.
 * Every name below is made up.
 *
 *   ?view=controls      Agent controls: the five switches and the default runtime (one switch flipped, so Save shows)
 *   ?view=start         Start from…: a fresh setup chosen
 *   ?view=start-clone   Start from…: a copy chosen (no other machine paired: the note that says so)
 *   ?view=export        Export settings, after it ran: the zip's listing, with one file left out
 *   ?view=copy-first    Copy settings from a (fake) paired machine: a first copy's review, every command and script in full
 *   ?view=copy-update   The same, as a repeat copy: a changed command, a both-changed item and key, a login to pick
 *   ?view=copy-done     A first copy that leaves its settings out, so Done says what was NOT brought
 *   ?theme=<family>-<mode>
 */

import type { PanelProps, SettingsProps } from '@ferretry/kernel/manifest';
import { createElement, type FunctionComponent } from 'react';
import { createRoot } from 'react-dom/client';
import type { DaemonReach } from '@ferretry/app';
import { CopySettings } from '../../../../app/features/fleet/setup/copy-settings.tsx';
import { ExportSettings } from '../../../../app/features/fleet/setup/export-settings.tsx';
import { useAccountChanges } from '../../../../app/features/fleet/shell/apply-change-panel.tsx';
import { BUNDLE, FIRST, FOLLOWUP, UPDATE } from './copy-flow-data.ts';
import { createAgentControlsStep } from '../../../../app/views/agent-controls-step.tsx';
import { createStartStep } from '../../../../app/views/setup-transfer.tsx';
import {
  type Call,
  CHANGE_ID,
  machine,
  READS,
  scripted,
  stagedFrom,
} from '../../../unit/app/features/fleet/account-support.ts';

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

/** The machine this one copies from: it answers its export, its machine settings, its files and its key names. */
const source = scripted({
  'GET /v1/runtimes/export': BUNDLE,
  'GET /v1/runtimes/machine': machine(),
  'GET /v1/config/file': (call: { readonly query: Readonly<Record<string, string>> | undefined }) => ({
    path: call.query?.['path'] ?? '',
    exists: true,
    text: 'mode: guard\n',
    etag: 'e',
    issues: [],
  }),
  'GET /v1/secrets': {
    secrets: [{ name: 'NOTES_KEY', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-12T00:00:00.000Z' }],
  },
});

let reviews = 0;
const target = scripted({
  ...READS(),
  'POST /v1/runtimes/clone/review': () => {
    reviews += 1;
    return view === 'copy-update' ? UPDATE : reviews === 1 ? FIRST : FOLLOWUP;
  },
  'POST /v1/runtimes/proposals': (call: Call) => ({
    ...stagedFrom(call),
    id: CHANGE_ID,
    summary: 'Clone another machine’s setup',
    consequences: [],
    preview: {
      kind: 'executor',
      executor: 'clone',
      description:
        'This copy adds the hook guard, which runs bash ./guard.sh before every tool call, and the MCP server notes, which starts node ./notes-server.js --port 4100.\nNothing is written until you confirm.',
    },
  }),
  'POST /v1/runtimes/proposals/:proposalId/apply': {
    outcome: 'executed',
    executor: 'clone',
    summary: 'Copied 4 items from work-mac.',
  },
});

const reach = {
  daemon: 'src',
  machine: 'work-mac',
  online: true,
  locked: false,
  client: source,
} as unknown as DaemonReach;

function CopyScene() {
  const changes = useAccountChanges({ client: target });
  return <CopySettings client={target} machineName="studio-mac" hasSetup changes={changes} reaches={[reach]} />;
}

function Scene() {
  if (view.startsWith('copy-')) return <CopyScene />;
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
