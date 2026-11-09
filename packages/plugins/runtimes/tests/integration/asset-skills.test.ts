/**
 * `RuntimesApi.assetSkills()` over the kernel's REAL `fleet` root on a seeded temp fleet (never a real home): the v4-installed
 * skills, one plain folder each under `<fleet>/assets/skills`. Every refusal is the reader's decision on what a name IS
 * (a link, a hard link, a non-regular file, an unusable name, an over-bound read), and none of them says a file's text.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { link, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RootsPort } from '@ferretry/kernel/contract';
import { fleetHomes } from '../../daemon/adapters/fleet-home-reader.ts';
import { FleetPublication } from '../../daemon/lib/service/publication.ts';
import { cleanupWorlds, fleetWorld, type FleetWorld } from '../unit/support/fleet-world.ts';

afterEach(cleanupWorlds);

const SECRET = 'SECRET-TEXT-THAT-MUST-NEVER-SURFACE';
const doc = (name: string): string => `---\nname: ${name}\ndescription: does ${name}\n---\n`;
const skills = (world: FleetWorld): string => join(world.fleet, 'assets', 'skills');

async function skill(world: FleetWorld, name: string, text = doc(name)): Promise<void> {
  await mkdir(join(skills(world), name), { recursive: true });
  await writeFile(join(skills(world), name, 'SKILL.md'), text);
}

const reader = (
  world: FleetWorld,
  publication: Pick<FleetPublication, 'reading'> = new FleetPublication(),
  said: string[] = [],
) => {
  const assets = fleetHomes(world.roots, publication, sentence => said.push(sentence)).assetSkills?.();
  if (assets === undefined) throw new Error('the fleet answers no asset skills');
  return assets;
};

describe('assetSkills lists the fleet’s installed skills as plain folders only', () => {
  it('lists plain skill folders in name order, each as Ferretry’s own, with its absolute SKILL.md', async () => {
    const world = await fleetWorld();
    await skill(world, 'review');
    await skill(world, 'alpha');
    expect(await reader(world).skills(10)).toEqual([
      { name: 'alpha', manifest: `${world.fleet}/assets/skills/alpha/SKILL.md`, managed: true },
      { name: 'review', manifest: `${world.fleet}/assets/skills/review/SKILL.md`, managed: true },
    ]);
  });

  it('lists nothing while there is no asset tree, or while it is a link', async () => {
    // A linked `assets` or `assets/skills` is refused by the kernel's no-follow `fleet` root before the reader's own
    // lstat checks (`plain(fleet, 'assets')`, `plain(fleet, 'assets/skills')`) are reached, so this case proves the
    // kernel's guard; those two checks are the reader's second layer and are not separately pinned here.
    const world = await fleetWorld();
    expect(await reader(world).skills(10)).toEqual([]);
    await mkdir(join(world.parent, 'elsewhere', 'skills', 'x'), { recursive: true });
    await writeFile(join(world.parent, 'elsewhere', 'skills', 'x', 'SKILL.md'), doc('x'));
    await symlink(join(world.parent, 'elsewhere'), join(world.fleet, 'assets'));
    expect(await reader(world).skills(10)).toEqual([]);
    await rm(join(world.fleet, 'assets'));
    await mkdir(join(world.fleet, 'assets'));
    await symlink(join(world.parent, 'elsewhere', 'skills'), join(world.fleet, 'assets', 'skills'));
    expect(await reader(world).skills(10)).toEqual([]);
    expect(await reader(world).skillManifest('x', 1000)).toBeUndefined();
  });

  it('skips a planted link, a hard-linked SKILL.md, a folder with none, a file, a dot-entry and an unusable name', async () => {
    const world = await fleetWorld();
    await skill(world, 'good');
    // a link to a real skill folder elsewhere
    await mkdir(join(world.parent, 'elsewhere', 'outside'), { recursive: true });
    await writeFile(join(world.parent, 'elsewhere', 'outside', 'SKILL.md'), doc('outside'));
    await symlink(join(world.parent, 'elsewhere', 'outside'), join(skills(world), 'planted'));
    // a folder whose SKILL.md is a link
    await mkdir(join(skills(world), 'linked-manifest'));
    await symlink(
      join(world.parent, 'elsewhere', 'outside', 'SKILL.md'),
      join(skills(world), 'linked-manifest', 'SKILL.md'),
    );
    // a folder whose SKILL.md has a second name
    await mkdir(join(skills(world), 'hard'));
    await writeFile(join(world.parent, 'elsewhere', 'second-name'), doc('hard'));
    await link(join(world.parent, 'elsewhere', 'second-name'), join(skills(world), 'hard', 'SKILL.md'));
    await mkdir(join(skills(world), 'no-manifest'));
    await writeFile(join(skills(world), 'a-file'), 'x');
    await skill(world, '.system');
    await skill(world, 'has space');
    await skill(world, 'dots..dots');
    await skill(world, '-lead');
    const found = await reader(world).skills(50);
    expect(found.map(entry => entry.name)).toEqual(['good']);
    // none of the planted names can be read either
    for (const name of [
      'planted',
      'linked-manifest',
      'hard',
      'no-manifest',
      'a-file',
      '.system',
      'has space',
      'dots..dots',
    ])
      expect(await reader(world).skillManifest(name, 1000)).toBeUndefined();
  });

  it('lists at most limit + 1, and answers nothing for a bound that is not a usable number', async () => {
    const world = await fleetWorld();
    for (const name of ['a', 'b', 'c', 'd']) await skill(world, name);
    expect((await reader(world).skills(2)).map(entry => entry.name)).toEqual(['a', 'b', 'c']);
    expect((await reader(world).skills(0)).map(entry => entry.name)).toEqual(['a']);
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1001])
      expect(await reader(world).skills(bad)).toEqual([]);
  });

  it('limit is a hard bound: 0 and 1000 are served and say nothing, anything outside refuses with a sentence', async () => {
    const world = await fleetWorld();
    await skill(world, 'a');
    const said: string[] = [];
    const assets = reader(world, new FleetPublication(), said);
    expect((await assets.skills(0)).map(entry => entry.name)).toEqual(['a']);
    expect((await assets.skills(1000)).map(entry => entry.name)).toEqual(['a']);
    expect(said).toEqual([]);
    for (const bad of [-1, 1001, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(await assets.skills(bad)).toEqual([]);
    expect(said).toHaveLength(5);
    expect(new Set(said)).toEqual(
      new Set([
        "The fleet's installed skills were asked for with a limit that is not a whole number from 0 to 1000, so none were listed.",
      ]),
    );
    expect(said.join('\n')).not.toContain(world.fleet);
  });
});

describe('assetSkills reads a listed skill’s SKILL.md within a bound, and says nothing else', () => {
  it('reads a listed skill’s text and refuses one over the bound or with an unusable bound', async () => {
    const world = await fleetWorld();
    await skill(world, 'review', `${doc('review')}${SECRET}`);
    const assets = reader(world);
    expect(await assets.skillManifest('review', 1000)).toBe(`${doc('review')}${SECRET}`);
    expect(await assets.skillManifest('review', 10)).toBeUndefined();
    for (const bad of [0, -1, 1.5, Number.NaN]) expect(await assets.skillManifest('review', bad)).toBeUndefined();
    expect(await assets.skillManifest('absent', 1000)).toBeUndefined();
    expect(await assets.skillManifest('../review', 1000)).toBeUndefined();
  });

  it('maxBytes is a hard bound: 1 byte up to 256 KiB are served, anything outside refuses with a sentence and no content', async () => {
    const world = await fleetWorld();
    await skill(world, 'review', `${doc('review')}${SECRET}`);
    const said: string[] = [];
    const assets = reader(world, new FleetPublication(), said);
    expect(await assets.skillManifest('review', 256 * 1024)).toBe(`${doc('review')}${SECRET}`);
    // a bound that is allowed but smaller than the file is a file too large, not a refused bound: nothing is said
    expect(await assets.skillManifest('review', 1)).toBeUndefined();
    expect(said).toEqual([]);
    for (const bad of [0, -1, 256 * 1024 + 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])
      expect(await assets.skillManifest('review', bad)).toBeUndefined();
    expect(said).toHaveLength(6);
    expect(new Set(said)).toEqual(
      new Set([
        'An installed skill was asked for with a byte bound that is not a whole number from 1 to 262144, so it was not read.',
      ]),
    );
    expect(said.join('\n')).not.toContain(SECRET);
    expect(said.join('\n')).not.toContain('review');
  });

  it('a skill swapped for a link after it was listed is not read, and the answer names no content', async () => {
    const world = await fleetWorld();
    await skill(world, 'review', SECRET);
    const assets = reader(world);
    expect((await assets.skills(5)).map(entry => entry.name)).toEqual(['review']);
    await rm(join(skills(world), 'review'), { recursive: true });
    await mkdir(join(world.parent, 'elsewhere', 'steal'), { recursive: true });
    await writeFile(join(world.parent, 'elsewhere', 'steal', 'SKILL.md'), SECRET);
    await symlink(join(world.parent, 'elsewhere', 'steal'), join(skills(world), 'review'));
    expect(await assets.skillManifest('review', 1000)).toBeUndefined();
    expect(await assets.skills(5)).toEqual([]);
  });

  it('each call runs inside one read of the published fleet', async () => {
    const world = await fleetWorld();
    await skill(world, 'review');
    let reads = 0;
    const gated = { reading: async <T>(body: () => Promise<T>): Promise<T> => (reads++, await body()) };
    const assets = reader(world, gated);
    await assets.skills(5);
    await assets.skillManifest('review', 1000);
    expect(reads).toBe(2);
  });

  it('a fleet that cannot be opened lists and reads nothing instead of throwing', async () => {
    const world = await fleetWorld();
    await skill(world, 'review');
    let opens = 0;
    const roots: RootsPort = {
      ...world.roots,
      root: (name, scope) => {
        opens += 1;
        // the first open builds the reader (the fleet folder's name); every later one fails
        if (opens > 1) throw new Error('the fleet could not be opened');
        return world.roots.root(name, scope);
      },
    };
    const assets = fleetHomes(roots, new FleetPublication()).assetSkills?.();
    expect(await assets?.skills(5)).toEqual([]);
    expect(await assets?.skillManifest('review', 1000)).toBeUndefined();
  });
});
