import { describe, expect, test } from 'bun:test';
import type { AgendaGate } from '@ferretry/protocol';
import type { HistoryEvent } from '../../src/lib/agenda-history.ts';
import { replyApproval } from '../../src/lib/reply-approval.ts';

/**
 * A REPLY THAT ALREADY SAYS YES TO THE CARD ASK (&B155): offered only for one card ask, one forward option, the
 * owner's words last, and a plain approval — never guessed from longer text.
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
      expect(replyApproval([plan], [ferret(1), owner(said)])).toEqual({ reply: said.trim(), label: 'OK to build' });
    }
    expect(replyApproval([test_], [owner('works for me')])).toEqual({ reply: 'works for me', label: 'Done' });
    expect(replyApproval([test_], [owner('done')])?.label).toBe('Done');
  });

  test('never reads more than a plain approval', () => {
    for (const said of ['build it after lunch', 'yes but change the colour', 'not yet', 'why?', 'no', 'x'.repeat(40)]) {
      expect(replyApproval([plan], [owner(said)])).toBeNull();
    }
    // Build words are a plan's, test words a tested card's.
    expect(replyApproval([test_], [owner('build')])).toBeNull();
    expect(replyApproval([plan], [owner('it works')])).toBeNull();
  });

  test('offers nothing when anything came after the words, or they were an answer form, or nothing was said', () => {
    expect(replyApproval([plan], [owner('build', 1), ferret(2)])).toBeNull();
    expect(replyApproval([plan], [owner('build', 1, { form: 'answer' })])).toBeNull();
    expect(replyApproval([plan], [])).toBeNull();
    // A gap line (words still being read) is not the last thing said.
    expect(replyApproval([plan], [owner('build', 1), { kind: 'gap', key: 'g', at: 0 } as HistoryEvent])).toEqual({
      reply: 'build',
      label: 'OK to build',
    });
  });

  test('offers nothing for two card asks, none, or an ask with no single forward option', () => {
    expect(replyApproval([plan, test_], [owner('yes')])).toBeNull();
    expect(replyApproval([], [owner('yes')])).toBeNull();
    const two: AgendaGate = {
      ...plan,
      options: [
        { id: 'a', label: 'Ship', outcome: 'next' },
        { id: 'b', label: 'Close', outcome: 'close' },
      ],
    };
    expect(replyApproval([two], [owner('yes')])).toBeNull();
  });
});
