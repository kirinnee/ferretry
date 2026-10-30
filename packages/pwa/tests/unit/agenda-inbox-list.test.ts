import { describe, expect, it } from 'bun:test';
import type { SessionTranscriptMessage, SessionTranscriptPage } from '@ferretry/protocol';
import { swipeTargets } from '../../src/lib/agenda-answers.ts';
import type { InboxResolved } from '../../src/lib/agenda-inbox.ts';
import {
  filterInboxCards,
  filterInboxResolved,
  groupCards,
  inboxMachines,
  inboxRowAsk,
  inboxRowTitle,
  inboxSections,
  inboxSourceFromSearch,
  inboxSwipeTargets,
  inboxWho,
  isFromWarden,
  NO_FILTER,
  nextSelection,
  QUEUE_END,
  skipSelection,
  stepSelection,
} from '../../src/lib/agenda-inbox-list.ts';
import { daemonId } from '../../src/lib/daemon-connection.ts';
import { type MessagesClient, readRecentMessages } from '../../src/lib/recent-messages.ts';
import { agendaItem, choices, inboxCard } from '../support/agenda-inbox.tsx';
import { sessionView } from '../support/sessions.ts';

const MIGRATE = sessionView('dm', { config: { teammate: 'johnnie', name: 'diene-migrate' } });
const RELAY = sessionView('ra', { config: { teammate: 'hadi', name: 'Relay advertisement' } });
const LAPTOP = daemonId('laptop');

const a10 = inboxCard(
  agendaItem('A10', { title: 'Finish the org setup', subject: 'Do the owner-only settings' } as never),
  MIGRATE,
);
const a3 = inboxCard(
  agendaItem('A3', { title: 'Restart the relay?', subject: 'Can I restart it?' } as never),
  RELAY,
  'laptop',
  LAPTOP,
);
const a9 = inboxCard(agendaItem('A9', { title: 'Keep CI?', subject: 'Keep the CI workflow?' } as never), MIGRATE);

const stoppedView = (id: string) =>
  sessionView(id, {
    config: { teammate: 'moe', name: undefined },
    state: { attention: { open: 1, first: 'A1', ask: 'Go?', latestAt: '2026-08-01T11:00:00.000Z', stopped: true } },
  } as never);

describe('inboxSections', () => {
  it('groups by ferret in the order of each group’s most urgent item, keeping the agenda order inside', () => {
    const { needsYou } = inboxSections([a10, a3, a9], []);
    expect(needsYou.map(group => [group.ferret, group.task, group.items.map(card => card.item.id)])).toEqual([
      ['Johnnie', 'diene-migrate', ['A10', 'A9']],
      ['Hadi', 'Relay advertisement', ['A3']],
    ]);
    expect(needsYou[1]?.machineName).toBe('laptop');
  });

  it('keeps two machines’ same-id conversations apart', () => {
    const elsewhere = inboxCard(agendaItem('A1'), MIGRATE, 'laptop', LAPTOP);
    expect(inboxSections([a10, elsewhere], []).needsYou).toHaveLength(2);
  });

  it('names a conversation with no name by its folder, the ferret beside it', () => {
    const bare = inboxCard(agendaItem('A1'), sessionView('x', { config: { teammate: 'moe', name: undefined } }));
    expect(inboxSections([bare], []).needsYou[0]).toMatchObject({ ferret: 'Moe', task: 'x' });
  });

  it('puts a stopped ferret first, a ferret on its turn last, and a notice beside its items', () => {
    const stopped = inboxCard(agendaItem('A1'), stoppedView('halt'));
    const notice = inboxCard(agendaItem('N1', { notice: true } as never), MIGRATE);
    const waitingOnFerret = inboxCard(agendaItem('F1', { waitingOn: 'ferret', waitingFor: 'info' } as never), RELAY);
    const sections = inboxSections([a10, stopped, notice], [waitingOnFerret]);
    expect(sections.stopped.map(group => group.ferret)).toEqual(['Moe']);
    expect(sections.needsYou.map(group => group.ferret)).toEqual(['Johnnie']);
    expect(sections.needsYou[0]?.items.map(card => card.item.id)).toEqual(['A10']);
    expect(sections.needsYou[0]?.notices.map(card => card.item.id)).toEqual(['N1']);
    expect(sections.withFerrets.map(group => [group.ferret, group.stopped])).toEqual([['Hadi', false]]);
    expect(groupCards(sections.needsYou).map(card => card.item.id)).toEqual(['A10', 'N1']);
  });
});

describe('the Warden filter', () => {
  const warden = inboxCard(
    agendaItem('W1', { raisedBy: 'daemon', sourceRef: 'warden:ask:fleet:spend:laptop' } as never),
    MIGRATE,
  );
  const wardenKind = inboxCard(
    agendaItem('W2', { raisedBy: 'daemon', sourceRef: 'warden:ask:spend' } as never),
    RELAY,
    'laptop',
    LAPTOP,
  );
  const daemonOther = inboxCard(agendaItem('D1', { raisedBy: 'daemon', sourceRef: 'schedule:7' } as never), MIGRATE);
  const agentNamingIt = inboxCard(agendaItem('G1', { sourceRef: 'warden:ask:spend' } as never), MIGRATE);

  it('reads ?from=warden, and nothing else', () => {
    expect(inboxSourceFromSearch('?from=warden')).toBe('warden');
    expect(inboxSourceFromSearch('?from=other')).toBeNull();
    expect(inboxSourceFromSearch('')).toBeNull();
  });

  it('wants the daemon’s hand AND a warden: source', () => {
    expect(isFromWarden(warden.item)).toBe(true);
    expect(isFromWarden(wardenKind.item)).toBe(true);
    expect(isFromWarden(daemonOther.item)).toBe(false);
    expect(isFromWarden(agentNamingIt.item)).toBe(false);
  });

  it('keeps only Warden items across every machine, and lifts with the filter', () => {
    const all = [warden, wardenKind, daemonOther, agentNamingIt, a10];
    const kept = filterInboxCards(all, { machine: null, query: '', from: 'warden' });
    expect(kept.map(card => card.item.id)).toEqual(['W1', 'W2']);
    expect(filterInboxCards(all, NO_FILTER)).toHaveLength(5);
  });

  it('filters resolved rows the same way', () => {
    const row = (card: typeof warden): InboxResolved =>
      ({
        key: card.key,
        daemonId: card.daemonId,
        machineName: card.machineName,
        view: card.view,
        record: { ...card.item, resolvedAt: '2026-08-01T00:00:00.000Z' },
      }) as never;
    const rows = [row(warden), row(daemonOther)];
    expect(filterInboxResolved(rows, { machine: null, query: '', from: 'warden' })).toHaveLength(1);
  });
});

describe('a row’s words', () => {
  it('is headed by the item’s own title, with the ask under it', () => {
    expect(inboxRowTitle(a10.item)).toBe('Finish the org setup');
    expect(inboxRowAsk(a10.item)).toBe('Do the owner-only settings');
  });

  it('heads an untitled item by the start of its ask — never the conversation — and says why under a short ask', () => {
    const short = agendaItem('A1', { subject: 'Ship it?', why: 'The release is cut.' });
    expect(inboxRowTitle(short)).toBe('Ship it?');
    expect(inboxRowAsk(short)).toBe('The release is cut.');
    const long = agendaItem('A2', { subject: `${'word '.repeat(40)}end` });
    expect(inboxRowTitle(long).length).toBeLessThan(long.subject.length);
    expect(inboxRowAsk(long)).toBe(long.subject);
    const bare = agendaItem('A3', { subject: 'Look', why: 'Look' });
    expect(inboxRowAsk(bare)).toBeNull();
  });
});

describe('the header’s filters', () => {
  it('lists every machine once, in the order they appear', () => {
    expect(inboxMachines([a10, a3, a9])).toEqual([
      { daemonId: daemonId('workshop'), name: 'Workshop' },
      { daemonId: LAPTOP, name: 'laptop' },
    ]);
  });

  it('narrows to one machine', () => {
    expect(filterInboxCards([a10, a3, a9], { machine: LAPTOP, query: '' }).map(card => card.item.id)).toEqual(['A3']);
    expect(filterInboxCards([a10, a3, a9], NO_FILTER)).toHaveLength(3);
  });

  it('finds every word, in any case, across title, ask, reference, conversation and ferret', () => {
    const ids = (query: string) => filterInboxCards([a10, a3, a9], { machine: null, query }).map(card => card.item.id);
    expect(ids('RESTART')).toEqual(['A3']);
    expect(ids('owner settings')).toEqual(['A10']);
    expect(ids('!a9')).toEqual(['A9']);
    expect(ids('diene-migrate')).toEqual(['A10', 'A9']);
    expect(ids('hadi')).toEqual(['A3']);
    expect(ids('  ')).toEqual(['A10', 'A3', 'A9']);
    expect(ids('nothing like this')).toEqual([]);
  });

  it('applies the same filter to resolved rows', () => {
    const row = (id: string, view = MIGRATE): InboxResolved =>
      ({
        key: id,
        daemonId: daemonId('workshop'),
        machineName: 'Workshop',
        view,
        record: { ...agendaItem(id, { subject: `Resolved ${id}` }), resolvedAt: '2026-08-01T00:00:00.000Z' },
      }) as never;
    expect(filterInboxResolved([row('A1'), row('A2', RELAY)], { machine: null, query: 'hadi' })).toHaveLength(1);
  });
});

describe('the selection', () => {
  it('keeps the reader’s pick while it is listed', () => {
    expect(nextSelection(['a', 'b', 'c'], 'b', ['a', 'b', 'c'])).toBe('b');
  });

  it('moves FORWARD to the item after one that left, and past the last one to the end — never back to the top', () => {
    expect(nextSelection(['a', 'b', 'c'], 'b', ['a', 'c'])).toBe('c');
    // Skipped a and b, answered c: the queue ends; it does not deal a again.
    expect(nextSelection(['a', 'b', 'c'], 'c', ['a', 'b'])).toBe(QUEUE_END);
    expect(nextSelection(['a', 'b'], QUEUE_END, ['a', 'b'])).toBe(QUEUE_END);
    expect(nextSelection(['a', 'b'], 'z', ['a', 'b'])).toBe('a');
    expect(nextSelection([], null, ['x'])).toBe('x');
    expect(nextSelection(['a'], 'a', [])).toBeNull();
    expect(nextSelection(['a'], QUEUE_END, [])).toBeNull();
  });

  it('skips forward one at a time, several in a row, to the end', () => {
    expect(skipSelection(['a', 'b', 'c'], 'a')).toBe('b');
    expect(skipSelection(['a', 'b', 'c'], 'c')).toBe(QUEUE_END);
    expect(skipSelection(['a', 'b'], null)).toBe('a');
    expect(skipSelection([], null)).toBe(QUEUE_END);
  });

  it('steps one row up or down, clamped at both ends', () => {
    expect(stepSelection(['a', 'b', 'c'], 'a', 1)).toBe('b');
    expect(stepSelection(['a', 'b', 'c'], 'c', 1)).toBe('c');
    expect(stepSelection(['a', 'b', 'c'], 'a', -1)).toBe('a');
    expect(stepSelection(['a', 'b'], 'gone', 1)).toBe('a');
    expect(stepSelection([], 'a', 1)).toBeNull();
  });
});

describe('readRecentMessages', () => {
  let point = 0;
  const message = (role: SessionTranscriptMessage['role'], text: string): SessionTranscriptMessage => {
    point += 1;
    return { point: { index: point }, role, text, selectionBinding: 'b' } as never;
  };
  const fakeClient = (pages: Record<string, SessionTranscriptPage>) => {
    const asked: (string | undefined)[] = [];
    const client: MessagesClient = {
      messages: async (_id, cursor) => {
        asked.push(cursor);
        const page = pages[cursor ?? 'start'];
        if (page === undefined) throw new Error(`no page ${cursor}`);
        return page;
      },
    };
    return { client, asked };
  };
  const page = (messages: SessionTranscriptMessage[], nextCursor: string | null): SessionTranscriptPage => ({
    v: 1,
    sessionId: 's',
    messages,
    nextCursor,
  });

  it('walks to the end and keeps the last few assistant messages, oldest first, skipping blanks and the owner', async () => {
    const { client } = fakeClient({
      start: page([message('assistant', 'one'), message('user', 'hi'), message('assistant', 'two')], 'p2'),
      p2: page([message('assistant', '   '), message('assistant', 'three'), message('assistant', 'four')], null),
    });
    expect((await readRecentMessages(client, 's', 3)).map(entry => entry.text)).toEqual(['two', 'three', 'four']);
  });

  it('gives up after its page budget, keeping what it found and where to resume', async () => {
    let asked = 0;
    const endless: MessagesClient = {
      messages: async () => {
        asked += 1;
        return page([message('assistant', `page ${asked}`)], `p${asked}`);
      },
    };
    const memory = new Map();
    const found = await readRecentMessages(endless, 's', 2, memory);
    expect(found.map(entry => entry.text)).toEqual(['page 39', 'page 40']);
    expect(asked).toBe(40);
    expect(memory.get('s')).toMatchObject({ from: 'p40' });
  });

  it('resumes a remembered walk from its last page instead of the start', async () => {
    const pages = {
      start: page([message('assistant', 'one')], 'p2'),
      p2: page([message('assistant', 'two')], null),
    };
    const { client, asked } = fakeClient(pages);
    const memory = new Map();
    expect((await readRecentMessages(client, 's', 3, memory)).map(entry => entry.text)).toEqual(['one', 'two']);
    pages.p2 = page([message('assistant', 'two'), message('assistant', 'three')], null);
    expect((await readRecentMessages(client, 's', 3, memory)).map(entry => entry.text)).toEqual([
      'one',
      'two',
      'three',
    ]);
    expect(asked).toEqual([undefined, 'p2', 'p2']);
  });
});

describe('inboxSections reading a stopped ferret under the agenda name', () => {
  it('puts a ferret whose daemon wrote only the agenda summary among the stopped', () => {
    const view = sessionView('halt', {
      config: { teammate: 'moe', name: undefined },
      state: { agenda: { open: 1, first: 'A1', ask: 'Go?', latestAt: '2026-08-01T11:00:00.000Z', stopped: true } },
    } as never);
    const sections = inboxSections([inboxCard(agendaItem('A1'), view)], []);
    expect(sections.stopped.map(group => group.ferret)).toEqual(['Moe']);
  });
});

describe('the open item’s swipes', () => {
  const labels = (targets: ReturnType<typeof swipeTargets>) =>
    Object.fromEntries(Object.entries(targets).map(([direction, target]) => [direction, target?.label]));

  it('puts the primary answer on ↑, keeps ←, and gives → what ↑ gave', () => {
    const three = swipeTargets(agendaItem('A1', { ask: choices('Rebase now', 'Wait', 'Later') }));
    expect(labels(inboxSwipeTargets(three))).toEqual({ left: 'Later', up: 'Rebase now', right: 'Wait' });
  });

  it('keeps → on the primary when nothing was on ↑, and leaves a card with no primary alone', () => {
    const two = swipeTargets(agendaItem('A2', { ask: choices('Ship', 'Hold') }));
    expect(labels(inboxSwipeTargets(two))).toEqual({ left: 'Hold', up: 'Ship', right: 'Ship' });
    const none = swipeTargets(agendaItem('A3', { answers: [] } as never));
    expect(inboxSwipeTargets(none)).toBe(none);
  });
});

describe('who an item is from', () => {
  it('says the ferret, its task, its card and its machine — the item’s own card first', () => {
    const view = sessionView('s1', {
      config: { teammate: 'kai', name: 'Release train', focusTask: { id: 'F9' } } as never,
    });
    expect(inboxWho(inboxCard(agendaItem('A1', { task: { id: 'F12' } } as never), view, 'Laptop'))).toEqual({
      ferret: 'Kai',
      task: 'Release train',
      card: '&F12',
      machine: 'Laptop',
    });
    expect(inboxWho(inboxCard(agendaItem('A1'), view, 'Laptop')).card).toBe('&F9');
  });

  it('says the folder it works in when the conversation has no task of its own, and no card when it has none', () => {
    const view = sessionView('s2', { config: { teammate: 'moe', name: 'Moe', cwd: '/work/ledger' } });
    expect(inboxWho(inboxCard(agendaItem('A1'), view))).toEqual({
      ferret: 'Moe',
      task: 'ledger',
      card: null,
      machine: 'Workshop',
    });
  });

  it('has no task when there is neither a task nor a folder: the callsign alone', () => {
    const view = sessionView('s3', { config: { teammate: 'moe', name: 'Moe', cwd: '' } });
    expect(inboxWho(inboxCard(agendaItem('A1'), view)).task).toBeNull();
  });
});
