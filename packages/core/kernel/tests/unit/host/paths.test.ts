import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { nodeFs } from '../../../host/adapters/node-fs.ts';
import { checkDirectory } from '../../../host/paths.ts';

/** `kernel.paths.checkDirectory`: today's session working-directory resolver, rule for rule and sentence for sentence. */

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});
const disk = nodeFs(() => 'r');
const folder = async (): Promise<string> => {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-paths-`));
  parents.push(parent);
  return parent;
};

describe('checkDirectory', () => {
  test('answers the real path of a directory', async () => {
    const parent = await folder();
    await mkdir(`${parent}/work`);

    expect(await checkDirectory(disk, `${parent}/work`)).toEqual({ ok: true, value: { realPath: `${parent}/work` } });
  });

  test('resolves a link and trims what the client typed', async () => {
    const parent = await folder();
    await mkdir(`${parent}/work`);
    await symlink(`${parent}/work`, `${parent}/alias`);

    expect(await checkDirectory(disk, `  ${parent}/alias  `)).toEqual({
      ok: true,
      value: { realPath: `${parent}/work` },
    });
  });

  test('refuses a relative path rather than resolving it against the daemon', async () => {
    expect(await checkDirectory(disk, 'work')).toEqual({
      ok: false,
      error: { reason: 'not_absolute', message: 'session working directory must be absolute: "work"' },
    });
  });

  test('refuses a path that does not exist, here, where the client still sees it', async () => {
    const parent = await folder();

    expect(await checkDirectory(disk, `${parent}/missing`)).toEqual({
      ok: false,
      error: { reason: 'not_a_directory', message: `session working directory is not a directory: ${parent}/missing` },
    });
  });

  test('refuses a file, and a link to a file', async () => {
    const parent = await folder();
    await writeFile(`${parent}/file`, 'x');
    await symlink(`${parent}/file`, `${parent}/alias`);

    for (const path of [`${parent}/file`, `${parent}/alias`])
      expect(await checkDirectory(disk, path)).toEqual({
        ok: false,
        error: { reason: 'not_a_directory', message: `session working directory is not a directory: ${path}` },
      });
  });

  test('creates nothing', async () => {
    const parent = await folder();
    await checkDirectory(disk, `${parent}/new/deeper`);

    expect(await Bun.file(`${parent}/new`).exists()).toBe(false);
  });
});
