import { describe, it } from 'bun:test';
import should from 'should';
import type { ProjectInfo, ProjectList, RegisterProjectRequest } from '../../../contract/index.ts';
import { type ProjectGateway, ProjectController, renderProjects } from '../../../cli/lib/project-controller.ts';

const FERRETRY: ProjectInfo = {
  id: '0b1f6d1e-6c1b-4f0c-8f4e-2f6f2a3c9a10' as ProjectInfo['id'],
  name: 'ferretry',
  path: '/work/ferretry',
  source: 'existing-folder',
  createdAt: '2026-10-30T10:00:00.000Z' as ProjectInfo['createdAt'],
  git: { commonDirectory: '/work/ferretry/.git' },
};

const DOTFILES: ProjectInfo = {
  ...FERRETRY,
  id: '6c0e1f52-8d47-4d6a-9a31-0d2f1b7e4c55' as ProjectInfo['id'],
  name: 'dotfiles',
  path: '/work/dotfiles',
};

/** A registry that dedupes the way the daemon does: the same path answers with the record it has. */
class FakeRegistry implements ProjectGateway {
  readonly registered: RegisterProjectRequest[] = [];
  readonly removed: string[] = [];

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

  remove(id: string): Promise<ProjectInfo> {
    this.removed.push(id);
    const found = this.list.find(project => project.id === id);
    if (found === undefined) return Promise.reject(new Error('not found'));
    this.list = this.list.filter(project => project.id !== id);
    return Promise.resolve(found);
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

describe('fy project list', () => {
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

describe('fy project remove', () => {
  it('should forget a project named by id, by name in any case, or by folder, and leave the folder alone', async () => {
    for (const typed of [FERRETRY.id, 'FerreTry', '/work/ferretry']) {
      const { controller, gateway, lines } = harness([FERRETRY, DOTFILES]);
      await controller.remove(typed, {});
      should(gateway.removed).eql([FERRETRY.id]);
      should(lines[0]).equal(`removed: ferretry  ${FERRETRY.id}  /work/ferretry (the folder itself is left alone)`);
    }
  });

  it('should resolve `.` against the caller’s folder', async () => {
    const { controller, gateway } = harness([DOTFILES]);
    await controller.remove('.', {});
    should(gateway.removed).eql([DOTFILES.id]);
  });

  it('should print the removed record as JSON on request', async () => {
    const { controller, lines } = harness([FERRETRY]);
    await controller.remove('ferretry', { json: true });
    should(JSON.parse(lines[0] ?? '')).eql({ project: FERRETRY });
  });

  it('should refuse an unknown project or a blank one without calling the daemon', async () => {
    const { controller, gateway } = harness([FERRETRY]);
    await should(controller.remove('ghost', {})).be.rejectedWith(/no project "ghost"; see `fy project list`/u);
    await should(controller.remove(' ', {})).be.rejectedWith(/say which project: fy project remove/u);
    should(gateway.removed).be.empty();
  });
});
