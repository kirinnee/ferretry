/**
 * The browser entry for "the Agents tab looks right": the REAL `AgentsTab` over a scripted machine (fake data only).
 *
 *   ?theme=<family>-<mode>
 */

import { createRoot } from 'react-dom/client';
import { AgentsTab } from '../../../../app/features/fleet/machine/agents-tab.tsx';
import type { RuntimesClient } from '../../../../app/lib/client.ts';
import type { MachineView } from '../../../../contract/index.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const machine = {
  name: 'studio-mac',
  format: 'present',
  setUp: true,
  agentPermissions: 'auto',
  defaultRuntime: 'claude-default',
  agentControl: { terminals: true, browsers: true, files: true, ferretrySettings: false, pageScripts: false },
  browserMode: 'headless',
  browserProxy: null,
  browserPorts: 'random',
  browserFirewallFailure: 'warn',
  autoResume: true,
  agendaMode: false,
  publicUsageFeed: false,
  lastAutoResume: {
    at: '2026-10-13T07:00:00.000Z',
    resumed: 3,
    skipped: [{ sessionId: 'ferret-9', reason: 'its folder is gone' }],
  },
  tools: [],
  runtimeCount: 5,
  runningSessions: 2,
  authority: { mayApply: true, applyRefusal: 'granted' },
} as unknown as MachineView;

const client: RuntimesClient = {
  call: async <Answer,>(route: string): Promise<Answer> => {
    if (route === 'GET /v1/runtimes/machine') return machine as Answer;
    if (route === 'GET /v1/config/file')
      return { path: 'conversation.yaml', exists: true, text: 'keepInSync: true\n', etag: 'e-1' } as Answer;
    throw new Error(`the scene has no answer for ${route}`);
  },
};

const root = document.getElementById('root');
if (root === null) throw new Error('missing #root');
createRoot(root).render(
  <main style={{ margin: '0 auto', maxWidth: 720, padding: '12px 16px' }}>
    <h1 style={{ fontSize: 20, margin: '0 0 12px' }}>Settings › Agents</h1>
    <AgentsTab
      client={client}
      machineName="studio-mac"
      machine={machine}
      online
      checking={false}
      onRetry={() => undefined}
      onRefresh={() => undefined}
    />
  </main>,
);
