/**
 * The Inbox deck on the first item the reader opens, an item whose last answer the machine refused. The REAL
 * `AgendaInboxPage` over the REAL `useAgendaInboxModel` and `DaemonAgendaClient`, with only the daemon's RPCs scripted.
 * The reader taps the real Retry; then `window.secondRefusal` plays the machine's side, in the order a daemon does it:
 * `acceptRetry()` is the accepted POST, whose board has the item CLOSED and its reply held (`replies.pending`), and
 * `readBoardAgain()` is the later read that finds the item open again with a NEW reason.
 */
import type { AgendaItem, AgendaSnapshot } from '@ferretry/core-asks/contract';
import { createRoot } from 'react-dom/client';
import { AgendaInboxPage } from '../../../../app/features/agenda/agenda-inbox-page.tsx';
import { useAgendaInboxModel } from '../../../../app/hooks/use-agenda-inbox.ts';
import { DaemonAgendaClient } from '../../../../app/lib/agenda-client.ts';
import { inboxCardKey } from '../../../../app/lib/agenda-inbox.ts';
import { daemonConnection, daemonSessionScope } from '../../../../app/shell.ts';
import { agendaItem, choices, fakeInbox } from '../../../support/app/agenda-inbox.tsx';
import { callFromFetch } from '../../../support/app/call-from-fetch.ts';
import { sessionView } from '../../../support/app/sessions.ts';

declare global {
  interface Window {
    secondRefusal: {
      readonly acceptRetry: () => Promise<void>;
      readonly readBoardAgain: () => Promise<void>;
    };
  }
}

document.documentElement.dataset.theme = new URLSearchParams(window.location.search).get('theme') ?? 'studio-light';
const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const phone = window.innerWidth < 768;
const SESSION = 'sess-2';
const laptop = daemonConnection({ daemonId: 'laptop' });
const scope = daemonSessionScope(laptop, SESSION);
const fake = fakeInbox();

const next = agendaItem('A3', { subject: 'Rebase onto main?', ask: choices('Rebase now', 'Wait', 'Skip') });
const refused = (reason: string, at: string): AgendaItem =>
  agendaItem('A2', {
    subject: 'Ship it?',
    ask: choices('Ship', 'Hold'),
    waitingSince: '2026-08-01T10:00:00.000Z',
    undelivered: { at, reply: { action: 'dismiss' }, reason },
  } as Partial<AgendaItem>);
const board = (items: readonly AgendaItem[], extra: Partial<AgendaSnapshot> = {}): AgendaSnapshot => ({
  v: 1,
  sessionId: SESSION,
  items: [...items],
  resolved: [],
  count: items.length,
  parseErrors: 0,
  updatedAt: '2026-08-01T11:50:00.000Z',
  ...extra,
});

/** What the daemon answers: a board read says `read`; the accepted retry says the item is closed and its reply held. */
const script = {
  read: board([refused('The machine is offline.', '2026-08-01T11:30:00.000Z'), next]),
  accepted: board([next], { replies: { pending: ['A2'], dueAt: '2026-08-01T12:00:08.000Z' } }),
};
const json = (value: unknown): Response =>
  new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
const client = new DaemonAgendaClient(
  undefined,
  callFromFetch(async (input, init) =>
    new URL(input).pathname === `/v1/ferrets/${SESSION}/agenda`
      ? json(init.method === 'POST' ? script.accepted : script.read)
      : new Response('{}', { status: 404 }),
  ),
);

const machines = [
  {
    connection: laptop,
    name: 'Laptop',
    sessions: [
      sessionView(SESSION, {
        config: { teammate: 'kai', name: 'Release train' },
        state: { agenda: { open: 2, first: 'A2', ask: 'Ship it?', latestAt: '2026-08-01T11:30:00.000Z' } },
      }),
    ],
  },
];

const settle = async (): Promise<void> => {
  for (let turn = 0; turn < 6; turn += 1) await new Promise<void>(done => setTimeout(done, 0));
};
window.secondRefusal = {
  acceptRetry: async () => {
    fake.clock.advance(10_000);
    await settle();
  },
  readBoardAgain: async () => {
    script.read = board([refused('The machine said no again.', '2026-08-01T11:45:00.000Z'), next]);
    await client.revalidate(laptop, scope);
    await settle();
  },
};

function Scene() {
  const inbox = useAgendaInboxModel(client, machines, fake.clock);
  return (
    <div style={{ position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column', padding: '0 16px' }}>
      <AgendaInboxPage
        clock={fake.clock.now}
        initialOpen={inboxCardKey(laptop.daemonId, SESSION, 'A2')}
        inbox={inbox}
        now={NOW}
        onNavigate={() => undefined}
        phone={phone}
        reducedMotion
      />
    </div>
  );
}

// The board is held before the page opens, as it is once the reader has been reading the Inbox.
const root = document.getElementById('root');
void client.revalidate(laptop, scope).then(() => {
  if (root !== null) createRoot(root).render(<Scene />);
});
