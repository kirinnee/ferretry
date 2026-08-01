import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'bun:test';
import should from 'should';
import { NodeCatalog } from '../../../src/adapters/catalog/node-catalog.ts';
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

describe('NodeCatalog', () => {
  it('should scan one configured project level and give project skills precedence', async () => {
    // Arrange
    root = await mkdtemp(join(tmpdir(), 'ferretry-catalog-'));
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    const project = join(workspace, 'project');
    await mkdir(join(project, '.git'), { recursive: true });
    await writeFile(join(project, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    await skill(join(home, '.codex', 'skills'), 'release', 'Global release instructions');
    await skill(join(project, '.agents', 'skills'), 'release', 'Project release instructions');
    await skill(join(project, '.agents', 'skills'), 'review', 'Review this repository');
    const catalog = new NodeCatalog({ home, projectRoots: [workspace] });
    const session = sessionView('session-1');
    const view = { ...session, config: { ...session.config, cwd: project, harness: 'codex' as const } };

    // Act
    const [projects, skills] = await Promise.all([catalog.projects(), catalog.skills(view)]);

    // Assert
    should(projects).have.length(1);
    should(projects[0]).match({ name: 'project', path: project });
    should(projects[0]?.lastActivity).match(/^\d{4}-\d{2}-\d{2}T/u);
    should(skills).deepEqual({
      harness: 'codex',
      skills: [
        { name: 'release', description: 'Project release instructions', scope: 'project', origin: 'codex' },
        { name: 'review', description: 'Review this repository', scope: 'project', origin: 'codex' },
      ],
    });
  });
});
