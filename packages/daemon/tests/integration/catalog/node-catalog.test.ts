import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'bun:test';
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
});
