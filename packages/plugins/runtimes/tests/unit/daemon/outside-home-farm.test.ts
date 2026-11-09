/**
 * BG-033: `skills()` of an account home outside the fleet costs the same per entry whatever the entry leads to. A farm of
 * links to one big folder used to list the whole target folder once per link (links x entries); the reader now resolves the
 * one name `skills/<n>/SKILL.md`. The proof counts WORK (directory listings and real-path resolutions the reader asks the
 * kernel for), never wall-clock time.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { link, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RootsPort } from '@ferretry/kernel/contract';
import { fleetHomes } from '../../../daemon/adapters/fleet-home-reader.ts';
import { buildFleetManifest } from '../../../daemon/lib/manifest.ts';
import { FleetPublication } from '../../../daemon/lib/service/publication.ts';
import { cleanupWorlds, fleetWorld } from '../support/fleet-world.ts';

afterEach(cleanupWorlds);

const LINKED = '00000000-0000-4000-8000-0000000000a1';

/** Roots whose `harness-home` handles count each `entries` and `realPath` the reader asks for. */
function counted(roots: RootsPort, work: { entries: number; realPath: number }): Pick<RootsPort, 'root'> {
  return {
    root: ((name: never, options?: never) => {
      const real = roots.root(name, options);
      if ((name as string) !== 'harness-home') return real;
      return new Proxy(real, {
        get(target, key) {
          const value = Reflect.get(target, key) as unknown;
          if ((key !== 'realPath' && key !== 'entries') || typeof value !== 'function') return value;
          return async (path: string) => {
            work[key] += 1;
            return await (value as (path: string) => Promise<unknown>).call(target, path);
          };
        },
      });
    }) as RootsPort['root'],
  };
}

async function seed(work: { entries: number; realPath: number }) {
  const world = await fleetWorld();
  const linked = join(world.person, 'linked');
  await mkdir(join(linked, 'skills'), { recursive: true });
  const manifest = buildFleetManifest({
    generatedAt: '2027-01-15T08:00:00.000Z',
    accounts: [
      {
        id: LINKED,
        kind: 'claude' as const,
        mode: 'interactive' as const,
        wrapper: `${world.fleet}/bin/w-a1`,
        home: linked,
        displayName: LINKED,
        defaultModel: 'm',
        models: [{ id: 'm', available: true as const }],
        available: true,
        unavailableReason: null,
      },
    ],
    runtimes: [],
  });
  await writeFile(join(world.fleet, 'manifest.json'), JSON.stringify(manifest));
  const api = fleetHomes(counted(world.roots, work), new FleetPublication());
  await api.homes();
  const reader = api.home(LINKED);
  if (reader === undefined) throw new Error('the home is not published');
  return { linked, reader };
}

describe('BG-033 a link farm in skills/ costs work per link, not per link times the target folder', () => {
  it('BG-033 300 links to one in-home folder of 300 files list the folders once and resolve each link a fixed number of times', async () => {
    const work = { entries: 0, realPath: 0 };
    const { linked, reader } = await seed(work);
    const big = join(linked, 'big');
    await mkdir(big, { recursive: true });
    const links = 300;
    for (let index = 0; index < links; index += 1) await writeFile(join(big, `f${index}`), '');
    for (let index = 0; index < links; index += 1) await symlink(big, join(linked, 'skills', `l${index}`));
    // No SKILL.md anywhere: every link is looked at and none is listed.
    expect(await reader.skills(50)).toEqual([]);
    // The home and `skills/` are listed; no target folder is.
    expect(work.entries).toBeLessThanOrEqual(2);
    // Per link: the link, its folder and its `SKILL.md`, a fixed few; the folders' own real paths once each.
    expect(work.realPath).toBeLessThanOrEqual(links * 4 + 10);
    // And with a manifest the same farm lists exactly the limit plus one, at the same cost.
    await writeFile(join(big, 'SKILL.md'), '# big\n');
    work.entries = 0;
    work.realPath = 0;
    expect((await reader.skills(20)).length).toBe(21);
    expect(work.entries).toBeLessThanOrEqual(2);
  });

  it('BG-033 a folder whose SKILL.md is a hard link is not listed (the kernel never reads one, so the name would lead nowhere)', async () => {
    const work = { entries: 0, realPath: 0 };
    const { linked, reader } = await seed(work);
    await mkdir(join(linked, 'skills', 'hard'), { recursive: true });
    await mkdir(join(linked, 'skills', 'plain'), { recursive: true });
    await writeFile(join(linked, 'shared.md'), '# shared\n');
    await link(join(linked, 'shared.md'), join(linked, 'skills', 'hard', 'SKILL.md'));
    await writeFile(join(linked, 'skills', 'plain', 'SKILL.md'), '# plain\n');
    expect((await reader.skills(10)).map(skill => skill.name)).toEqual(['plain']);
    expect(await reader.skillManifest('hard', 100)).toBeUndefined();
  });
});
