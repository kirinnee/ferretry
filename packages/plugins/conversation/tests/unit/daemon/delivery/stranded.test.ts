import { describe, it } from 'bun:test';
import { queuedMessageInstruction, turnFileInstruction } from '../../../../daemon/seams/protocol.ts';
import should from 'should';
import {
  type SendRecord,
  retractedPointer,
  sameComposerText,
  showsOwnPointer,
  strandablePointer,
  strandableText,
  strandedPointerSend,
  strandedSend,
  showsOwnText,
} from '../../../../daemon/delivery/lib/index.ts';
import { at } from '../../../support/instant.ts';

/**
 * Telling a pointer Ferretry typed itself, and never got submitted, from anything a person wrote.
 *
 * The cost of the two mistakes is not symmetric. Missing our own pointer leaves the session refusing
 * every send until somebody reaches the terminal — the bug this exists for. Taking a person's draft
 * for ours would press Enter on their half-written words, which nothing can take back. So every
 * tolerance below is one a TUI's redraw needs, and nothing a person's edit could produce.
 */

const HOME = '/Users/erng/.ferretry/state/sessions';
const OURS = turnFileInstruction(`${HOME}/mvgrhw4h-8d1d074e/turns/turn-012.md`);
const THEIRS = turnFileInstruction(`${HOME}/mvzzzzzz-00000000/turns/turn-012.md`);

function record(overrides: Partial<SendRecord> = {}): SendRecord {
  return {
    sendId: 'send-1',
    acceptedAt: at('2026-10-22T09:00:00.000Z'),
    acceptedTurn: 11,
    path: 'turn-file',
    message: 'a long message the person wrote',
    matchText: OURS,
    turn: 12,
    fate: 'accepted',
    ...overrides,
  };
}

/** How a TUI re-wraps a long line: hard breaks at the width, each row indented to the composer. */
function wrapped(text: string, width: number): string {
  const rows: string[] = [];
  for (let at = 0; at < text.length; at += width) rows.push(text.slice(at, at + width));
  return rows.join('\n  ');
}

describe('recognising our own stranded pointer', () => {
  it('matches the pointer exactly, re-wrapped at any width, and clipped after the whole path', () => {
    const clipped = `${OURS.slice(0, OURS.indexOf('.md') + ' now, then'.length + 3)}…`;

    should(showsOwnPointer(OURS, OURS)).be.true();
    should(showsOwnPointer(wrapped(OURS, 37), OURS)).be.true();
    should(showsOwnPointer(wrapped(OURS, 80), OURS)).be.true();
    should(showsOwnPointer(clipped, OURS)).be.true();
    should(showsOwnPointer(`${OURS.slice(0, OURS.indexOf('.md') + 3)}…`, OURS)).be.true();
  });

  it('finds the one unsettled send of this session whose pointer the composer holds', () => {
    const queued = queuedMessageInstruction(`${HOME}/mvgrhw4h-8d1d074e/channel/queued-send-2.md`);
    const records = [
      record({ sendId: 'send-0', fate: 'delivered' }),
      record(),
      record({ sendId: 'send-2', path: 'native-file', matchText: queued, turn: undefined, fate: 'unaccounted' }),
    ];

    should(strandedPointerSend(wrapped(OURS, 50), records)?.sendId).equal('send-1');
    should(strandedPointerSend(queued, records)?.sendId).equal('send-2');
  });

  it('accepts an open, queued or unconfirmed send, never a settled, held or person-typed one', () => {
    should(strandablePointer(record())).equal(OURS);
    should(strandablePointer(record({ fate: 'queued' }))).equal(OURS);
    should(strandablePointer(record({ fate: 'unaccounted', typedNotSent: true }))).equal(OURS);
    for (const fate of ['delivered', 'cancelled', 'timed_out', 'withdrawn'] as const)
      should(strandablePointer(record({ fate }))).be.undefined();
    should(strandablePointer(record({ held: true }))).be.undefined();
    // A message typed as itself is the person's words, which a person may also have typed.
    should(strandablePointer(record({ path: 'direct', matchText: 'ship it' }))).be.undefined();
    // A pointer path whose text is not a pointer proves nothing.
    should(strandablePointer(record({ matchText: 'Read the file now' }))).be.undefined();
    should(strandablePointer(record({ matchText: undefined }))).be.undefined();
  });
});

describe('leaving everything else alone', () => {
  it('never takes a person’s draft for ours', () => {
    should(strandedPointerSend('hi', [record()])).be.undefined();
    should(strandedPointerSend('Read the file and tell me what it says', [record()])).be.undefined();
    should(strandedPointerSend(`please look at this: ${OURS}`, [record()])).be.undefined();
  });

  it('refuses our pointer once a person has edited it, at either end or in the middle', () => {
    should(showsOwnPointer(`${OURS} and also fix the tests`, OURS)).be.false();
    should(showsOwnPointer(OURS.slice(0, -10), OURS)).be.false();
    should(showsOwnPointer(OURS.replace('turn-012', 'turn-013'), OURS)).be.false();
    should(showsOwnPointer(OURS.replace('carefully ', ''), OURS)).be.false();
  });

  it('refuses another session’s pointer, and a clip that cut into the path so it could be anyone’s', () => {
    should(strandedPointerSend(THEIRS, [record()])).be.undefined();
    // Exactly what the owner's refusal quoted: the path is cut before the session id.
    should(showsOwnPointer('Read the file /Users/erng/.ferretry/stat…', OURS)).be.false();
    should(showsOwnPointer(`${OURS.slice(0, OURS.indexOf('turn-012'))}…`, OURS)).be.false();
    should(showsOwnPointer(`${THEIRS.slice(0, THEIRS.indexOf('.md') + 10)}…`, OURS)).be.false();
  });

  it('matches nothing when two sends would both claim the draft, or the pointer is not one', () => {
    should(strandedPointerSend(OURS, [record(), record({ sendId: 'send-2' })])).be.undefined();
    should(showsOwnPointer(OURS, 'not a pointer')).be.false();
    should(showsOwnPointer('', OURS)).be.false();
  });
});

describe('comparing two readings of the composer', () => {
  it('ignores how the TUI wrapped either, and nothing else', () => {
    should(sameComposerText('fix the\n  login bug', 'fix the login bug')).be.true();
    should(sameComposerText('fix the login bug', 'fix the login bugs')).be.false();
  });
});

describe('B144: a message of ours typed as itself', () => {
  const ENVELOPE =
    '[message from ferret lizzette (session mvgt2oz9-04e28935) — not from the owner]\nTo reply: fy send lizzette "<reply>"\n\nre-verify: CHANGES, one small fix.';
  const inline = (overrides: Partial<SendRecord> = {}) =>
    record({ path: 'native-inline', message: ENVELOPE, matchText: ENVELOPE, turn: undefined, ...overrides });

  it('claims a long message typed as itself, but never one short enough to be a word a person typed', () => {
    should(strandableText(inline())).equal(ENVELOPE);
    should(strandableText(record({ path: 'direct', message: 'ship it', matchText: 'ship it' }))).be.undefined();
    should(strandableText(record({ path: 'direct', message: 'please rerun it', matchText: 'please rerun it' }))).equal(
      'please rerun it',
    );
    should(strandableText(record())).equal(OURS);
  });

  it('claims nothing settled, held, never typed, or carried by a revive', () => {
    for (const fate of ['delivered', 'cancelled', 'timed_out', 'withdrawn'] as const)
      should(strandableText(inline({ fate }))).be.undefined();
    should(strandableText(inline({ held: true }))).be.undefined();
    should(strandableText(inline({ untyped: true }))).be.undefined();
    should(strandableText(record({ untyped: true }))).be.undefined();
    should(strandableText(inline({ path: 'revive' }))).be.undefined();
  });

  it('sees it re-wrapped, clipped, or as the lone paste placeholder Claude collapses it to', () => {
    should(showsOwnText(ENVELOPE, ENVELOPE)).be.true();
    should(showsOwnText(wrapped(ENVELOPE.replaceAll('\n', ' '), 30), ENVELOPE)).be.true();
    should(showsOwnText(`${ENVELOPE.slice(0, 40)}…`, ENVELOPE)).be.true();
    should(showsOwnText('[Pasted text #40 +3 lines]', ENVELOPE)).be.true();
    should(showsOwnText(`[Pasted Content ${ENVELOPE.length} chars]`, ENVELOPE)).be.true();
    should(showsOwnText(OURS, OURS)).be.true();
  });

  it("never takes a person's words, a placeholder beside text, or a placeholder for a literal message", () => {
    should(showsOwnText('half a question', ENVELOPE)).be.false();
    should(showsOwnText(`${ENVELOPE} and also this`, ENVELOPE)).be.false();
    should(showsOwnText('see [Pasted text #40 +3 lines]', ENVELOPE)).be.false();
    should(showsOwnText('[Pasted text #2 +1 lines]', 'please rerun the suite')).be.false();
    // A placeholder whose count disagrees is somebody else's paste — the one a person made after ours was cleared.
    should(showsOwnText('[Pasted text #999 +30 lines]', ENVELOPE)).be.false();
    should(showsOwnText('[Pasted Content 1204 chars]', ENVELOPE)).be.false();
    should(showsOwnText('[Image #1]', ENVELOPE)).be.false();
    should(showsOwnText('[Pasted text #3]', ENVELOPE)).be.false();
    should(showsOwnText(`${ENVELOPE.slice(0, 8)}…`, ENVELOPE)).be.false();
    should(showsOwnText('', ENVELOPE)).be.false();
  });

  it('finds the one send in the box, and refuses when two would both match it', () => {
    const records = [record({ sendId: 'pointer' }), inline({ sendId: 'paste' })];
    should(strandedSend('[Pasted text #40 +3 lines]', records)?.sendId).equal('paste');
    should(strandedSend(OURS, records)?.sendId).equal('pointer');
    should(strandedSend('[Pasted text #41 +3 lines]', [...records, inline({ sendId: 'paste-2' })])).be.undefined();
    should(strandedSend('a person’s words', records)).be.undefined();
  });
});

describe('&B153: a pointer the harness took back after it was delivered', () => {
  const delivered = (overrides: Partial<SendRecord> = {}) =>
    record({ fate: 'delivered', fateAt: at('2026-10-22T09:00:03.000Z'), ...overrides });

  it('claims the newest delivered pointer when the box holds exactly it', () => {
    const records = [
      record({ sendId: 'older', acceptedAt: at('2026-10-22T08:00:00.000Z'), fate: 'delivered' }),
      delivered(),
    ];
    should(retractedPointer(delivered(), records)).equal(OURS);
    should(strandableText(delivered(), records)).equal(OURS);
    should(strandedSend(wrapped(OURS, 40), records)?.sendId).equal('send-1');
  });

  it('leaves a delivered pointer alone once anything was typed after it: the conversation moved on', () => {
    const later = record({
      sendId: 'later',
      path: 'direct',
      acceptedAt: at('2026-10-22T09:05:00.000Z'),
      message: 'a later message typed as itself',
      matchText: 'a later message typed as itself',
      fate: 'delivered',
    });
    should(retractedPointer(delivered(), [delivered(), later])).be.undefined();
    should(strandedSend(OURS, [delivered(), later])).be.undefined();
  });

  it('is not moved by a later send that was never typed: held for a revive, untyped, or withdrawn', () => {
    const at = '2026-10-22T09:05:00.000Z';
    for (const other of [
      record({ sendId: 'held', acceptedAt: at, held: true }),
      record({ sendId: 'untyped', acceptedAt: at, untyped: true }),
      record({ sendId: 'withdrawn', acceptedAt: at, fate: 'withdrawn' }),
    ])
      should(retractedPointer(delivered(), [delivered(), other])).equal(OURS);
  });

  it('claims only a delivered POINTER — never a message typed as itself, nor any other fate', () => {
    const ENVELOPE = '[message from ferret lizzette — not from the owner]\nplease rerun the whole suite';
    const inline = delivered({ path: 'native-inline', message: ENVELOPE, matchText: ENVELOPE, turn: undefined });
    should(retractedPointer(inline, [inline])).be.undefined();
    should(strandableText(inline, [inline])).be.undefined();
    for (const fate of ['cancelled', 'timed_out', 'withdrawn'] as const)
      should(retractedPointer(record({ fate }), [record({ fate })])).be.undefined();
    should(retractedPointer(delivered({ held: true }), [delivered({ held: true })])).be.undefined();
    should(retractedPointer(delivered({ matchText: 'Read the file now' }), [delivered()])).be.undefined();
  });

  it('keeps the tracker’s single-record reading unchanged: a delivered send is not watched', () => {
    should(strandableText(delivered())).be.undefined();
  });

  it('never takes a person’s draft, an edited pointer or another session’s pointer for the taken-back one', () => {
    should(strandedSend('half a question', [delivered()])).be.undefined();
    should(strandedSend(`${OURS} and also this`, [delivered()])).be.undefined();
    should(strandedSend(THEIRS, [delivered()])).be.undefined();
  });
});

describe('&B153: Claude’s countless paste chip is never claimed after the fact', () => {
  const ONE_LINE = `approve — ${'third-round review of the change, all threads answered; '.repeat(30)}`;
  const inline = (overrides: Partial<SendRecord> = {}) =>
    record({ path: 'direct', message: ONE_LINE, matchText: ONE_LINE, turn: undefined, ...overrides });

  it('leaves `[Pasted text #N]` alone: a person who cleared ours and pasted their own line draws one too', () => {
    should(showsOwnText('[Pasted text #30]', ONE_LINE)).be.false();
    should(showsOwnText('[Pasted text #31]', ONE_LINE)).be.false();
    should(strandedSend('[Pasted text #30]', [inline()])).be.undefined();
  });
});

describe('&B153: ordering by when a send was last typed (review)', () => {
  it('counts a pointer retried after a later send as the newest, and the later send as older', () => {
    // A accepted 09:00, timed out; B delivered 09:05; A retried and delivered 09:10, then taken back.
    const pointerA = record({
      fate: 'delivered',
      acceptedAt: at('2026-10-22T09:00:00.000Z'),
      attemptAt: at('2026-10-22T09:10:00.000Z'),
    });
    const inlineB = record({
      sendId: 'b',
      path: 'direct',
      fate: 'delivered',
      acceptedAt: at('2026-10-22T09:05:00.000Z'),
      message: 'a message typed as itself',
      matchText: 'a message typed as itself',
    });

    should(retractedPointer(pointerA, [pointerA, inlineB])).equal(OURS);
    should(strandedSend(OURS, [pointerA, inlineB])?.sendId).equal('send-1');
  });
});

describe('&B153: a taken-back pointer is claimed only whole (review round 4)', () => {
  const delivered = record({ fate: 'delivered' });

  it('claims it re-wrapped, never clipped, cut short or edited', () => {
    should(strandedSend(wrapped(OURS, 37), [delivered])?.sendId).equal('send-1');
    const clipped = `${OURS.slice(0, OURS.indexOf('.md') + ' now, then'.length + 3)}…`;
    should(strandedSend(clipped, [delivered])).be.undefined();
    should(strandedSend(`${OURS.slice(0, OURS.indexOf('.md') + 3)} …`, [delivered])).be.undefined();
    should(strandedSend(OURS.replace('carefully ', ''), [delivered])).be.undefined();
    should(strandedSend(`${OURS} and also this`, [delivered])).be.undefined();
    // The same clip of an OPEN send is still claimed, as B144 always did.
    should(strandedSend(clipped, [record()])?.sendId).equal('send-1');
  });
});
