import { describe, expect, test } from 'bun:test';
import type { AgendaGate, AgendaItem } from '@ferretry/core-asks/contract';
import { storedHistory } from '../../../app/lib/agenda-conversation.ts';
import type { HistoryEvent } from '../../../app/lib/agenda-history.ts';
import { replyApproval } from '../../../app/lib/reply-approval.ts';
import { agendaItem } from '../../support/app/agenda-inbox.tsx';

/**
 * A REPLY THAT ALREADY SAYS YES TO THE CARD ASK (&B155): offered only for one open card ask, one forward option, the
 * owner's words last and after the ask, and a plain approval — never guessed from longer text.
 */

const plan: AgendaGate = {
  cardId: 'F923',
  laneId: 'design',
  laneName: 'Plan',
  entry: 4,
  projectId: 'p1',
  options: [
    { id: 'o0', label: 'OK to build', outcome: 'next' },
    { id: 'o1', label: 'Not yet', outcome: 'reopen-with-agenda' },
  ],
};
const test_: AgendaGate = {
  ...plan,
  cardId: 'F12',
  options: [
    { id: 'o0', label: 'Done', outcome: 'close' },
    { id: 'o1', label: 'Not good', outcome: 'reopen-with-agenda' },
  ],
};
/** The ask is raised at 1 ms: replies come after it. */
const holding = (...gates: readonly AgendaGate[]): AgendaItem =>
  agendaItem('A304', {
    ...(gates[0] === undefined ? {} : { gateAttached: gates[0] }),
    ...(gates.length === 0 ? {} : { cardAsks: gates.map(gate => ({ gate, at: new Date(1).toISOString() })) }),
  } as Partial<AgendaItem>);
const offered = (gates: readonly AgendaGate[], history: readonly HistoryEvent[]) =>
  replyApproval(holding(...gates), history);
const owner = (text: string, at = 2, extra: Partial<Extract<HistoryEvent, { kind: 'owner' }>> = {}): HistoryEvent => ({
  kind: 'owner',
  key: `o${String(at)}`,
  at,
  text,
  ...extra,
});
const ferret = (at: number): HistoryEvent =>
  ({ kind: 'ferret', key: `f${String(at)}`, at, text: 'On it.' }) as HistoryEvent;

describe('a reply offered as the card ask’s answer', () => {
  test('is a plain approval, the owner’s last words, offered on the forward option', () => {
    for (const said of ['build', 'ok to build!', 'OK to build', 'Yes.', 'lgtm', 'go ahead 👍', '  Approved!! ']) {
      expect(offered([plan], [ferret(1), owner(said)])).toEqual({
        reply: said.trim(),
        label: 'OK to build',
        ask: 'gate:F923:design:4',
      });
    }
    expect(offered([test_], [owner('works for me')])).toEqual({
      reply: 'works for me',
      label: 'Done',
      ask: 'gate:F12:design:4',
    });
    expect(offered([test_], [owner('done')])?.label).toBe('Done');
  });

  test('never reads more than a plain approval', () => {
    for (const said of ['build it after lunch', 'yes but change the colour', 'not yet', 'why?', 'no', 'x'.repeat(40)]) {
      expect(offered([plan], [owner(said)])).toBeNull();
    }
    // Build words are a plan's, test words a tested card's.
    expect(offered([test_], [owner('build')])).toBeNull();
    expect(offered([plan], [owner('it works')])).toBeNull();
  });

  test('offers nothing when anything came after the words, or they were an answer form, or nothing was said', () => {
    expect(offered([plan], [owner('build', 1), ferret(2)])).toBeNull();
    expect(offered([plan], [owner('build', 1, { form: 'answer' })])).toBeNull();
    expect(offered([plan], [])).toBeNull();
    // A gap line (words still being read) is not the last thing said.
    expect(offered([plan], [owner('build', 3), { kind: 'gap', key: 'g', at: 0 } as HistoryEvent])).toEqual({
      reply: 'build',
      label: 'OK to build',
      ask: 'gate:F923:design:4',
    });
  });

  test('offers nothing for two card asks, none, or an ask with no single forward option', () => {
    expect(offered([plan, test_], [owner('yes')])).toBeNull();
    expect(offered([], [owner('yes')])).toBeNull();
    const two: AgendaGate = {
      ...plan,
      options: [
        { id: 'a', label: 'Ship', outcome: 'next' },
        { id: 'b', label: 'Close', outcome: 'close' },
      ],
    };
    expect(offered([two], [owner('yes')])).toBeNull();
  });
});

describe('the reply as the composer sends it, and the ask it answers', () => {
  test('is offered for the words the composer stored, the item’s reference in front of them', () => {
    // The Inbox composer sends "!A304 ok to build!"; the daemon stores those words as they were sent.
    const stored = storedHistory(holding(plan), [
      { at: new Date(5).toISOString(), by: 'owner', via: 'reply', text: '!A304 ok to build!' },
    ]);
    expect(replyApproval(holding(plan), stored)).toEqual({
      reply: 'ok to build!',
      label: 'OK to build',
      ask: 'gate:F923:design:4',
    });
  });

  test('sets aside the item’s own reference in front, and only that one', () => {
    expect(offered([plan], [owner('!A304 ok to build!')])?.reply).toBe('ok to build!');
    expect(offered([plan], [owner('!A305 ok to build!')])).toBeNull();
  });

  test('counts the open card asks, never the one-ask mirror, and offers nothing without them', () => {
    // Two open asks, one mirrored: which one a "yes" meant is a guess.
    expect(replyApproval(holding(plan, test_), [owner('yes')])).toBeNull();
    // An answered ask is not open: the one left is.
    const answered = {
      ...holding(plan, test_),
      cardAsks: [
        { gate: plan, at: new Date(1).toISOString(), answer: { label: 'OK to build', at: new Date(1).toISOString() } },
        { gate: test_, at: new Date(1).toISOString() },
      ],
    } as unknown as AgendaItem;
    expect(replyApproval(answered, [owner('done')])?.ask).toBe('gate:F12:design:4');
    // A daemon that keeps no card asks: only the mirror, so nothing is offered.
    expect(replyApproval(agendaItem('A304', { gateAttached: plan } as Partial<AgendaItem>), [owner('yes')])).toBeNull();
  });

  test('offers nothing for words said before the ask was raised, or an ask whose time cannot be read', () => {
    expect(offered([plan], [owner('yes', 1)])).toBeNull();
    const unread = { ...holding(plan), cardAsks: [{ gate: plan, at: 'whenever' }] } as unknown as AgendaItem;
    expect(replyApproval(unread, [owner('yes')])).toBeNull();
  });
});
