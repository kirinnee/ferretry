import { afterEach, describe, it, spyOn } from 'bun:test';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import should from 'should';
import { FileFleetProvisioner } from '../../src/adapters/file-provisioner.ts';
import { STAGE_PREFIX } from '../../src/adapters/mutation-journal.ts';
import type { FleetManifest } from '../../src/lib/manifest.ts';
import type { FleetApplyPlan, FleetWriteOperation } from '../../src/lib/provisioning.ts';

/**
 * The component-source fence at the provisioner (docs/secrets.md#what-the-state-home-fence-refuses): no copy
 * or link takes its source from inside the daemon's state home — named there, reached through a link, or
 * inside a folder that holds the home — except the fleet's asset tree, and a source anywhere else still
 * provisions exactly as before.
 */

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function temporary(): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'fy-source-fence-')));
  directories.push(directory);
  return directory;
}

const manifest: FleetManifest = { version: 1, generatedAt: '2027-01-15T08:00:00.000Z', accounts: [] };

/** A state home with its secrets, its asset tree, a runtime home to provision into, and a place outside it. */
async function world() {
  const machine = await temporary();
  const home = path.join(machine, '.ferretry');
  const assets = path.join(home, 'fleet', 'assets');
  const runtime = path.join(home, 'fleet', 'homes', 'claude-one');
  const outside = path.join(machine, 'notes');
  // A stand-in for the Nix store — owned by this user, so never proven immutable.
  const store = path.join(machine, 'store');
  await mkdir(store);
  await mkdir(path.join(home, 'state'), { recursive: true });
  await mkdir(path.join(home, 'config'), { recursive: true });
  await mkdir(assets, { recursive: true });
  await mkdir(runtime, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(home, 'api-token'), 'fy_admin_secret\n');
  await writeFile(path.join(home, 'state', 'secrets.key'), 'vault-key\n');
  await writeFile(path.join(outside, 'CLAUDE.md'), 'Outside guidance.\n');
  await writeFile(path.join(assets, 'shared.md'), 'Shared guidance.\n');
  const subject = new FileFleetProvisioner(
    [home],
    undefined,
    {},
    {
      homes: [home, path.join(home, 'state'), path.join(home, 'config')],
      open: [assets],
      hardLinkRoots: [store],
    },
  );
  const apply = async (operation: FleetWriteOperation) => {
    const plan: FleetApplyPlan = {
      manifest,
      manifestPath: path.join(home, 'fleet', 'manifest.json'),
      operations: [operation],
    };
    return await subject.apply(plan);
  };
  return { machine, home, assets, runtime, outside, store, apply };
}

const refusal = async (attempt: Promise<unknown>): Promise<string> => {
  try {
    await attempt;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('the apply was not refused');
};

describe('the provisioner component-source fence', () => {
  it('should refuse a copy whose source is a file inside the state home, and write nothing', async () => {
    // Arrange
    const { home, runtime, apply } = await world();
    const target = path.join(runtime, 'CLAUDE.md');

    // Act
    const message = await refusal(apply({ kind: 'copy', source: path.join(home, 'api-token'), path: target }));

    // Assert
    should(message).match(/inside this daemon's state home/u);
    should(message).not.match(/fy_admin_secret/u);
    await should(stat(target)).be.rejected();
  });

  it('should refuse a source that is a link from outside into the state home', async () => {
    // Arrange
    const { home, outside, runtime, apply } = await world();
    await symlink(path.join(home, 'api-token'), path.join(outside, 'innocent.md'));

    // Act
    const message = await refusal(
      apply({ kind: 'copy', source: path.join(outside, 'innocent.md'), path: path.join(runtime, 'CLAUDE.md') }),
    );

    // Assert
    should(message).match(/inside this daemon's state home/u);
  });

  it('should refuse a source whose link chain passes through the state home, even when it ends outside', async () => {
    // Arrange: outside → a link inside the home → back outside. The hop in the home is the home's own link.
    const { home, outside, runtime, apply } = await world();
    await symlink(path.join(outside, 'CLAUDE.md'), path.join(home, 'state', 'auth.json'));
    await symlink(path.join(home, 'state', 'auth.json'), path.join(outside, 'hop.md'));

    // Act
    const message = await refusal(
      apply({ kind: 'copy', source: path.join(outside, 'hop.md'), path: path.join(runtime, 'CLAUDE.md') }),
    );

    // Assert
    should(message).match(/inside this daemon's state home/u);
  });

  it("should refuse a source that climbs into the state home with '..' from the asset tree", async () => {
    // Arrange
    const { assets, runtime, apply } = await world();

    // Act
    const message = await refusal(
      apply({ kind: 'copy', source: `${assets}/../../api-token`, path: path.join(runtime, 'CLAUDE.md') }),
    );

    // Assert
    should(message).match(/inside this daemon's state home/u);
  });

  it('should refuse a directory that holds the state home, and one holding a link into it', async () => {
    // Arrange
    const { machine, home, outside, runtime, apply } = await world();
    const skills = path.join(outside, 'skills');
    await mkdir(skills);
    await writeFile(path.join(skills, 'SKILL.md'), 'A skill.\n');
    await symlink(path.join(home, 'state', 'secrets.key'), path.join(skills, 'notes.md'));

    // Act
    const wholeMachine = await refusal(apply({ kind: 'copy', source: machine, path: path.join(runtime, 'all') }));
    const linkedIn = await refusal(apply({ kind: 'copy', source: skills, path: path.join(runtime, 'skills') }));

    // Assert
    should(wholeMachine).match(/inside this daemon's state home/u);
    should(linkedIn).match(/inside this daemon's state home/u);
    await should(stat(path.join(runtime, 'skills'))).be.rejected();
  });

  it('should refuse a link whose source is inside the state home, and leave no link behind', async () => {
    // Arrange
    const { home, runtime, apply } = await world();
    const target = path.join(runtime, 'CLAUDE.md');

    // Act
    const message = await refusal(apply({ kind: 'symlink', source: path.join(home, 'api-token'), path: target }));

    // Assert
    should(message).match(/inside this daemon's state home/u);
    await should(readlink(target)).be.rejected();
  });

  it("should still link and copy from the fleet's asset tree, which is inside the state home", async () => {
    // Arrange
    const { assets, runtime, apply } = await world();

    // Act
    await apply({ kind: 'symlink', source: path.join(assets, 'shared.md'), path: path.join(runtime, 'CLAUDE.md') });
    await apply({ kind: 'copy', source: path.join(assets, 'shared.md'), path: path.join(runtime, 'AGENTS.md') });

    // Assert
    should(await readFile(path.join(runtime, 'CLAUDE.md'), 'utf8')).eql('Shared guidance.\n');
    should(await readFile(path.join(runtime, 'AGENTS.md'), 'utf8')).eql('Shared guidance.\n');
  });

  it('should refuse an asset that is itself a link into the rest of the state home', async () => {
    // Arrange
    const { home, assets, runtime, apply } = await world();
    await symlink(path.join(home, 'api-token'), path.join(assets, 'token.md'));

    // Act
    const message = await refusal(
      apply({ kind: 'copy', source: path.join(assets, 'token.md'), path: path.join(runtime, 'CLAUDE.md') }),
    );

    // Assert
    should(message).match(/inside this daemon's state home/u);
  });

  it('should copy an ordinary source outside the home, and a folder with its links followed', async () => {
    // Arrange
    const { outside, runtime, apply } = await world();
    const hooks = path.join(outside, 'hooks');
    await mkdir(path.join(hooks, 'lib'), { recursive: true });
    await writeFile(path.join(hooks, 'run.sh'), '#!/bin/sh\necho hi\n', { mode: 0o755 });
    await symlink(path.join(outside, 'CLAUDE.md'), path.join(hooks, 'lib', 'guidance.md'));

    // Act
    await apply({ kind: 'copy', source: path.join(outside, 'CLAUDE.md'), path: path.join(runtime, 'CLAUDE.md') });
    await apply({ kind: 'copy', source: hooks, path: path.join(runtime, 'hooks') });

    // Assert
    should(await readFile(path.join(runtime, 'CLAUDE.md'), 'utf8')).eql('Outside guidance.\n');
    should(await readFile(path.join(runtime, 'hooks', 'lib', 'guidance.md'), 'utf8')).eql('Outside guidance.\n');
    should((await stat(path.join(runtime, 'hooks', 'run.sh'))).mode & 0o111).not.eql(0);
  });

  it('should copy a read-only folder of read-only files, as a skill linked out of the Nix store is', async () => {
    // Arrange: the store's folders are 0555 and its files 0444, so the copy must still write into its own folder.
    const { store, runtime, apply } = await world();
    const skill = path.join(store, 'skill');
    await mkdir(skill);
    await writeFile(path.join(skill, 'SKILL.md'), 'A skill.\n', { mode: 0o444 });
    await writeFile(path.join(skill, 'run.sh'), '#!/bin/sh\n', { mode: 0o555 });
    await chmod(skill, 0o555);

    try {
      // Act
      await apply({ kind: 'copy', source: skill, path: path.join(runtime, 'skill') });

      // Assert
      should(await readFile(path.join(runtime, 'skill', 'SKILL.md'), 'utf8')).eql('A skill.\n');
      should((await stat(path.join(runtime, 'skill', 'run.sh'))).mode & 0o111).not.eql(0);
    } finally {
      await chmod(skill, 0o755);
    }
  });

  it('should refuse a hard link outside the store, which could be another name of the admin token', async () => {
    // Arrange: a second name for the token, in an ordinary folder.
    const { home, outside, runtime, apply } = await world();
    await link(path.join(home, 'api-token'), path.join(outside, 'twin.md'));

    // Act
    const message = await refusal(
      apply({ kind: 'copy', source: path.join(outside, 'twin.md'), path: path.join(runtime, 'CLAUDE.md') }),
    );

    // Assert
    should(message).match(/is a hard link/u);
    should(message).not.match(/fy_admin_secret/u);
    await should(stat(path.join(runtime, 'CLAUDE.md'))).be.rejected();
  });

  it('should refuse a hard link in a store this user owns, which proves nothing about its other names', async () => {
    // Arrange: the stand-in store is the test's own folder, so it fails the immutability proof (a multi-user Nix
    // store passes it; tests/unit/fenced-source.test.ts proves that side on a fake disk).
    const { store, runtime, apply } = await world();
    await writeFile(path.join(store, 'skill.md'), 'Store guidance.\n');
    await link(path.join(store, 'skill.md'), path.join(store, 'same-skill.md'));

    // Act
    const message = await refusal(
      apply({ kind: 'copy', source: path.join(store, 'skill.md'), path: path.join(runtime, 'CLAUDE.md') }),
    );

    // Assert
    should(message).match(/is a hard link/u);
  });
});

describe('secrev-1260 L3 — the staged copy before it is published', () => {
  const swapForTokenLink = async (staged: string, token: string): Promise<void> => {
    await rm(staged, { force: true });
    await symlink(token, staged);
  };

  it('should set the staged copy’s mode through a no-follow descriptor, so a link swapped in changes no token', async () => {
    // Arrange: the moment the provisioner opens the staged copy to set its mode, the harness has swapped it for a
    // link to the admin token (it can write the account's folder the copy is staged in).
    const { home, outside, runtime, apply } = await world();
    const token = path.join(home, 'api-token');
    const tokenMode = (await stat(token)).mode & 0o777;
    const real = fs.open;
    const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    const openSpy = spyOn(fs, 'open').mockImplementation((async (target: string, mode: number, ...rest: unknown[]) => {
      if (mode === flags && path.basename(String(target)).startsWith(STAGE_PREFIX))
        await swapForTokenLink(String(target), token);
      return await (real as (...args: unknown[]) => Promise<unknown>)(target, mode, ...rest);
    }) as unknown as typeof fs.open);

    try {
      // Act
      const failed = await refusal(
        apply({ kind: 'copy', source: path.join(outside, 'CLAUDE.md'), path: path.join(runtime, 'CLAUDE.md') }),
      );

      // Assert
      should(failed).match(/ELOOP|symbolic link/u);
      should((await stat(token)).mode & 0o777).equal(tokenMode);
      await should(readlink(path.join(runtime, 'CLAUDE.md'))).be.rejected();
    } finally {
      openSpy.mockRestore();
    }
  });

  it('should refuse to publish a staged entry that is not a regular file, as a link swapped in after the copy is', async () => {
    // Arrange: the staged copy is swapped for a link to the token just before the publish looks at it.
    const { home, outside, runtime, apply } = await world();
    const token = path.join(home, 'api-token');
    const real = fs.lstat;
    let swapped = false;
    const lstatSpy = spyOn(fs, 'lstat').mockImplementation((async (target: string, ...rest: unknown[]) => {
      if (!swapped && path.basename(String(target)).startsWith(STAGE_PREFIX)) {
        swapped = true;
        await swapForTokenLink(String(target), token);
      }
      return await (real as (...args: unknown[]) => Promise<unknown>)(target, ...rest);
    }) as unknown as typeof fs.lstat);

    try {
      // Act
      const failed = await refusal(
        apply({ kind: 'copy', source: path.join(outside, 'CLAUDE.md'), path: path.join(runtime, 'CLAUDE.md') }),
      );

      // Assert: nothing published under the account's name, and the token untouched.
      should(swapped).be.true();
      should(failed).match(/not a regular file/u);
      await should(readlink(path.join(runtime, 'CLAUDE.md'))).be.rejected();
      await should(stat(path.join(runtime, 'CLAUDE.md'))).be.rejected();
      should(await readFile(token, 'utf8')).eql('fy_admin_secret\n');
    } finally {
      lstatSpy.mockRestore();
    }
  });
});
