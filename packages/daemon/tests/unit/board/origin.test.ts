import { describe, it } from 'bun:test';
import type { BoardActor, BoardTask } from '@ferretry/protocol';
import should from 'should';
import {
  askSessionOf,
  BoardIndex,
  cardAskedBy,
  cardOrigin,
  humanParentOf,
  type OriginFacts,
} from '../../../src/lib/board/index.ts';
import { card, MACHINE } from './support.ts';

const LEAD = 'mvuc7tsf-0c3d50df';
const CHILD = 'mvvilibo-3df19c85';

/** The child was started by the lead; every other session by the owner. */
const facts: OriginFacts = { startedByFerret: session => session === CHILD };

const by = (createdBy: BoardActor, source: string, extra: Partial<BoardTask> = {}): BoardTask =>
  card({ createdBy, ask: { text: 'do the thing', source }, ...extra });

const ferret = (sessionId: string): BoardActor => ({ kind: 'ferret', sessionId });

describe('cardOrigin: the owner asked', () => {
  it.each([
    ['the owner made it on the Board page', by({ kind: 'owner' }, 'board')],
    ['the owner made it from a chat', by({ kind: 'owner', sessionId: LEAD }, `session:${LEAD}`)],
    ['the daemon started a session the owner briefed', by({ kind: 'daemon', sessionId: LEAD }, 'owner')],
    ['a sub-ferret recorded words relayed from the owner', by(ferret(CHILD), 'owner via lead denisha, turn-001')],
    ['a ferret recorded an owner reopen', by(ferret(CHILD), 'the owner (fy task reopen)')],
    ['a top-level ferret recorded its own chat', by(ferret(LEAD), `session:${LEAD}`)],
    ['a ferret recorded another owner-started chat', by(ferret(CHILD), `session:${LEAD} (denisha brief)`)],
    ['a top-level ferret wrote a brief path as the source', by(ferret(LEAD), '/tmp/briefs/kt-board-v3.md')],
    ['a ferret this daemon does not know recorded it', by(ferret('mvzzzzzz-00000000'), 'lead message turn-003')],
  ])('should read as human when %s', (_case, subject) => {
    should(cardOrigin(subject, facts)).equal('human');
  });
});

describe('cardOrigin: an agent made it', () => {
  it.each([
    ['a lead started a sub-ferret (fy new)', by({ kind: 'daemon', sessionId: LEAD }, `session:${LEAD}`)],
    ['the board import filed untriaged asks', by({ kind: 'daemon' }, 'board import')],
    ['a sub-ferret recorded its own brief', by(ferret(CHILD), `session:${CHILD}`)],
    ['a sub-ferret wrote a lead message as the source', by(ferret(CHILD), 'lead message queued-47a7847b')],
    ['a ferret recorded words from a sub-ferret session', by(ferret(LEAD), `session:${CHILD}`)],
  ])('should read as agent when %s', (_case, subject) => {
    should(cardOrigin(subject, facts)).equal('agent');
  });

  it('should match the owner as a word, in any case, and never inside another word', () => {
    should(cardOrigin(by(ferret(CHILD), 'OWNER relayed it'), facts)).equal('human');
    should(cardOrigin(by(ferret(CHILD), 'co-owners thread'), facts)).equal('agent');
  });
});

describe('askSessionOf', () => {
  it('should name the session a ferret recorded the ask from, else the recording ferret', () => {
    should(askSessionOf(by(ferret(LEAD), `session:${CHILD}, turn 2`))).equal(CHILD);
    should(askSessionOf(by(ferret(LEAD), `  session:${CHILD}`))).equal(CHILD);
    should(askSessionOf(by(ferret(CHILD), 'lead brief turn-001'))).equal(CHILD);
  });

  it('should need no session when the card decides without one', () => {
    should(askSessionOf(by({ kind: 'owner' }, `session:${CHILD}`))).be.undefined();
    should(askSessionOf(by({ kind: 'daemon', sessionId: LEAD }, `session:${LEAD}`))).be.undefined();
    should(askSessionOf(by(ferret(CHILD), 'owner'))).be.undefined();
  });
});

describe('humanParentOf', () => {
  const human = by({ kind: 'owner' }, 'board', { id: 'F1' });
  const delegated = by({ kind: 'daemon', sessionId: LEAD }, `session:${LEAD}`, { id: 'F2', parent: { id: 'F1' } });
  const grandchild = by(ferret(CHILD), `session:${CHILD}`, { id: 'F3', parent: { id: 'F2' } });
  const originOf = (subject: BoardTask) => cardOrigin(subject, facts);

  it('should name the nearest human ancestor, however deep, and never the card itself', () => {
    // Arrange
    const index = new BoardIndex([human, delegated, grandchild], MACHINE);

    // Act + Assert
    should(humanParentOf(grandchild, index, originOf)).deepEqual({ id: 'F1' });
    should(humanParentOf(delegated, index, originOf)).deepEqual({ id: 'F1' });
    should(humanParentOf(human, index, originOf)).be.null();
  });

  it('should stop at a parent on another machine, at a missing parent, and at a loop', () => {
    // Arrange
    const remote = { ...delegated, id: 'F4', parent: { id: 'F1', machineId: 'other-machine' } };
    const orphan = { ...delegated, id: 'F5', parent: { id: 'F99' } };
    const loopA = by(ferret(CHILD), `session:${CHILD}`, { id: 'F6', parent: { id: 'F7' } });
    const loopB = by(ferret(CHILD), `session:${CHILD}`, { id: 'F7', parent: { id: 'F6' } });
    const index = new BoardIndex([human, remote, orphan, loopA, loopB], MACHINE);

    // Act + Assert
    should(humanParentOf(remote, index, originOf)).be.null();
    should(humanParentOf(orphan, index, originOf)).be.null();
    should(humanParentOf(loopA, index, originOf)).be.null();
  });
});

describe('cardAskedBy: a person asked', () => {
  it.each([
    ['the Board page filed it as the owner', by({ kind: 'owner' }, 'owner (board)')],
    ['a ferret recorded words relayed from the owner', by(ferret(CHILD), 'owner via lead denisha, turn-001')],
    ['a ferret recorded an owner reopen', by(ferret(CHILD), 'the owner (fy task reopen)')],
    ['the daemon started a session the owner briefed', by({ kind: 'daemon', sessionId: LEAD }, 'owner')],
    [
      'a lead brief carries the owner as its source',
      by({ kind: 'owner' }, 'lead mvkm41oz turn-001 brief (owner 2026-10-23)'),
    ],
  ])('should read as person when %s', (_case, subject) => {
    should(cardAskedBy(subject)).equal('person');
  });
});

describe('cardAskedBy: an agent made it', () => {
  it.each([
    ['a lead followed up a review in its own chat', by(ferret(LEAD), `session:${LEAD}`)],
    ['a ferret recorded its own chat as the owner-kind caller', by({ kind: 'owner' }, `session:${LEAD}`)],
    ['a lead started a sub-ferret (fy new)', by({ kind: 'daemon', sessionId: LEAD }, `session:${LEAD}`)],
    ['the board import filed untriaged asks', by({ kind: 'daemon' }, 'board import')],
    ['a ferret wrote a brief path as the source', by(ferret(LEAD), '/tmp/briefs/kt-board-v3.md')],
    ['a ferret this daemon does not know recorded it', by(ferret('mvzzzzzz-00000000'), 'lead message turn-003')],
    ['the word owner sits inside another word', by(ferret(CHILD), 'co-owners thread')],
  ])('should read as agent when %s', (_case, subject) => {
    should(cardAskedBy(subject)).equal('agent');
  });

  it('should be stricter than origin: a card origin shows can still be an agent card for the inbox', () => {
    const own = by(ferret(LEAD), `session:${LEAD}`);
    should(cardOrigin(own, facts)).equal('human');
    should(cardAskedBy(own)).equal('agent');
  });
});
