import { describe, it } from 'bun:test';
import { MAX_BOARD_NOTE_LENGTH, MAX_BOARD_REASON_LENGTH, type PrLink } from '@ferretry/protocol';
import should from 'should';
import { clip, DONE_WITHOUT_MESSAGE, doneLane, doneMove, doneNote, doneReason } from '../../../src/lib/board/index.ts';
import { card, lanes, NOW, PROJECT } from './support.ts';

const PR: PrLink = {
  url: 'https://github.com/kirinnee/ferretry/pull/930',
  number: 930,
  repo: 'kirinnee/ferretry',
  state: 'open',
  draft: false,
  checks: 'none',
  mergedAt: null,
  mergeSha: null,
  releasedIn: null,
  polledAt: null,
};

const daemon = { now: NOW, actor: { kind: 'daemon' as const, sessionId: 'child' } };

describe('the done message on a card', () => {
  it('should say done with the message, or that it was signalled, cut at the field', () => {
    // Act
    const said = doneNote('  shipped the store  ');
    const silent = doneNote(undefined);
    const long = doneNote('x'.repeat(MAX_BOARD_NOTE_LENGTH + 10));

    // Assert
    should(said).equal('done: shipped the store');
    should(silent).equal(DONE_WITHOUT_MESSAGE);
    should(long.length).equal(MAX_BOARD_NOTE_LENGTH);
    should(long.endsWith('…')).be.true();
  });

  it('should give the message as the reason, cut at the field', () => {
    // Act / Assert
    should(doneReason(' tests green ')).equal('tests green');
    should(doneReason('')).equal(DONE_WITHOUT_MESSAGE);
    should(doneReason('y'.repeat(MAX_BOARD_REASON_LENGTH * 2)).length).equal(MAX_BOARD_REASON_LENGTH);
    should(clip('short', 10)).equal('short');
  });
});

describe('where a done card goes', () => {
  it('should go to the lane its variant enters on signal.done when it is in an active lane with no PR', () => {
    // Act / Assert
    should(doneLane(card({ laneId: 'implement' }), lanes())?.id).equal('review');
    should(doneLane(card({ laneId: 'plan' }), lanes())?.id).equal('review');
    should(doneLane(card({ laneId: 'fix', workflow: 'quick' }), lanes(PROJECT, 'ops'))?.id).equal('verify');
    should(doneLane(card({ laneId: 'draft' }), lanes(PROJECT, 'writing'))?.id).equal('review');
  });

  it('should fall back to the first review or verify lane ahead, else the next lane', () => {
    // Arrange
    const noTrigger = lanes();
    const plain = {
      ...noTrigger,
      lanes: noTrigger.lanes.map(lane => ({ ...lane, enterOn: lane.enterOn?.filter(on => on !== 'signal.done') })),
    };
    const noReview = {
      ...plain,
      lanes: plain.lanes.filter(lane => lane.id !== 'review' && lane.id !== 'tested'),
      variants: {},
    };

    // Act / Assert
    should(doneLane(card({ laneId: 'implement' }), plain)?.id).equal('review');
    should(doneLane(card({ laneId: 'implement' }), noReview)?.id).equal('merged');
  });

  it('should stay put with a PR, outside an active lane, dropped, or when the lane ahead is closed', () => {
    // Arrange
    const withPr = card({ laneId: 'implement', links: { prs: [PR], branch: null, commits: [], docs: [] } });
    const dropped = card({ laneId: 'implement', dropped: { reason: 'superseded', at: NOW } });

    // Act / Assert
    should(doneLane(withPr, lanes())).be.null();
    should(doneLane(card({ laneId: 'todo' }), lanes())).be.null();
    should(doneLane(card({ laneId: 'review' }), lanes())).be.null();
    should(doneLane(dropped, lanes())).be.null();
    should(doneLane(card({ laneId: 'doing', workflow: 'quick' }), lanes(PROJECT, 'quick'))).be.null();
    should(doneLane(card({ laneId: 'nowhere' }), lanes())).be.null();
  });

  it('should stay put when the workflow has no lanes this set knows', () => {
    // Arrange
    const broken = { ...lanes(), variants: { 'design-first': ['ghost'] } };

    // Act / Assert
    should(doneLane(card({ laneId: 'implement' }), broken)).be.null();
  });
});

describe('the done move', () => {
  const review = lanes().lanes.find(lane => lane.id === 'review');
  const implement = card({ laneId: 'implement' });

  it("should be the daemon's automatic signal.done move with the message as its reason", () => {
    // Act
    const move = doneMove(implement, review!, lanes(), [], 'all green', daemon);

    // Assert
    should('task' in move && move.task.laneId).equal('review');
    should('task' in move && move.task.history.at(-1)).match({
      type: 'moved',
      from: 'implement',
      to: 'review',
      backward: false,
      reason: 'all green',
      auto: true,
      trigger: 'signal.done',
      actor: { kind: 'daemon', sessionId: 'child' },
    });
  });

  it('should hold a card behind an owner gate or an unfinished blocker, and say why', () => {
    // Arrange
    const gated = card({ laneId: 'plan' });

    // Act
    const atGate = doneMove(gated, review!, lanes(), [], 'designed', daemon);
    const blocked = doneMove(implement, review!, lanes(), [{ id: 'F9' }], 'built', daemon);

    // Assert
    should(atGate).deepEqual({ held: 'only the owner moves &F1 on from plan, so it stays there' });
    should(blocked).deepEqual({ held: '&F1 is blocked by &F9, so it stays in implement' });
  });
});
