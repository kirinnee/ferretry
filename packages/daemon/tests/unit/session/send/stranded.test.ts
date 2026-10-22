import { describe, it } from 'bun:test';
import { queuedMessageInstruction, turnFileInstruction } from '@ferretry/protocol';
import should from 'should';
import {
  type SendRecord,
  sameComposerText,
  showsOwnPointer,
  strandablePointer,
  strandedPointerSend,
} from '../../../../src/lib/session/send/index.ts';

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
    acceptedAt: '2026-10-22T09:00:00.000Z',
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
