/**
 * The browser entry for the All queues screen: the REAL `AllQueuesScreen` over a fake daemon (fixed fake data, no
 * network): three ferrets, two with messages waiting and one with an empty queue.
 *
 *   ?theme=<family>-<mode>
 *   ?refused=<ferretId>   the daemon refuses that ferret's queue (the others still read)
 */
import { DaemonCallError } from '@ferretry/app';
import { createRoot } from 'react-dom/client';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { AllQueues } from '../../../../app/queue/all-queues-screen.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';

const refused = params.get('refused') ?? undefined;

const minutesAgo = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();
const minutesAhead = (minutes: number): string => new Date(Date.now() + minutes * 60_000).toISOString();

const summary = (id: string, name: string) => ({
  id,
  name,
  role: 'lead',
  harness: 'claude-code',
  runner: 'tmux',
  folder: '/fixtures/project',
  state: 'idle',
  createdAt: '2026-11-01T00:00:00.000Z',
  stateAt: '2026-11-01T00:00:00.000Z',
});

const message = (id: string, text: string, enqueuedAt: string, over: Record<string, unknown> = {}) => ({
  v: 1,
  id,
  sender: 'human',
  text,
  attachmentIds: [],
  state: 'queued',
  stateAt: enqueuedAt,
  revision: 1,
  enqueuedAt,
  ...over,
});

const queues: Record<string, readonly unknown[]> = {
  casen: [
    message('c1', 'Please rebase the branch on main once the current test run finishes.', minutesAgo(12), {
      waitReason: 'busy',
    }),
    message('c2', 'Remember to update the changelog before you open the pull request.', minutesAgo(4), {
      holdUntil: minutesAhead(6),
      waitReason: 'busy',
    }),
  ],
  mira: [message('m1', 'The staging deploy is green — go ahead and tag the release.', minutesAgo(25))],
  idle: [],
};

const client = {
  call: async (route: string, init?: { params?: Record<string, string> }) => {
    if (route === 'GET /v1/ferrets')
      return [summary('casen', 'Casen'), summary('mira', 'Mira'), summary('idle', 'Idle')];
    if (route === 'GET /v1/ferrets/:ferretId/queue') {
      // `?refused=<ferretId>`: the daemon refuses that ferret's queue (the partly-failed case).
      if (init?.params?.ferretId === refused)
        throw new DaemonCallError(403, 'forbidden', 'This device is not allowed to use the fleet.');
      return { messages: queues[init?.params?.ferretId ?? ''] ?? [] };
    }
    throw new Error(`Unexpected fixture route ${route}`);
  },
  subscribe: () => () => undefined,
} as unknown as PluginClient;

createRoot(document.getElementById('root') as HTMLElement).render(<AllQueues client={client} daemon="fixture" />);
