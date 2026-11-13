import { afterAll, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nodeExecutableProbe } from '../../../host/adapters/executable.ts';

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

describe('the disk’s answer for which', () => {
  test('a regular file with its execute bit is runnable, whether named directly or through a link', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fy-which-'));
    roots.push(root);
    await writeFile(join(root, 'tool'), '#!/bin/sh\n');
    await chmod(join(root, 'tool'), 0o755);
    await symlink(join(root, 'tool'), join(root, 'alias'));

    expect(await nodeExecutableProbe(join(root, 'tool'))).toBe(true);
    expect(await nodeExecutableProbe(join(root, 'alias'))).toBe(true);
  });

  test('a file without the execute bit, a directory, and a missing name are not runnable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fy-which-'));
    roots.push(root);
    await writeFile(join(root, 'notes'), 'text');
    await chmod(join(root, 'notes'), 0o644);
    await mkdir(join(root, 'folder'), { mode: 0o755 });

    expect(await nodeExecutableProbe(join(root, 'notes'))).toBe(false);
    expect(await nodeExecutableProbe(join(root, 'folder'))).toBe(false);
    expect(await nodeExecutableProbe(join(root, 'missing'))).toBe(false);
  });
});
