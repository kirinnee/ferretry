import { describe, expect, test } from 'bun:test';
import type { AgendaGate } from '@ferretry/protocol';
import { typedApproval } from '../../src/lib/reply-approval.ts';

/**
 * WORDS TYPED AT A TRY-IT THAT PLAINLY SAY YES (&B155): "works now" is Good, never Not good. Read only for a try-it with one
 * forward option, and only when the whole message is a plain approval — never guessed from longer text.
 */

const plan: AgendaGate = {
  cardId: 'F923',
  laneId: 'design',
  laneName: 'Plan',
  entry: 4,
  projectId: 'p1',
  options: [{ id: 'o0', label: 'OK to build', outcome: 'next' }],
};
const test_: AgendaGate = {
  ...plan,
  cardId: 'F12',
  options: [
    { id: 'o0', label: 'Done', outcome: 'close' },
    { id: 'o1', label: 'Not good', outcome: 'reopen-with-agenda' },
  ],
};
describe('words typed at a try-it that plainly approve', () => {
  test('are the pass option, for the owner’s case "works now" and its kin', () => {
    for (const said of [
      'works now',
      'Works now',
      'it works now!',
      'works',
      'works fine',
      'works great.',
      'it works well',
      'good now',
      'good',
      'Good!',
      'lgtm',
      'looks good',
      'tested, ok',
      'tested ok',
      'done',
      'works for me 👍',
      '  works now  ',
    ]) {
      expect(typedApproval(test_, said)).toBe('Done');
    }
  });

  test('are never read from anything that is not clearly positive: a clause, a negation, a question, a long message', () => {
    for (const said of [
      'works but the colour is off',
      'works now, but the badge is red',
      'however it works now',
      "doesn't work now",
      'does not work now',
      'not good',
      'not working',
      "it isn't good now",
      'works now?',
      'does it work now?',
      'no',
      'works now and I also want the badge bigger',
      '',
      'x'.repeat(40),
    ]) {
      expect(typedApproval(test_, said)).toBeNull();
    }
  });

  test('are never read at an approval ("ok" there is a Not yet word), or at a gate with no single pass', () => {
    // An approval has one option and no Not good: its typed words are Not yet words.
    const approval = plan;
    for (const said of ['ok', 'yes', 'works now', 'lgtm', 'build']) expect(typedApproval(approval, said)).toBeNull();
    const two: AgendaGate = {
      ...test_,
      options: [
        { id: 'a', label: 'Done', outcome: 'close' },
        { id: 'b', label: 'Ship', outcome: 'next' },
        { id: 'c', label: 'Not good', outcome: 'reopen-with-agenda' },
      ],
    };
    expect(typedApproval(two, 'works now')).toBeNull();
  });

  test('keep a lane’s own pass label (its words, the plain approvals and a tester’s), and offer a stored reply', () => {
    const lane: AgendaGate = {
      ...test_,
      options: [
        { id: 'a', label: 'Verified', outcome: 'close' },
        { id: 'b', label: 'Not good', outcome: 'reopen-with-agenda' },
      ],
    };
    expect(typedApproval(lane, 'verified')).toBe('Verified');
    expect(typedApproval(lane, 'lgtm')).toBe('Verified');
    // A try-it is a try-it whatever the lane calls its pass: "works now" is a yes there, offered under the pass's own label.
    expect(typedApproval(lane, 'works now')).toBe('Verified');
    const good: AgendaGate = {
      ...lane,
      options: [
        { id: 'a', label: 'Good', outcome: 'close' },
        { id: 'b', label: 'Not good', outcome: 'reopen-with-agenda' },
      ],
    };
    expect(typedApproval(good, 'it works now!')).toBe('Good');
    // Build words stay an approval's: a try-it never reads "build" as a yes.
    expect(typedApproval(lane, 'build')).toBeNull();
  });
});
