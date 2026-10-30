import { describe, it } from 'bun:test';
import { boardErr, boardOk, type BoardProject, type LaneSetActionRequest } from '@ferretry/protocol';
import should from 'should';
import { type ImportLaneSets, LaneSetImportProjects } from '../../../src/lib/board-import/index.ts';
import type { ProjectGitFactSource } from '../../../src/lib/board-projects/index.ts';
import { lanes, PROJECT } from '../board/support.ts';

const project = (path: string | null): BoardProject => ({ id: PROJECT, name: 'p', path, laneSet: null });

class FakeLanes implements ImportLaneSets {
  readonly applied: { request: LaneSetActionRequest; actor: unknown }[] = [];
  constructor(
    private readonly found: BoardProject | undefined,
    private readonly outcome: 'ok' | 'refused' = 'ok',
  ) {}
  async projectOf() {
    return PROJECT;
  }
  async laneSet() {
    return null;
  }
  async project() {
    return this.found;
  }
  async apply(_id: string, request: LaneSetActionRequest, actor: unknown) {
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

describe('LaneSetImportProjects', () => {
  it('should delegate the project and lane set questions', async () => {
    // Arrange
    const projects = new LaneSetImportProjects(new FakeLanes(project('/repo')), new FakeFacts());

    // Act
    const id = await projects.projectOf('lead');
    const laneSet = await projects.laneSet(PROJECT);

    // Assert
    should(id).equal(PROJECT);
    should(laneSet).be.null();
  });

  it('should propose the template the folder suggests, unconfirmed, as the session', async () => {
    // Arrange
    const fake = new FakeLanes(project('/repo'));
    const facts = new FakeFacts({ hasRepository: true, hasReleaseTags: true });

    // Act
    const proposed = await new LaneSetImportProjects(fake, facts).propose(PROJECT, 'lead');

    // Assert
    should(proposed?.projectId).equal(PROJECT);
    should(facts.inspected).eql(['/repo']);
    should(fake.applied).eql([
      {
        request: { action: 'propose', template: 'pr-release-verify', renames: {} },
        actor: { kind: 'ferret', name: 'lead', sessionId: 'lead' },
      },
    ]);
  });

  it('should propose the quick lanes for a project with no folder, without looking at git', async () => {
    // Arrange
    const fake = new FakeLanes(project(null));
    const facts = new FakeFacts();

    // Act
    await new LaneSetImportProjects(fake, facts).propose(PROJECT, 'lead');

    // Assert
    should(facts.inspected).eql([]);
    should(fake.applied[0]?.request).match({ template: 'quick' });
  });

  it('should answer null for a project that is not there', async () => {
    // Act
    const proposed = await new LaneSetImportProjects(new FakeLanes(undefined), new FakeFacts()).propose(
      PROJECT,
      'lead',
    );

    // Assert
    should(proposed).be.null();
  });

  it('should answer null when the proposal is refused', async () => {
    // Act
    const proposed = await new LaneSetImportProjects(
      new FakeLanes(project('/repo'), 'refused'),
      new FakeFacts(),
    ).propose(PROJECT, 'lead');

    // Assert
    should(proposed).be.null();
  });
});
