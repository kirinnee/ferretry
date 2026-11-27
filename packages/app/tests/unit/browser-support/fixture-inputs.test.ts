import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { hashFixtureInputs, sceneInputPatterns } from '../../support/browser/fixture-inputs.ts';

/** The visual fixtures' cache key must change when ANY file a scene can read changes, core's integration fixtures included. */
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const workspaceWith = async (files: Readonly<Record<string, string>>): Promise<string> => {
  const workspace = await mkdtemp(join(tmpdir(), 'fy-fixture-inputs-'));
  roots.push(workspace);
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(workspace, path)), { recursive: true });
    await writeFile(join(workspace, path), text, 'utf8');
  }
  return workspace;
};

const keyOf = (workspace: string): Promise<string> => hashFixtureInputs({ workspace, patterns: sceneInputPatterns });

describe('the scene cache key', () => {
  it.each([
    [
      'a core integration fixture (the Start here scene)',
      'packages/core/ferrets/tests/integration/app/fixtures/start-here.ts',
    ],
    ['a plugin integration fixture', 'packages/plugins/projects/tests/integration/app/fixtures/start-here.ts'],
  ])('changes when %s is edited', async (_name, path) => {
    // Arrange
    const workspace = await workspaceWith({ [path]: 'export const before = 1;' });
    const before = await keyOf(workspace);
    // Act
    await writeFile(join(workspace, path), 'export const after = 2;', 'utf8');
    // Assert
    expect(await keyOf(workspace)).not.toBe(before);
  });
});
