import { describe, it } from 'bun:test';
import { LANE_TEMPLATES, LaneSetSchema, UNFILED_PROJECT_ID } from '@ferretry/protocol';
import should from 'should';
import {
  BoardError,
  BoardUnavailableError,
  BOARD_UNAVAILABLE_MESSAGE,
  NoAgendaLinks,
  NoopReopenNotifier,
  STUB_LANE_SET_PROPOSER,
  StubLaneSetSource,
} from '../../../src/lib/board/index.ts';
import { card, PROJECT } from './support.ts';

describe('the stubs later units replace', () => {
  it('should file every session on Unfiled and give every board the pr-release-verify lanes, unconfirmed', async () => {
    // Arrange
    const source = new StubLaneSetSource();

    // Act
    const project = await source.projectOf('lead');
    const laneSet = await source.laneSet(PROJECT);

    // Assert
    should(project).equal(UNFILED_PROJECT_ID);
    should(LaneSetSchema.parse(laneSet)).match({
      projectId: PROJECT,
      version: 1,
      confirmedBy: null,
      proposedBy: STUB_LANE_SET_PROPOSER,
    });
    should(laneSet.lanes.map(lane => lane.id)).eql(LANE_TEMPLATES['pr-release-verify'].lanes.map(lane => lane.id));
  });

  it('should know of no asks and deliver no reopen', async () => {
    // Act
    const asks = await new NoAgendaLinks().asksFor([card()]);
    const delivered = await new NoopReopenNotifier().reopened();

    // Assert
    should(asks.size).equal(0);
    should(delivered).be.undefined();
  });
});

describe('board errors', () => {
  it('should carry the refusal code and who may instead', () => {
    // Act
    const error = new BoardError('owner-gate', 'only the owner', ['owner-human']);

    // Assert
    should(error).match({ name: 'BoardError', code: 'owner-gate', allowed: ['owner-human'] });
    should(new BoardError('invalid', 'no').allowed).eql([]);
  });

  it('should keep the evidence of an unavailable board out of its message', () => {
    // Act
    const error = new BoardUnavailableError('card F1 at /home/someone/.ferretry/state/board is damaged');

    // Assert
    should(error.message).equal(BOARD_UNAVAILABLE_MESSAGE);
    should(error.detail).containEql('/home/someone');
  });
});
