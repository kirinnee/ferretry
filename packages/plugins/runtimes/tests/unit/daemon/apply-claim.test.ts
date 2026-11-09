/**
 * The exclusive claim over the fleet folder (F-0038..F-0054: `.fy-fleet-apply.lock/claim-<token>.json`, staged as
 * `.fy-fleet-apply.<uuid>`): one holder at a time, published whole, released by proof of its token, never taken over.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { lstat, mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyClaimFor } from '../../../daemon/adapters/apply-claim.ts';
import type { FleetDisk } from '../../../daemon/adapters/fleet-disk.ts';
import { cleanupWorlds, fleetWorld } from '../support/fleet-world.ts';

afterEach(cleanupWorlds);

const manifestOf = (fleet: string): string => join(fleet, 'manifest.json');
const lockOf = (fleet: string): string => join(fleet, '.fy-fleet-apply.lock');

describe('the fleet apply claim', () => {
  it('is published whole as a folder holding one token file, and leaves nothing behind when released', async () => {
    const world = await fleetWorld();
    const claim = world.claimFor(manifestOf(world.fleet));

    const token = await claim.acquire();

    expect(await readdir(lockOf(world.fleet))).toEqual([`claim-${token}.json`]);
    const body = JSON.parse(await readFile(join(lockOf(world.fleet), `claim-${token}.json`), 'utf8'));
    expect(Object.keys(body).toSorted()).toEqual(['at', 'token']);
    expect(await claim.release(token)).toBeUndefined();
    expect((await readdir(world.fleet)).filter(name => name.startsWith('.fy-fleet-apply'))).toEqual([]);
  });

  it('refuses a second holder while the first holds it, naming the claim, and never takes it over', async () => {
    const world = await fleetWorld();
    const first = world.claimFor(manifestOf(world.fleet));
    const token = await first.acquire();

    const second = world.claimFor(manifestOf(world.fleet), 30).acquire();

    await expect(second).rejects.toThrow(/another fleet apply holds .*\.fy-fleet-apply\.lock, claimed at /u);
    // The first holder's claim is exactly as it was.
    expect(await readdir(lockOf(world.fleet))).toEqual([`claim-${token}.json`]);
    expect(await first.release(token)).toBeUndefined();
    // And once released the second may take it.
    const taken = await world.claimFor(manifestOf(world.fleet)).acquire();
    expect(taken).not.toBe(token);
  });

  it('does not leave a staged claim behind when it loses the race', async () => {
    const world = await fleetWorld();
    const token = await world.claimFor(manifestOf(world.fleet)).acquire();
    await world
      .claimFor(manifestOf(world.fleet), 20)
      .acquire()
      .catch(() => undefined);

    expect(
      (await readdir(world.fleet)).filter(
        name => name.startsWith('.fy-fleet-apply.') && name !== '.fy-fleet-apply.lock',
      ),
    ).toEqual([]);
    expect(token).toBeDefined();
  });

  it('release never removes a claim that is not its own: it is put back and reported', async () => {
    const world = await fleetWorld();
    const claim = world.claimFor(manifestOf(world.fleet));
    const mine = await claim.acquire();
    // A person cleared our claim and a successor took the name.
    await world.disk.remove(lockOf(world.fleet));
    const successor = await world.claimFor(manifestOf(world.fleet)).acquire();

    const residue = await claim.release(mine);

    expect(residue).toBe(lockOf(world.fleet));
    expect(await readdir(lockOf(world.fleet))).toEqual([`claim-${successor}.json`]);
  });

  it('reports a claim it cannot read, and an empty folder at the name, rather than taking either over', async () => {
    const world = await fleetWorld();
    await mkdir(lockOf(world.fleet));

    const act = world.claimFor(manifestOf(world.fleet), 20).acquire();

    await expect(act).rejects.toThrow(/its claim could not be read; remove that folder once no apply is running/u);
    expect(await lstat(lockOf(world.fleet))).toBeDefined();
    await writeFile(join(lockOf(world.fleet), 'claim-x.json'), 'not json');
    await expect(world.claimFor(manifestOf(world.fleet), 20).acquire()).rejects.toThrow(/could not be read/u);
  });

  it('releasing a claim that is already gone is a release', async () => {
    const world = await fleetWorld();
    const claim = world.claimFor(manifestOf(world.fleet));
    const token = await claim.acquire();
    await world.disk.remove(lockOf(world.fleet));

    expect(await claim.release(token)).toBeUndefined();
  });
});

/**
 * A disk that runs `before` ahead of every call the code under test makes, so a test can look at the world at each
 * step (the claim is only a lock if the name is never free while somebody else's claim is meant to hold it).
 */
function watched(disk: FleetDisk, before: (call: string) => Promise<void>): FleetDisk {
  return new Proxy(disk, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function' || typeof property !== 'string') return value;
      return async (...args: unknown[]) => {
        await before(property);
        return await value.apply(target, args);
      };
    },
  });
}

describe('releasing a superseded claim', () => {
  it('M3 P8 never frees the lock name under a live successor: no step of the release leaves the name free', async () => {
    const world = await fleetWorld();
    const manifest = manifestOf(world.fleet);
    const superseded = world.claimFor(manifest);
    const mine = await superseded.acquire();
    // A person cleared our claim (as the refusal invites) and a successor took the name.
    await world.disk.remove(lockOf(world.fleet));
    const successor = await world.claimFor(manifest).acquire();
    const seen: string[] = [];
    let thirdHeld = false;
    const watching = watched(world.disk, async call => {
      // At EVERY call the release makes, the successor's claim is at the name, and a third contender cannot take it.
      const names = await readdir(lockOf(world.fleet)).catch(() => undefined);
      seen.push(`${call}:${names?.join(',') ?? 'FREE'}`);
      const third = await world
        .claimFor(manifest, 0)
        .acquire()
        .then(
          () => true,
          () => false,
        );
      thirdHeld ||= third;
    });
    const releasing = applyClaimFor(watching, manifest, {
      now: () => 0,
      sleep: async () => undefined,
      waitMs: 0,
    });

    const residue = await releasing.release(mine);

    expect(thirdHeld).toBe(false);
    expect(seen.filter(line => line.endsWith(':FREE'))).toEqual([]);
    // The successor's claim is exactly where it was, and the release says the claim it found was not its own.
    expect(residue).toBe(lockOf(world.fleet));
    expect(await readdir(lockOf(world.fleet))).toEqual([`claim-${successor}.json`]);
    expect((await readdir(world.fleet)).filter(name => name.startsWith('.fy-fleet-apply-releasing'))).toEqual([]);
  });

  it('M3 a release whose own claim is there removes its token file, then the emptied folder, and nothing else', async () => {
    const world = await fleetWorld();
    const manifest = manifestOf(world.fleet);
    const claim = world.claimFor(manifest);
    const token = await claim.acquire();
    const calls: string[] = [];
    const watching = applyClaimFor(
      watched(world.disk, async call => {
        calls.push(call);
      }),
      manifest,
      { now: () => 0, sleep: async () => undefined },
    );

    expect(await watching.release(token)).toBeUndefined();

    expect(calls).not.toContain('rename');
    expect((await readdir(world.fleet)).filter(name => name.startsWith('.fy-fleet-apply'))).toEqual([]);
  });

  it('M3 never removes an empty folder at the name that is not the one it published', async () => {
    const world = await fleetWorld();
    const manifest = manifestOf(world.fleet);
    let swapped = false;
    const watching = applyClaimFor(
      watched(world.disk, async call => {
        // Right after our own token file went and before the emptied folder is removed: a person clears the name and
        // somebody else's (empty) folder is there instead.
        if (call !== 'identity' || swapped) return;
        const emptied = await readdir(lockOf(world.fleet)).catch(() => undefined);
        if (emptied?.length !== 0) return;
        swapped = true;
        // The old folder is moved away (not removed), so the new one cannot be handed its inode number back.
        await rename(lockOf(world.fleet), join(world.fleet, 'moved-lock'));
        await mkdir(lockOf(world.fleet));
      }),
      manifest,
      { now: () => 0, sleep: async () => undefined },
    );
    const token = await watching.acquire();
    swapped = false;

    const residue = await watching.release(token);

    expect(swapped).toBe(true);
    expect(residue).toBe(lockOf(world.fleet));
    expect(await lstat(lockOf(world.fleet))).toBeDefined();
  });

  it('M3 a claim folder that still holds something else after our token went is reported, not removed', async () => {
    const world = await fleetWorld();
    const claim = world.claimFor(manifestOf(world.fleet));
    const token = await claim.acquire();
    await writeFile(join(lockOf(world.fleet), 'stray'), 'somebody else’s');

    expect(await claim.release(token)).toBe(lockOf(world.fleet));

    expect(await readdir(lockOf(world.fleet))).toEqual(['stray']);
  });

  it('M5 the refusal after a crashed apply names the claim and the originals it left moved aside', async () => {
    const world = await fleetWorld();
    const holder = world.claimFor(manifestOf(world.fleet));
    await holder.acquire();
    // An apply that was killed: its originals sit beside the files they replaced, under reserved names.
    await mkdir(join(world.fleet, 'homes', 'one'), { recursive: true });
    await writeFile(join(world.fleet, '.fy-fleet-backup-aaaa'), 'original manifest');
    await writeFile(join(world.fleet, 'homes', 'one', '.fy-fleet-backup-bbbb'), 'original settings');

    const refusal = await world
      .claimFor(manifestOf(world.fleet), 20)
      .acquire()
      .then(
        () => '',
        error => (error as Error).message,
      );

    expect(refusal).toMatch(/another fleet apply holds .*\.fy-fleet-apply\.lock, claimed at /u);
    expect(refusal).toContain('.fy-fleet-backup-aaaa');
    expect(refusal).toContain('homes/one/.fy-fleet-backup-bbbb');
    expect(refusal).toMatch(/only copy/u);
  });

  it('M5 a refusal with no leftovers names only the claim', async () => {
    const world = await fleetWorld();
    await world.claimFor(manifestOf(world.fleet)).acquire();

    const refusal = await world
      .claimFor(manifestOf(world.fleet), 20)
      .acquire()
      .then(
        () => '',
        error => (error as Error).message,
      );

    expect(refusal).not.toContain('.fy-fleet-backup-');
  });
});

describe('the claim’s names (F-0038, F-0039, F-0040, F-0053, F-0054)', () => {
  it('F-0038 the lock is `.fy-fleet-apply.lock` in the manifest’s folder', async () => {
    const world = await fleetWorld();
    const claim = world.claimFor(manifestOf(world.fleet));

    expect(claim.path).toBe(lockOf(world.fleet));
    await claim.acquire();
    expect((await lstat(lockOf(world.fleet))).isDirectory()).toBe(true);
  });

  it('F-0039 and F-0040 a claim is built as `.fy-fleet-apply.<uuid>/claim-<token>.json` and published by one move', async () => {
    const world = await fleetWorld();
    const staged: string[] = [];
    const watching = applyClaimFor(
      watched(world.disk, async call => {
        if (call !== 'rename') return;
        for (const name of await readdir(world.fleet)) {
          if (/^\.fy-fleet-apply\.[0-9a-f-]{36}$/u.test(name)) {
            staged.push(`${name}/${(await readdir(join(world.fleet, name))).join(',')}`);
          }
        }
      }),
      manifestOf(world.fleet),
      { now: () => 0, sleep: async () => undefined },
    );

    const token = await watching.acquire();

    expect(staged).toHaveLength(1);
    expect(staged[0]).toMatch(new RegExp(`^\\.fy-fleet-apply\\.[0-9a-f-]{36}/claim-${token}\\.json$`, 'u'));
    // Published whole: the staged name is gone and the lock holds the one token file.
    expect(await readdir(world.fleet)).toEqual(['.fy-fleet-apply.lock']);
  });

  it('F-0053 and F-0054 a claim is read from `<lock>/<name>` and held only if the one file is `claim-<its token>.json`', async () => {
    const world = await fleetWorld();
    await mkdir(lockOf(world.fleet));
    // The right shape: one file, named for the token its document carries.
    await writeFile(
      join(lockOf(world.fleet), 'claim-abc.json'),
      `${JSON.stringify({ token: 'abc', at: 1_700_000_000_000 })}\n`,
    );
    await expect(world.claimFor(manifestOf(world.fleet), 20).acquire()).rejects.toThrow(
      /claimed at 2023-11-14T22:13:20\.000Z/u,
    );
    // A name that disagrees with the document is not a claim anyone published.
    await writeFile(join(lockOf(world.fleet), 'claim-abc.json'), `${JSON.stringify({ token: 'other', at: 1 })}\n`);
    await expect(world.claimFor(manifestOf(world.fleet), 20).acquire()).rejects.toThrow(/could not be read/u);
  });
});
