import { describe, expect, it } from 'bun:test';
import type { SessionTranscriptMessage, SessionTranscriptPage } from '@ferretry/protocol';
import {
  filterInboxCards,
  filterInboxResolved,
  inboxGroups,
  inboxMachines,
  inboxRowAsk,
  inboxRowTitle,
  NO_FILTER,
  nextSelection,
  QUEUE_END,
  skipSelection,
  stepSelection,
} from '../../src/lib/attention-inbox-list.ts';
import type { InboxResolved } from '../../src/lib/attention-inbox.ts';
import { daemonId } from '../../src/lib/daemon-connection.ts';
import { type MessagesClient, readRecentMessages } from '../../src/lib/recent-messages.ts';
import { attentionItem, inboxCard } from '../support/attention-inbox.tsx';
import { sessionView } from '../support/sessions.ts';

const MIGRATE = sessionView('dm', { config: { teammate: 'johnnie', label: 'diene-migrate' } });
const RELAY = sessionView('ra', { config: { teammate: 'hadi', label: 'Relay advertisement' } });
const LAPTOP = daemonId('laptop');

const a10 = inboxCard(
  attentionItem('A10', { title: 'Finish the org setup', subject: 'Do the owner-only settings' } as never),
  MIGRATE,
);
const a3 = inboxCard(
  attentionItem('A3', { title: 'Restart the relay?', subject: 'Can I restart it?' } as never),
  RELAY,
  'laptop',
  LAPTOP,
);
const a9 = inboxCard(attentionItem('A9', { title: 'Keep CI?', subject: 'Keep the CI workflow?' } as never), MIGRATE);

describe('inboxGroups', () => {
  it('groups by conversation in the order of each group’s first card, keeping card order inside', () => {
    const groups = inboxGroups([a10, a3, a9]);
    expect(groups.map(group => [group.title, group.ferret, group.cards.map(card => card.item.id)])).toEqual([
      ['diene-migrate', 'Johnnie', ['A10', 'A9']],
      ['Relay advertisement', 'Hadi', ['A3']],
    ]);
    expect(groups[1]?.machineName).toBe('laptop');
  });

  it('keeps two machines’ same-id conversations apart', () => {
    const elsewhere = inboxCard(attentionItem('A1'), MIGRATE, 'laptop', LAPTOP);
    expect(inboxGroups([a10, elsewhere])).toHaveLength(2);
  });

  it('names a conversation with no label by its ferret alone', () => {
    const bare = inboxCard(attentionItem('A1'), sessionView('x', { config: { teammate: 'moe', name: undefined } }));
    expect(inboxGroups([bare])[0]).toMatchObject({ title: 'Moe', ferret: null });
  });
});

describe('a row’s words', () => {
  it('is headed by the item’s own title, with the ask under it', () => {
    expect(inboxRowTitle(a10.item)).toBe('Finish the org setup');
    expect(inboxRowAsk(a10.item)).toBe('Do the owner-only settings');
  });

  it('heads an untitled item by the start of its ask — never the conversation — and says why under a short ask', () => {
    const short = attentionItem('A1', { subject: 'Ship it?', why: 'The release is cut.' });
    expect(inboxRowTitle(short)).toBe('Ship it?');
    expect(inboxRowAsk(short)).toBe('The release is cut.');
    const long = attentionItem('A2', { subject: `${'word '.repeat(40)}end` });
    expect(inboxRowTitle(long).length).toBeLessThan(long.subject.length);
    expect(inboxRowAsk(long)).toBe(long.subject);
    const bare = attentionItem('A3', { subject: 'Look', why: 'Look' });
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
        record: { ...attentionItem(id, { subject: `Resolved ${id}` }), resolvedAt: '2026-08-01T00:00:00.000Z' },
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
