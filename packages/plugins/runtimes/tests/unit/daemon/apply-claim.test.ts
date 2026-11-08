/**
 * The exclusive claim over the fleet folder (F-0038..F-0054: `.fy-fleet-apply.lock/claim-<token>.json`, staged as
 * `.fy-fleet-apply.<uuid>`): one holder at a time, published whole, released by proof of its token, never taken over.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
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
