import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { FileProjectCatalog, NodeCatalog } from '../../../src/adapters/catalog/index.ts';
import { sessionView } from '../../unit/runtime/mounts/support.ts';

let root: string | undefined;

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function skill(directory: string, name: string, description: string): Promise<void> {
  await mkdir(join(directory, name), { recursive: true });
  await writeFile(join(directory, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n`, 'utf8');
}

async function git(arguments_: readonly string[]): Promise<void> {
  const process = Bun.spawn(['git', ...arguments_], { stdout: 'pipe', stderr: 'pipe' });
  if ((await process.exited) !== 0) throw new Error(`git ${arguments_[0] ?? 'operation'} failed in fixture`);
}

describe('catalogs', () => {
  it('keeps folder registration deliberate and gives project skills precedence', async () => {
    // Arrange
    root = await mkdtemp(join(tmpdir(), 'ferretry-catalog-'));
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    const project = join(workspace, 'project');
    await mkdir(project, { recursive: true });
    await skill(join(home, '.codex', 'skills'), 'release', 'Global release instructions');
    await skill(join(project, '.agents', 'skills'), 'release', 'Project release instructions');
    await skill(join(project, '.agents', 'skills'), 'review', 'Review this repository');
    const catalog = new NodeCatalog({ home });
    const projects = new FileProjectCatalog(join(root, 'projects.json'), () => '2026-08-04T00:00:00.000Z');
    const session = sessionView('session-1');
    const view = { ...session, config: { ...session.config, cwd: project, harness: 'codex' as const } };

    // Act
    const [before, skills] = await Promise.all([projects.projects(), catalog.skills(view)]);

    // Assert
    should(before).deepEqual([]);
    should(skills).deepEqual({
      harness: 'codex',
      skills: [
        { name: 'release', description: 'Project release instructions', scope: 'project', origin: 'codex' },
        { name: 'review', description: 'Review this repository', scope: 'project', origin: 'codex' },
      ],
    });
    const registered = await projects.register({ kind: 'confirmed-discovery', path: project });
    should(registered).match({ name: 'project', path: project, source: 'confirmed-discovery' });
    should(await projects.projects()).deepEqual([registered]);
  });

  it('creates, clones, deduplicates, and refuses damaged durable records', async () => {
    root = await mkdtemp(join(tmpdir(), 'ferretry-projects-'));
    const registry = join(root, 'state', 'projects.json');
    const projects = new FileProjectCatalog(registry, () => '2026-08-04T00:00:00.000Z');
    const createdPath = join(root, 'created');
    const created = await projects.register({ kind: 'new-folder', path: createdPath, initializeGit: true });
    should(created).match({ source: 'new-folder', path: createdPath });
    should(created.git?.commonDirectory).match(/\.git$/u);

    const duplicate = await projects.register({ kind: 'existing-folder', path: createdPath });
    should(duplicate).deepEqual(created);

    const source = join(root, 'source');
    await git(['init', source]);
    const clonePath = join(root, 'clone');
    const cloned = await projects.register({ kind: 'clone', url: new URL(`file://${source}`).href, path: clonePath });
    should(cloned).match({ source: 'clone', path: clonePath });
    should(cloned.git?.commonDirectory).match(/\.git$/u);
    should(await projects.projects()).have.length(2);

    await should(
      projects.register({ kind: 'clone', url: 'file:///does-not-exist', path: join(root, 'missing') }),
    ).be.rejected();
    await writeFile(registry, '{not json}', 'utf8');
    await should(projects.projects()).be.rejectedWith('the project registry is damaged and cannot be read');
  });
});
