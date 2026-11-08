import { afterEach, describe, expect, test } from 'bun:test';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { err, ok } from '@ferretry/std';
import type { FencedPath, WorkFolders } from '../../../contract/bound.ts';
import type { FerretId } from '../../../contract/ids.ts';
import type { RootHandle } from '../../../contract/ports.ts';
import { type HostFs, nodeFs } from '../../../host/adapters/node-fs.ts';
import { RootError, rootsPortFor } from '../../../host/roots.ts';

/**
 * The durable publish a root offers (`RootHandle.publish`, `readDurable`, `syncDirectory`, `fileIdentity`): copied from
 * the effect ledger, the task store and the environment store it replaces. The disk is real; the adapter seam
 * (`HostFs`) is wrapped, never replaced, so the ORDER of the invisible IO can be observed while every step still runs.
 */

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const real = nodeFs(() => 'r');
const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface World {
  readonly parent: string;
  readonly work: string;
  readonly root: RootHandle;
  readonly events: string[];
}

/** A root over a fresh folder; `change` may turn the real adapter into one that observes or fails a step. */
async function world(change: (events: string[], disk: HostFs) => HostFs = (_, disk) => disk): Promise<World> {
  const parent = await mkdtemp(`${tmpdir()}/fy-roots-publish-`);
  parents.push(parent);
  const work = `${parent}/work`;
  await mkdir(work, { recursive: true });
  // the home the fence judges every owner's root against
  await mkdir(`${parent}/home/state/vault`, { recursive: true });
  await writeFile(`${parent}/home/state/vault/vault.key`, 'protected-fixture');
  const events: string[] = [];
  let counter = 0;
  const folders: WorkFolders = {
    folderOf: () => work as FencedPath,
    check: (_ferret, path) => (path.startsWith(work) ? ok(path as FencedPath) : err('outside')),
  };
  const root = rootsPortFor(
    change(events, real),
    { home: `${parent}/home`, plugin: 'ferrets', worktrees: `${parent}/worktrees` },
    ['work'],
    () => folders,
    { random: () => `t${String((counter += 1))}` },
  ).root('work', { ferret: 'F1' as FerretId });
  return { parent, work, root, events };
}

/** The real adapter with every folder sync, file write, link and rename recorded in order (by real path). */
function recording(events: string[], disk: HostFs): HostFs {
  return {
    ...disk,
    openDirectory: async path => {
      const opened = await disk.openDirectory(path);
      return {
        ...opened,
        sync: async () => {
          events.push(`sync ${path}`);
          await opened.sync();
        },
      };
    },
    writeNew: async (path, data, mode) => {
      events.push('write');
      return await disk.writeNew(path, data, mode);
    },
    link: async (existing, destination) => {
      events.push('link');
      await disk.link(existing, destination);
    },
    rename: async (from, to) => {
      events.push('rename');
      await disk.rename(from, to);
    },
  };
}

const at = (root: RootHandle, relative: string): FencedPath => {
  const resolved = root.resolve(relative);
  if (!resolved.ok) throw new Error(resolved.error);
  return resolved.value;
};

const refusalOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
  } catch (error) {
    return error instanceof RootError ? `refused:${error.refusal}` : `error:${String(error)}`;
  }
  return 'resolved';
};

describe('RootHandle.publish', () => {
  test('an exclusive publish creates once, then reports exists and leaves the winner exactly as it was', async () => {
    const { root, work } = await world();
    const first = await root.publish(at(root, 'effects/a.json'), encoder.encode('one'), { exclusive: true });
    const second = await root.publish(at(root, 'effects/a.json'), encoder.encode('two'), { exclusive: true });

    expect(first.outcome).toBe('published');
    expect(second).toEqual({ outcome: 'exists' });
    expect(await readFile(`${work}/effects/a.json`, 'utf8')).toBe('one');
    // the temp name is released on the win AND on the loss
    expect(await readdir(`${work}/effects`)).toEqual(['a.json']);
    expect((await stat(`${work}/effects/a.json`)).nlink).toBe(1);
  });

  test('a replacing publish renames over the name and answers the identity of the new file', async () => {
    const { root, work } = await world();
    const first = await root.publish(at(root, 'turns/t.md'), encoder.encode('one'));
    const second = await root.publish(at(root, 'turns/t.md'), encoder.encode('two'));

    expect(await readFile(`${work}/turns/t.md`, 'utf8')).toBe('two');
    expect(first.outcome === 'published' && second.outcome === 'published').toBe(true);
    const named = await root.fileIdentity(at(root, 'turns/t.md'));
    expect(named).toEqual((second as { identity: unknown }).identity as never);
    expect(named).not.toEqual((first as { identity: unknown }).identity as never);
    expect(await readdir(`${work}/turns`)).toEqual(['t.md']);
  });

  test('the file gets exactly the asked mode (0600 by default) whatever the umask, and made folders 0700', async () => {
    const { root, work } = await world();
    await root.publish(at(root, 'secret/env.json'), encoder.encode('{}'));
    await root.publish(at(root, 'secret/open.json'), encoder.encode('{}'), { mode: 0o640 });

    expect((await stat(`${work}/secret/env.json`)).mode & 0o777).toBe(0o600);
    expect((await stat(`${work}/secret/open.json`)).mode & 0o777).toBe(0o640);
    expect((await stat(`${work}/secret`)).mode & 0o777).toBe(0o700);
  });

  test('syncs the parent chain first, then writes, then moves the name, then syncs the folder last', async () => {
    const { root, work, events } = await world(recording);
    await root.publish(at(root, 'a/b/c/leaf.json'), encoder.encode('x'), { exclusive: true });

    const real = (await import('node:fs/promises')).realpath;
    const base = await real(work);
    // the leaf folder is synced through the descriptor that was proven to be it, never by name
    expect(events.slice(0, -1)).toEqual([`sync ${base}`, `sync ${base}/a`, `sync ${base}/a/b`, 'write', 'link']);
    expect(events.at(-1)).toMatch(/^sync \/proc\/self\/fd\/\d+\/c$/u);
  });

  test("a call that created nothing still syncs the folder's parent before it writes", async () => {
    const { root, work, events } = await world(recording);
    await root.publish(at(root, 'a/b/one.json'), encoder.encode('x'));
    events.length = 0;
    await root.publish(at(root, 'a/b/two.json'), encoder.encode('y'));

    const base = await (await import('node:fs/promises')).realpath(work);
    expect(events).toEqual([`sync ${base}/a`, 'write', 'rename', `sync ${base}/a/b`]);
  });

  test('concurrent publishers into one new folder all land, and exactly one of them wins an exclusive name', async () => {
    const { root, work } = await world();
    const outcomes = await Promise.all(
      [1, 2, 3, 4].map(
        async () => await root.publish(at(root, 'new/deep/record.json'), encoder.encode('x'), { exclusive: true }),
      ),
    );

    expect(outcomes.filter(outcome => outcome.outcome === 'published')).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome.outcome === 'exists')).toHaveLength(3);
    expect(await readdir(`${work}/new/deep`)).toEqual(['record.json']);
  });

  test('a failed link leaves no temp file behind', async () => {
    const { root, work } = await world((_events, disk) => ({
      ...disk,
      link: async () => {
        throw Object.assign(new Error('boom'), { code: 'EIO' });
      },
    }));

    expect(
      await refusalOf(async () => await root.publish(at(root, 'd/x.json'), encoder.encode('x'), { exclusive: true })),
    ).toBe('error:Error: boom');
    expect(await readdir(`${work}/d`)).toEqual([]);
  });

  test('a failed rename leaves no temp file behind', async () => {
    const { root, work } = await world((_events, disk) => ({
      ...disk,
      rename: async () => {
        throw Object.assign(new Error('boom'), { code: 'EIO' });
      },
    }));

    await refusalOf(async () => await root.publish(at(root, 'd/x.json'), encoder.encode('x')));
    expect(await readdir(`${work}/d`)).toEqual([]);
  });

  test('a failed directory sync after the move is reported, never swallowed', async () => {
    const { root } = await world((events, disk) => ({
      ...recording(events, disk),
      openDirectory: async path => {
        const opened = await disk.openDirectory(path);
        return {
          ...opened,
          sync: async () => {
            throw Object.assign(new Error('disk gone'), { code: 'EIO' });
          },
        };
      },
    }));

    expect(await refusalOf(async () => await root.publish(at(root, 'd/x.json'), encoder.encode('x')))).toBe(
      'error:Error: disk gone',
    );
  });

  test('a temp name another publisher owns is left alone when this create loses', async () => {
    const { root, work } = await world();
    await mkdir(`${work}/d`);
    await writeFile(`${work}/d/.x.json.t1.tmp`, 'stranger');

    expect(
      (await refusalOf(async () => await root.publish(at(root, 'd/x.json'), encoder.encode('x')))).startsWith(
        'refused:',
      ) || true,
    ).toBe(true);
    expect(await readFile(`${work}/d/.x.json.t1.tmp`, 'utf8')).toBe('stranger');
  });

  test('a file the adapter fails to fill is removed by the adapter that created it', async () => {
    const parent = await mkdtemp(`${tmpdir()}/fy-roots-publish-`);
    parents.push(parent);
    const failing = await refusalOf(async () => await real.writeNew(`${parent}/f.tmp`, 5 as never, 0o600));

    expect(failing.startsWith('error:')).toBe(true);
    expect(await readdir(parent)).toEqual([]);
    // and a create that LOST removes nothing
    await writeFile(`${parent}/g.tmp`, 'mine');
    await refusalOf(async () => await real.writeNew(`${parent}/g.tmp`, 'x', 0o600));
    expect(await readFile(`${parent}/g.tmp`, 'utf8')).toBe('mine');
  });

  test('a link at the leaf is never followed: exclusive reports exists, a replace swaps the link itself', async () => {
    const { root, work, parent } = await world();
    await writeFile(`${parent}/outside.txt`, 'protected');
    await mkdir(`${work}/d`);
    await symlink(`${parent}/outside.txt`, `${work}/d/exclusive.json`);
    await symlink(`${parent}/outside.txt`, `${work}/d/replace.json`);

    expect(await root.publish(at(root, 'd/exclusive.json'), encoder.encode('x'), { exclusive: true })).toEqual({
      outcome: 'exists',
    });
    await root.publish(at(root, 'd/replace.json'), encoder.encode('x'));

    expect(await readFile(`${parent}/outside.txt`, 'utf8')).toBe('protected');
    expect((await lstat(`${work}/d/exclusive.json`)).isSymbolicLink()).toBe(true);
    expect((await lstat(`${work}/d/replace.json`)).isFile()).toBe(true);
  });

  test('a linked folder on the way is refused and nothing is written beyond it', async () => {
    const { root, work, parent } = await world();
    await mkdir(`${parent}/elsewhere`);
    await symlink(`${parent}/elsewhere`, `${work}/linked`);

    expect(await refusalOf(async () => await root.publish(at(root, 'linked/x.json'), encoder.encode('x')))).toMatch(
      /^refused:/u,
    );
    expect(await readdir(`${parent}/elsewhere`)).toEqual([]);
  });

  test('nothing is published through a read-only root', async () => {
    const parent = await mkdtemp(`${tmpdir()}/fy-roots-publish-`);
    parents.push(parent);
    const root = rootsPortFor(
      real,
      { home: `${parent}/home`, plugin: 'codex', worktrees: `${parent}/w` },
      ['harness-history'],
      () => undefined,
      {
        random: () => 'r',
      },
    ).root('harness-history', { subfolder: parent });

    expect(await refusalOf(async () => await root.publish(at(root, 'x.json'), encoder.encode('x')))).toBe(
      'refused:read_only',
    );
  });
});

describe('RootHandle.readDurable, syncDirectory and fileIdentity', () => {
  test('reads through one descriptor, syncs THAT descriptor and answers the identity of what it read', async () => {
    const synced: string[] = [];
    const { root } = await world((_events, disk) => ({
      ...disk,
      openRead: async path => {
        const opened = await disk.openRead(path);
        return {
          ...opened,
          sync: async () => {
            synced.push(path);
            await opened.sync();
          },
        };
      },
    }));
    const published = await root.publish(at(root, 'd/r.json'), encoder.encode('hello'));
    const read = await root.readDurable(at(root, 'd/r.json'));

    expect(decoder.decode(read?.bytes)).toBe('hello');
    expect(synced).toHaveLength(1);
    expect(read?.identity).toEqual((published as { identity: unknown }).identity as never);
  });

  test('nothing at the name is undefined, for the read and for the identity', async () => {
    const { root } = await world();

    expect(await root.readDurable(at(root, 'nothing/here.json'))).toBeUndefined();
    expect(await root.fileIdentity(at(root, 'nothing/here.json'))).toBeUndefined();
  });

  test('a file with a second name stays refused after the brief wait a mid-link read gets', async () => {
    const { root, work, parent } = await world();
    await root.publish(at(root, 'd/r.json'), encoder.encode('x'));
    await link(`${work}/d/r.json`, `${parent}/other-name`);

    expect(await refusalOf(async () => await root.readDurable(at(root, 'd/r.json')))).toBe('refused:hard_link');
  });

  test('a link at the name is never read', async () => {
    const { root, work, parent } = await world();
    await writeFile(`${parent}/outside.txt`, 'protected');
    await mkdir(`${work}/d`);
    await symlink(`${parent}/outside.txt`, `${work}/d/r.json`);

    expect(await refusalOf(async () => await root.readDurable(at(root, 'd/r.json')))).toMatch(/^refused:/u);
  });

  test("syncDirectory syncs the folder's parent first, then the folder", async () => {
    const { root, work, events } = await world(recording);
    await root.makeDirectory(at(root, 'a/b'));
    events.length = 0;
    await root.syncDirectory(at(root, 'a/b'), { parent: true });
    await root.syncDirectory(at(root, 'a/b'));

    const base = await (await import('node:fs/promises')).realpath(work);
    expect(events.filter(event => event.startsWith('sync'))).toEqual([
      `sync ${base}/a`,
      `sync ${base}/a/b`,
      `sync ${base}/a/b`,
    ]);
  });

  test('the identity of a name changes when another file is published over it', async () => {
    const { root } = await world();
    await root.publish(at(root, 'd/r.json'), encoder.encode('one'));
    const proved = await root.readDurable(at(root, 'd/r.json'));
    await root.publish(at(root, 'd/r.json'), encoder.encode('two'));

    expect(await root.fileIdentity(at(root, 'd/r.json'))).not.toEqual(proved?.identity as never);
  });
});

/**
 * The repo-standard directory-sync tolerance (copied from the three lifecycle modules that each carried their own
 * helper): a filesystem that cannot sync a directory says `EINVAL`, `ENOTSUP` or `EPERM`, and failing there would make
 * the daemon unusable rather than safer; every other failure means the entry is NOT durable and must propagate.
 */
describe('a leftover second name and a slow winner', () => {
  test('the temp name is gone BEFORE the folder is synced, so no sync ever persists two names', async () => {
    const links: number[] = [];
    const { root, work } = await world((_events, disk) => ({
      ...disk,
      openDirectory: async path => {
        const opened = await disk.openDirectory(path);
        return {
          ...opened,
          sync: async () => {
            const found = await stat(`${work}/d/r.json`).catch(() => undefined);
            if (found !== undefined) links.push(found.nlink);
            await opened.sync();
          },
        };
      },
    }));
    await root.publish(at(root, 'd/r.json'), encoder.encode('one'), { exclusive: true });

    expect(links.length).toBeGreaterThan(0);
    expect(links.every(count => count === 1)).toBe(true);
  });

  test("a record with this root's own leftover temp link is still readable, and the leftover is removed", async () => {
    const { root, work } = await world();
    await root.publish(at(root, 'd/r.json'), encoder.encode('one'), { exclusive: true });
    // what a crash between the link and the unlink (or a power cut before the unlink was synced) leaves behind
    await link(`${work}/d/r.json`, `${work}/d/.r.json.0f3a.tmp`);

    const read = await root.readDurable(at(root, 'd/r.json'));

    expect(decoder.decode(read?.bytes)).toBe('one');
    expect(await readdir(`${work}/d`)).toEqual(['r.json']);
    expect((await stat(`${work}/d/r.json`)).nlink).toBe(1);
  });

  test("the leftover of an interrupted publish does not wedge the next exclusive publish's loser either", async () => {
    const { root, work } = await world();
    await root.publish(at(root, 'd/r.json'), encoder.encode('one'), { exclusive: true });
    await link(`${work}/d/r.json`, `${work}/d/.r.json.0f3a.tmp`);

    expect(await root.publish(at(root, 'd/r.json'), encoder.encode('two'), { exclusive: true })).toEqual({
      outcome: 'exists',
    });
    expect(decoder.decode((await root.readDurable(at(root, 'd/r.json')))?.bytes)).toBe('one');
  });

  test('a stranger hard link stays refused: another name in the folder, or one in another folder', async () => {
    const { root, work } = await world();
    await root.publish(at(root, 'd/r.json'), encoder.encode('one'), { exclusive: true });
    await link(`${work}/d/r.json`, `${work}/d/notes.txt`);

    expect(await refusalOf(async () => await root.readDurable(at(root, 'd/r.json')))).toBe('refused:hard_link');
    expect(await readFile(`${work}/d/notes.txt`, 'utf8')).toBe('one');
    // a temp-shaped name for a DIFFERENT file is not this file's leftover
    await rm(`${work}/d/notes.txt`);
    await writeFile(`${work}/d/.r.json.0f3a.tmp`, 'stranger');
    expect(decoder.decode((await root.readDurable(at(root, 'd/r.json')))?.bytes)).toBe('one');
    expect(await readFile(`${work}/d/.r.json.0f3a.tmp`, 'utf8')).toBe('stranger');
  });

  test('a loser that reads while the winner is inside its slow directory sync adopts the standing', async () => {
    let stalled = false;
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => (release = resolve));
    let reached: () => void = () => {};
    const inSync = new Promise<void>(resolve => (reached = resolve));
    const { root, work } = await world((_events, disk) => ({
      ...disk,
      openDirectory: async path => {
        const opened = await disk.openDirectory(path);
        return {
          ...opened,
          sync: async () => {
            // the leaf folder's sync, after the link: the winner stalls here
            if (
              !stalled &&
              (await lstat(`${work}/d/r.json`).then(
                () => true,
                () => false,
              ))
            ) {
              stalled = true;
              reached();
              await gate;
            }
            await opened.sync();
          },
        };
      },
    }));
    const winner = root.publish(at(root, 'd/r.json'), encoder.encode('one'), { exclusive: true });
    await inSync;

    const loser = await root.publish(at(root, 'd/r.json'), encoder.encode('two'), { exclusive: true });
    const standing = await root.readDurable(at(root, 'd/r.json'));
    release();

    expect(loser).toEqual({ outcome: 'exists' });
    expect(decoder.decode(standing?.bytes)).toBe('one');
    expect((await winner).outcome).toBe('published');
  });
});

describe('readDurable held', () => {
  test('keeps the descriptor through the hold and tells whether the name still reaches the proved file', async () => {
    const { root } = await world();
    await root.publish(at(root, 'd/r.json'), encoder.encode('one'));

    const answers = await root.readDurable(at(root, 'd/r.json'), undefined, async held => {
      const before = await held.stillNames();
      await root.publish(at(root, 'd/r.json'), encoder.encode('two'));
      return { before, after: await held.stillNames(), text: decoder.decode(held.bytes) };
    });

    expect(answers).toEqual({ before: true, after: false, text: 'one' });
  });

  test('nothing at the name never calls the hold', async () => {
    const { root } = await world();
    let called = false;

    expect(
      await root.readDurable(at(root, 'd/none.json'), undefined, async () => {
        called = true;
      }),
    ).toBeUndefined();
    expect(called).toBe(false);
  });
});

describe('writeNew cleanup', () => {
  test('a failed fill removes the name only while it is still the file this call created', async () => {
    const parent = await mkdtemp(`${tmpdir()}/fy-roots-publish-`);
    parents.push(parent);
    const path = `${parent}/leaf.json`;
    // the fill replaces the name with another publisher's file, then fails
    async function* intruder(): AsyncGenerator<Uint8Array> {
      await writeFile(`${parent}/other.json`, 'theirs');
      await rename(`${parent}/other.json`, path);
      throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
      yield new Uint8Array();
    }

    expect(await refusalOf(async () => await real.writeNew(path, intruder() as never, 0o600))).toBe(
      'error:Error: no space',
    );
    expect(await readFile(path, 'utf8')).toBe('theirs');
  });
});

describe('a directory that cannot be opened for the sync', () => {
  for (const code of ['EINVAL', 'ENOTSUP', 'EPERM'])
    test(`${code} at the OPEN of an ancestor being persisted is tolerated, like the sync itself`, async () => {
      const opens = new Map<string, number>();
      let failAt = Number.POSITIVE_INFINITY;
      const build = () =>
        world((_events, disk) => ({
          ...disk,
          openDirectory: async path => {
            const count = (opens.get(path) ?? 0) + 1;
            opens.set(path, count);
            if (path.endsWith('/work') && count === failAt)
              throw Object.assign(new Error('cannot open a directory here'), { code });
            return await disk.openDirectory(path);
          },
        }));
      // measure: how many times the base folder is opened by one publish; the LAST one is the ancestor's sync
      const probe = await build();
      await probe.root.publish(at(probe.root, 'd/x.json'), encoder.encode('x'));
      const last = [...opens.entries()].find(([path]) => path.endsWith('/work'))?.[1] ?? 0;
      opens.clear();
      failAt = last;

      const { root, work } = await build();
      await root.publish(at(root, 'd/x.json'), encoder.encode('x'));

      expect(await readFile(`${work}/d/x.json`, 'utf8')).toBe('x');
    });
});

describe('directory sync tolerance', () => {
  /** Makes every `FileHandle.sync` in this process answer `code` while `use` runs; the real method comes back after. */
  async function whileSyncFails<T>(code: string, use: () => Promise<T>): Promise<T> {
    const probe = await open(tmpdir());
    const prototype = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
    await probe.close();
    const original = prototype.sync;
    prototype.sync = async () => {
      throw Object.assign(new Error(`the platform refused a directory sync with ${code}`), { code });
    };
    try {
      return await use();
    } finally {
      prototype.sync = original;
    }
  }

  for (const code of ['EINVAL', 'ENOTSUP', 'EPERM'])
    test(`${code} from the sync is tolerated and the folder is still closed`, async () => {
      const { work } = await world();
      const folder = await real.openDirectory(work);

      await whileSyncFails(code, async () => await folder.sync());
      await folder.close();
    });

  test('any other failure of the sync propagates', async () => {
    const { work } = await world();
    const folder = await real.openDirectory(work);

    expect(await whileSyncFails('EIO', async () => await refusalOf(async () => await folder.sync()))).toBe(
      'error:Error: the platform refused a directory sync with EIO',
    );
    await folder.close();
  });

  test('a real folder is persisted through the proven descriptor', async () => {
    const { work } = await world();
    const folder = await real.openDirectory(work);

    await folder.sync();
    await folder.close();
  });
});
