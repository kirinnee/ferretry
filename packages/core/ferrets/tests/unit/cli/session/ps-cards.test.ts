import { describe, it } from 'bun:test';
import {
  type BoardProject,
  type BoardProjectsResponse,
  type BoardQueryInput,
  type BoardResponse,
  MAX_BOARD_PAGE,
} from '@ferretry/protocol';
import should from 'should';
import { type BoardLaneSource, boardLaneNames, laneNamesFrom } from '../../../src/lib/session/ps-cards.ts';
import { card, listing, OTHER_ID, otherProject, project, response } from '../board/fixtures.ts';

/** The page a cross-project read returns: no one lane set, cards from several boards. */
const page = (cards: BoardResponse['cards']): BoardResponse =>
  response({ projectId: null, laneSet: null, cards: [...cards] });

/** Both projects' lane sets, as the projects listing carries them. */
const projects: readonly BoardProject[] = [project(), otherProject()];

/** Records the reads the CARD column made, and answers them from fixtures. */
class RecordingSource implements BoardLaneSource {
  readonly boardQueries: BoardQueryInput[] = [];
  projectsCalls = 0;

  constructor(
    private readonly cards: BoardResponse['cards'],
    private readonly listingProjects: readonly BoardProject[],
  ) {}

  board(query: BoardQueryInput): Promise<BoardResponse> {
    this.boardQueries.push(query);
    return Promise.resolve(page(this.cards));
  }

  projects(): Promise<BoardProjectsResponse> {
    this.projectsCalls += 1;
    return Promise.resolve(listing({ projects: [...this.listingProjects] }));
  }
}

describe('laneNamesFrom', () => {
  it('should name each card from its own project lanes', () => {
    // Arrange — two boards, each with its own spelling of "where the card is".
    const names = laneNamesFrom(
      page([
        card({ id: 'F18', laneId: 'todo' }),
        card({ id: 'B7', kind: 'bug', projectId: OTHER_ID, laneId: 'investigate' }),
      ]),
      projects,
    );

    // Act / Assert
    should(names.get('F18')).equal('Todo');
    should(names.get('B7')).equal('Investigate');
    should(names.size).equal(2);
  });

  it('should leave out a card whose project has no lane set or whose lane is not on it', () => {
    // Arrange
    const names = laneNamesFrom(
      page([
        card({ id: 'C3', kind: 'chore', projectId: 'unfiled', laneId: 'todo' }),
        card({ id: 'F9', laneId: 'a-lane-this-set-does-not-have' }),
      ]),
      projects,
    );

    // Act / Assert — absent, not an error: the CARD column shows the id alone.
    should(names.size).equal(0);
  });
});

describe('boardLaneNames', () => {
  it('should read every board once and the projects listing once, then name the cards', async () => {
    // Arrange
    const source = new RecordingSource([card({ id: 'F18', laneId: 'todo' })], projects);

    // Act
    const names = await boardLaneNames(source);

    // Assert — one page across every project, `all` so a closed card still names its lane.
    should(source.boardQueries).deepEqual([{ state: 'all', limit: MAX_BOARD_PAGE }]);
    should(source.projectsCalls).equal(1);
    should(names.get('F18')).equal('Todo');
  });
});
