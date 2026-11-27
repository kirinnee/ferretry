/**
 * A RETRY THE MACHINE TOOK AND REFUSED LATER, through the real stack: the real `AgendaInboxPage`, the real
 * `useAgendaInboxModel` and the real `DaemonAgendaClient`, with only the daemon's RPCs scripted. The accepted POST
 * returns the daemon's authoritative board BEFORE delivery has settled: the item is closed and `replies.pending` names
 * it. A later read finds it open again with a fresh `undelivered`.
 */
import type { SessionAgendaSummary } from '../../../../contract/wire.ts';
import { afterEach, describe, expect, it } from 'bun:test';
import type { AgendaItem, AgendaSnapshot } from '@ferretry/core-asks/contract';
import { AgendaInboxPage } from '../../../../app/features/agenda/agenda-inbox-page.tsx';
import { type AgendaInboxMachine, useAgendaInboxModel } from '../../../../app/hooks/use-agenda-inbox.ts';
import { DaemonAgendaClient } from '../../../../app/lib/agenda-client.ts';
import { inboxCardKey } from '../../../../app/lib/agenda-inbox.ts';
import { daemonConnection, daemonSessionScope } from '../../../../app/shell.ts';
import { agendaItem, choices, fakeInbox } from '../../../support/app/agenda-inbox.tsx';
import { callFromFetch } from '../../../support/app/call-from-fetch.ts';
import { sessionView } from '../../../support/app/sessions.ts';
import { interact, type Mounted, mount, must } from '@ferretry/app/testing';

const laptop = daemonConnection({ daemonId: 'laptop' });
const SESSION = 'sess-2';
const NOW = Date.parse('2026-08-01T12:00:00.000Z');
const FIRST = '2026-08-01T11:30:00.000Z';
const SECOND = '2026-08-01T11:45:00.000Z';

const refused = (reason: string, at: string): AgendaItem =>
  agendaItem('A2', {
    subject: 'Ship it?',
    ask: choices('Ship', 'Hold'),
    waitingSince: '2026-08-01T10:00:00.000Z',
    undelivered: { at, reply: { action: 'dismiss' }, reason },
  } as Partial<AgendaItem>);
const open = (id: string): AgendaItem =>
  agendaItem(id, { subject: 'Rebase onto main?', ask: choices('Rebase now', 'Wait', 'Skip') });

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

const json = (value: unknown): Response =>
  new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });

/** The daemon, scripted: what a GET of the board answers is `read`; what the accepted POST answers is `accepted`. */
const daemon = (script: { read: AgendaSnapshot; accepted: AgendaSnapshot }) => {
  const posts: unknown[] = [];
  const fetcher = async (input: string, init: RequestInit): Promise<Response> => {
    const { pathname } = new URL(input);
    if (pathname === `/v1/ferrets/${SESSION}/agenda`) {
      if (init.method === 'POST') {
        posts.push(JSON.parse(String(init.body)));
        return json(script.accepted);
      }
      return json(script.read);
    }
    return new Response('{}', { status: 404 });
  };
  return { fetcher, posts };
};

class ScriptedClient extends DaemonAgendaClient {}

const summary: SessionAgendaSummary = { open: 2, first: 'A2', ask: 'Ship it?', latestAt: FIRST };
const machines: readonly AgendaInboxMachine[] = [
  {
    connection: laptop,
    name: 'Laptop',
    sessions: [
      sessionView(SESSION, { config: { teammate: 'kai', name: 'Release train' }, state: { agenda: summary } }),
    ],
  },
];

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

const flush = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 6; turn += 1) await new Promise<void>(done => setTimeout(done, 0));
  });
};

const failures = (mounted: Mounted): string =>
  mounted.container.querySelector('[data-agenda-failures]')?.textContent ?? '';
const openView = (mounted: Mounted): string | null | undefined =>
  mounted.container.querySelector('.fy-attn-deck__top [data-agenda-view]')?.getAttribute('data-agenda-view');

describe('a retried answer the machine took and refused later, on the real model and client', () => {
  it('says the second refusal after the accepted board shows the item closed and its reply held', async () => {
    const script = {
      read: board([refused('The machine is offline.', FIRST), open('A3')]),
      accepted: board([open('A3')], { replies: { pending: ['A2'], dueAt: '2026-08-01T12:00:08.000Z' } }),
    };
    const { fetcher, posts } = daemon(script);
    const client = new ScriptedClient(undefined, callFromFetch(fetcher));
    const fake = fakeInbox();
    function Scene() {
      const inbox = useAgendaInboxModel(client, machines, fake.clock);
      return (
        <AgendaInboxPage
          clock={fake.clock.now}
          initialOpen={inboxCardKey(laptop.daemonId, SESSION, 'A2')}
          inbox={inbox}
          now={NOW}
          onNavigate={() => undefined}
          phone={false}
        />
      );
    }
    // The board is held before the page opens, as it is once the reader has been reading the Inbox.
    await client.revalidate(laptop, daemonSessionScope(laptop, SESSION));
    view = await mount(<Scene />);
    await flush();
    const retry = must(view.container.querySelector<HTMLButtonElement>('[data-agenda-retry]'), 'the real Retry');
    await interact(() => retry.click());
    await interact(() => fake.clock.advance(10_000));
    await flush();
    expect(posts).toHaveLength(1);
    // The accepted board: A2 is closed and held (`replies.pending`), A3 stays open and is what the deck shows now.
    const store = client.store.agenda(daemonSessionScope(laptop, SESSION));
    expect(store?.replies?.pending).toEqual(['A2']);
    expect(store?.items.map(each => each.id)).toEqual(['A3']);
    expect(openView(view)).toBe('A3');
    expect(failures(view)).toBe('');
    // Delivery fails: the next read has A2 open again with a fresh reason, while the reader is on A3.
    script.read = board([refused('The machine said no again.', SECOND), open('A3')]);
    await interact(() => client.revalidate(laptop, daemonSessionScope(laptop, SESSION)));
    await flush();
    expect(openView(view)).toBe('A3');
    expect(failures(view)).toContain('The machine said no again.');
  });

  it('says nothing for a retry that was delivered: the board lists the item no more once delivery settles', async () => {
    const script = {
      read: board([refused('The machine is offline.', FIRST), open('A3')]),
      accepted: board([open('A3')], { replies: { pending: ['A2'], dueAt: '2026-08-01T12:00:08.000Z' } }),
    };
    const { fetcher } = daemon(script);
    const client = new ScriptedClient(undefined, callFromFetch(fetcher));
    const fake = fakeInbox();
    function Scene() {
      const inbox = useAgendaInboxModel(client, machines, fake.clock);
      return (
        <AgendaInboxPage
          clock={fake.clock.now}
          initialOpen={inboxCardKey(laptop.daemonId, SESSION, 'A2')}
          inbox={inbox}
          now={NOW}
          onNavigate={() => undefined}
          phone={false}
        />
      );
    }
    // The board is held before the page opens, as it is once the reader has been reading the Inbox.
    await client.revalidate(laptop, daemonSessionScope(laptop, SESSION));
    view = await mount(<Scene />);
    await flush();
    await interact(() =>
      must(view?.container.querySelector<HTMLButtonElement>('[data-agenda-retry]'), 'Retry').click(),
    );
    await interact(() => fake.clock.advance(10_000));
    await flush();
    // Delivered: nothing is held, A2 is gone. Then A2 comes back for an unrelated reason a LATER time (a new ask).
    script.read = board([open('A3')]);
    await interact(() => client.revalidate(laptop, daemonSessionScope(laptop, SESSION)));
    await flush();
    script.read = board([refused('Some other refusal.', SECOND), open('A3')]);
    await interact(() => client.revalidate(laptop, daemonSessionScope(laptop, SESSION)));
    await flush();
    expect(failures(view)).toBe('');
  });
});
