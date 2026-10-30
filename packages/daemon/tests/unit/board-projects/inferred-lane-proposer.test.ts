import { describe, it } from 'bun:test';
import { boardErr, boardOk, type BoardProject, type LaneSetActionRequest } from '@ferretry/protocol';
import should from 'should';
import {
  InferredLaneProposer,
  type LaneActor,
  type ProjectGitFactSource,
  type ProposalLaneSets,
} from '../../../src/lib/board-projects/index.ts';
import { lanes, PROJECT } from '../board/support.ts';

const project = (path: string | null): BoardProject => ({ id: PROJECT, name: 'p', path, laneSet: null });

class FakeLanes implements ProposalLaneSets {
  readonly applied: { request: LaneSetActionRequest; actor: LaneActor }[] = [];
  constructor(
    private readonly found: BoardProject | undefined,
    private readonly outcome: 'ok' | 'refused' = 'ok',
  ) {}
  async project() {
    return this.found;
  }
  async apply(_id: string, request: LaneSetActionRequest, actor: LaneActor) {
    this.applied.push({ request, actor });
    return this.outcome === 'ok'
      ? boardOk({ laneSet: lanes(PROJECT, 'pr'), agenda: 'raised' as const })
      : boardErr({ code: 'not-found' as const, projectId: PROJECT });
  }
}

class FakeFacts implements ProjectGitFactSource {
  readonly inspected: string[] = [];
  constructor(private readonly facts = { hasRepository: true, hasReleaseTags: false }) {}
  async inspect(path: string) {
    this.inspected.push(path);
    return this.facts;
  }
}

describe('InferredLaneProposer', () => {
  it.each([
    ['a repository with release tags', { hasRepository: true, hasReleaseTags: true }, 'pr-release-verify'],
    ['a repository without release tags', { hasRepository: true, hasReleaseTags: false }, 'pr'],
    ['a folder with no repository', { hasRepository: false, hasReleaseTags: false }, 'quick'],
  ] as const)('should propose the %s template, unconfirmed, as the session', async (_name, found, template) => {
    // Arrange
    const fake = new FakeLanes(project('/repo'));
    const facts = new FakeFacts(found);

    // Act
    const proposed = await new InferredLaneProposer(fake, facts).propose(PROJECT, 'lead');

    // Assert
    should(proposed?.projectId).equal(PROJECT);
    should(facts.inspected).eql(['/repo']);
    should(fake.applied).eql([
      {
        request: { action: 'propose', template, renames: {} },
        actor: { kind: 'ferret', name: 'lead', sessionId: 'lead' },
      },
    ]);
  });

  it('should propose the quick lanes for a project with no folder, without looking at git', async () => {
    // Arrange
    const fake = new FakeLanes(project(null));
    const facts = new FakeFacts();

    // Act
    await new InferredLaneProposer(fake, facts).propose(PROJECT, 'lead');

    // Assert
    should(facts.inspected).eql([]);
    should(fake.applied[0]?.request).match({ template: 'quick' });
  });

  it('should answer null for a project that is not there, proposing nothing', async () => {
    // Arrange
    const fake = new FakeLanes(undefined);

    // Act
    const proposed = await new InferredLaneProposer(fake, new FakeFacts()).propose(PROJECT, 'lead');

    // Assert
    should(proposed).be.null();
    should(fake.applied).eql([]);
  });

  it('should answer null when the proposal is refused', async () => {
    // Act
    const proposed = await new InferredLaneProposer(
      new FakeLanes(project('/repo'), 'refused'),
      new FakeFacts(),
    ).propose(PROJECT, 'lead');

    // Assert
    should(proposed).be.null();
  });
});
