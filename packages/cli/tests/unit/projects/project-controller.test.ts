import { describe, it } from 'bun:test';
import type { ProjectInfo, ProjectList, RegisterProjectRequest } from '@ferretry/protocol';
import should from 'should';
import type { IProjectGateway } from '../../../src/lib/projects/ports';
import { ProjectController, renderProjects } from '../../../src/lib/projects/project-controller';

const FERRETRY: ProjectInfo = {
  id: '0b1f6d1e-6c1b-4f0c-8f4e-2f6f2a3c9a10',
  name: 'ferretry',
  path: '/work/ferretry',
  source: 'existing-folder',
  createdAt: '2026-10-30T10:00:00.000Z',
  git: { commonDirectory: '/work/ferretry/.git' },
};

const DOTFILES: ProjectInfo = {
  ...FERRETRY,
  id: '6c0e1f52-8d47-4d6a-9a31-0d2f1b7e4c55',
  name: 'dotfiles',
  path: '/work/dotfiles',
};

/** A registry that dedupes the way the daemon does: the same path answers with the record it has. */
class FakeRegistry implements IProjectGateway {
  readonly registered: RegisterProjectRequest[] = [];

  constructor(private list: ProjectList = []) {}

  projects(): Promise<ProjectList> {
    return Promise.resolve(this.list);
  }

  register(request: RegisterProjectRequest): Promise<ProjectInfo> {
    this.registered.push(request);
    const existing = this.list.find(project => project.path === request.path);
    if (existing !== undefined) return Promise.resolve(existing);
    const created = { ...DOTFILES, path: request.path, name: request.name ?? 'dotfiles' };
    this.list = [...this.list, created];
    return Promise.resolve(created);
  }
}

const harness = (list: ProjectList = []) => {
  const gateway = new FakeRegistry(list);
  const lines: string[] = [];
  const controller = new ProjectController(gateway, { success: line => lines.push(line) }, '/work/dotfiles', 'fy');
  return { controller, gateway, lines };
};

describe('fy project add', () => {
  it("should register `.` as the caller's folder, an absolute path", async () => {
    const { controller, gateway, lines } = harness();
    await controller.add('.', {});
    should(gateway.registered).eql([{ kind: 'existing-folder', path: '/work/dotfiles' }]);
    should(lines[0]).equal(`registered: dotfiles  ${DOTFILES.id}  /work/dotfiles`);
  });

  it('should resolve a relative path against the caller, not the daemon', async () => {
    const { controller, gateway } = harness();
    await controller.add('../notes', { name: 'Notes' });
    should(gateway.registered).eql([{ kind: 'existing-folder', path: '/work/notes', name: 'Notes' }]);
  });

  it('should send an absolute path as it is', async () => {
    const { controller, gateway } = harness();
    await controller.add('/srv/site', {});
    should(gateway.registered[0]?.path).equal('/srv/site');
  });

  it('should print the project already registered for that folder and change nothing', async () => {
    const { controller, lines } = harness([FERRETRY]);
    await controller.add('/work/ferretry', {});
    should(lines[0]).equal(`already registered: ferretry  ${FERRETRY.id}  /work/ferretry`);
  });

  it('should say in JSON whether the project was created', async () => {
    const fresh = harness();
    await fresh.controller.add('.', { json: true });
    should(JSON.parse(fresh.lines[0] ?? '')).have.property('created', true);
    const again = harness([FERRETRY]);
    await again.controller.add('/work/ferretry', { json: true });
    should(JSON.parse(again.lines[0] ?? '')).have.properties({ created: false, project: FERRETRY });
  });

  it('should refuse a blank folder or a blank name before calling the daemon', async () => {
    const { controller, gateway } = harness();
    await should(controller.add('  ', {})).be.rejectedWith(/say which folder: fy project add <path>/u);
    await should(controller.add('.', { name: ' ' })).be.rejectedWith(/--name must not be blank/u);
    should(gateway.registered).be.empty();
  });
});

describe('fy project ls', () => {
  it('should list every project by name, with its id and folder', async () => {
    const { controller, lines } = harness([FERRETRY, DOTFILES]);
    await controller.list({});
    should(lines[0]).equal(
      [`dotfiles  ${DOTFILES.id}  /work/dotfiles`, `ferretry  ${FERRETRY.id}  /work/ferretry`].join('\n'),
    );
  });

  it('should print the registry as JSON on request', async () => {
    const { controller, lines } = harness([FERRETRY]);
    await controller.list({ json: true });
    should(JSON.parse(lines[0] ?? '')).eql([FERRETRY]);
  });

  it('should say how to add one when there are none', () => {
    should(renderProjects([], 'fy')).equal('no projects yet; register one with: fy project add <path>');
  });
});
