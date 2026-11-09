/**
 * BG-033: an account home outside the fleet is read THROUGH its links (a home-manager home is made of them), read-only
 * and bounded. Real kernel roots over a temp world; the "store" is a temp folder standing in for `/nix/store`.
 *
 *   <parent>/store           the content the links lead to
 *   <parent>/person/<home>   the account homes outside the fleet (made of links, or of plain files)
 *   <parent>/fy-home         the daemon's own home (the fence): fleet/, state/
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, readFile, readlink, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RuntimeHomeReader } from '../../../contract/index.ts';
import { fleetHomes } from '../../../daemon/adapters/fleet-home-reader.ts';
import { followingHandle, MAX_LINK_HOPS } from '../../../daemon/adapters/following-handle.ts';
import { buildFleetManifest } from '../../../daemon/lib/manifest.ts';
import { FleetPublication } from '../../../daemon/lib/service/publication.ts';
import { cleanupWorlds, fleetWorld, type FleetWorld } from '../support/fleet-world.ts';

afterEach(cleanupWorlds);

const LINKED = '00000000-0000-4000-8000-0000000000a1';
const PLAIN = '00000000-0000-4000-8000-0000000000a2';
const SECRET = 'SECRET-VALUE-THAT-MUST-NEVER-SURFACE';

const account = (world: FleetWorld, id: string, home: string) => ({
  id,
  kind: 'claude' as const,
  mode: 'interactive' as const,
  wrapper: `${world.fleet}/bin/w-${id.slice(-2)}`,
  home,
  displayName: id,
  defaultModel: 'm',
  models: [{ id: 'm', available: true as const }],
  available: true,
  unavailableReason: null,
});

/** A world with a `store` folder, and the outside homes `person/linked` and `person/plain` published. */
async function seed() {
  const world = await fleetWorld();
  const store = join(world.parent, 'store');
  const linked = join(world.person, 'linked');
  const plain = join(world.person, 'plain');
  await mkdir(store, { recursive: true });
  await mkdir(linked, { recursive: true });
  await mkdir(plain, { recursive: true });
  const manifest = buildFleetManifest({
    generatedAt: '2027-01-15T08:00:00.000Z',
    accounts: [account(world, LINKED, linked), account(world, PLAIN, plain)],
    runtimes: [],
  });
  await writeFile(join(world.fleet, 'manifest.json'), JSON.stringify(manifest));
  const api = fleetHomes(world.roots, new FleetPublication());
  await api.homes();
  const reader = (id: string): RuntimeHomeReader => {
    const found = api.home(id);
    if (found === undefined) throw new Error(`${id} is not published`);
    return found;
  };
  return { world, store, linked, plain, reader };
}

const put = async (path: string, text: string): Promise<void> => {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text);
};

/** The account content at `base`: two skills (one with a nested folder), settings, MCP config and a Codex config. */
async function content(base: string): Promise<void> {
  await put(join(base, 'skills', 'alpha', 'SKILL.md'), '# alpha\n');
  await put(join(base, 'skills', 'alpha', 'refs', 'one.md'), 'one');
  await put(join(base, 'skills', 'beta', 'SKILL.md'), '# beta\n');
  await put(join(base, 'settings.json'), '{"permissions":{}}');
  await put(join(base, '.claude.json'), '{"mcpServers":{"a":{}}}');
  await put(join(base, 'config.toml'), 'model = "m"\n');
}

/** Everything a reader says about a home, with the home's own folder name taken out of every path. */
async function everything(reader: RuntimeHomeReader, folder: string) {
  const skills = await reader.skills(50);
  const plainly = (text: string): string => text.split(folder).join('<home>');
  return {
    settings: await reader.document('settings.json', 1000),
    mcp: await reader.document('.claude.json', 1000),
    codex: await reader.document('config.toml', 1000),
    skills: skills.map(skill => ({ ...skill, manifest: plainly(skill.manifest) })),
    manifests: await Promise.all(skills.map(async skill => await reader.skillManifest(skill.name, 100))),
    trees: await Promise.all(skills.map(async skill => await reader.skillTree(skill.name, { entries: 50, depth: 5 }))),
    one: await reader.skillFile('alpha', 'refs/one.md', 100),
  };
}

describe('BG-033 an outside account home is read through its links', () => {
  it('BG-033 a home of links into a store (folders, per-file links, settings, MCP config) reads exactly like the same plain home', async () => {
    const { store, linked, plain, reader } = await seed();
    await content(plain);
    await content(store);
    // The home-manager shapes: the whole `skills/` folder is a link, a settings file is a link, and a skill folder that is
    // a real folder holds a link per file.
    await symlink(join(store, 'skills'), join(linked, 'skills'));
    await symlink(join(store, 'settings.json'), join(linked, 'settings.json'));
    await symlink(join(store, '.claude.json'), join(linked, '.claude.json'));
    await symlink(join(store, 'config.toml'), join(linked, 'config.toml'));
    const expected = await everything(reader(PLAIN), plain);
    expect(expected.skills.map(skill => skill.name)).toEqual(['alpha', 'beta']);
    expect(expected.settings).toBe('{"permissions":{}}');
    expect(await everything(reader(LINKED), linked)).toEqual(expected);
  });

  it('BG-033 a skill folder that holds a link per file (a recursive home-manager link tree) reads like a plain one', async () => {
    const { store, linked, plain, reader } = await seed();
    await content(plain);
    await content(store);
    for (const name of ['alpha', 'beta']) {
      await mkdir(join(linked, 'skills', name), { recursive: true });
      await symlink(join(store, 'skills', name, 'SKILL.md'), join(linked, 'skills', name, 'SKILL.md'));
    }
    await symlink(join(store, 'skills', 'alpha', 'refs'), join(linked, 'skills', 'alpha', 'refs'));
    for (const file of ['settings.json', '.claude.json', 'config.toml'])
      await symlink(join(store, file), join(linked, file));
    expect(await everything(reader(LINKED), linked)).toEqual(await everything(reader(PLAIN), plain));
  });

  it("BG-033 a followed file keeps the caller's size bound and a followed folder keeps the entry bound", async () => {
    const { store, linked, reader } = await seed();
    await content(store);
    await symlink(join(store, 'settings.json'), join(linked, 'settings.json'));
    await symlink(join(store, 'skills'), join(linked, 'skills'));
    await expect(reader(LINKED).document('settings.json', 3)).rejects.toThrow('is larger than the 3 bytes');
    expect((await reader(LINKED).skills(0)).length).toBe(1);
    const tree = await reader(LINKED).skillTree('alpha', { entries: 1, depth: 5 });
    expect(tree?.truncated).toBe(true);
    expect(tree?.entries.length).toBe(1);
  });

  it('BG-033 a link nested more than the bound is left as a link, and one inside the bound is read', async () => {
    const { store, linked, reader } = await seed();
    await put(join(linked, 'skills', 'deep', 'SKILL.md'), '# deep\n');
    // deep/l1 -> store/d1, d1/l2 -> store/d2 ... d(N-1)/lN -> store/dN, which holds `bottom.md`.
    const levels = MAX_LINK_HOPS + 2;
    for (let index = 1; index <= levels; index += 1) {
      await mkdir(join(store, `d${index}`), { recursive: true });
      const from = index === 1 ? join(linked, 'skills', 'deep') : join(store, `d${index - 1}`);
      await symlink(join(store, `d${index}`), join(from, `l${index}`));
    }
    await writeFile(join(store, `d${levels}`, 'bottom.md'), 'bottom');
    const tree = await reader(LINKED).skillTree('deep', { entries: 100, depth: 30 });
    const folders = tree?.entries.filter(entry => entry.type === 'file').map(entry => entry.path);
    const last = Array.from({ length: MAX_LINK_HOPS }, (_, index) => `l${index + 1}`).join('/');
    // The folder reached through MAX_LINK_HOPS links is listed; the link inside it is not followed.
    expect(
      tree?.entries.some(entry => entry.path === `${last}/l${MAX_LINK_HOPS + 1}` && entry.type === 'symlink'),
    ).toBe(true);
    expect(folders).toEqual(['SKILL.md']);
    expect(await reader(LINKED).skillFile('deep', `${last}/l${MAX_LINK_HOPS + 1}/bottom.md`, 100)).toEqual({
      ok: false,
      reason: 'unreadable',
    });
  });

  it('BG-033 a link back to the folder it is in, or to a folder above it, is a loop: it ends and is left as a link', async () => {
    const { store, linked, reader } = await seed();
    await put(join(store, 'a', 'SKILL.md'), '# a\n');
    await mkdir(join(store, 'b'), { recursive: true });
    await symlink(join(store, 'a'), join(store, 'a', 'self')); // a/self -> a
    await symlink(join(store, 'b'), join(store, 'a', 'to-b')); // a/to-b -> b
    await symlink(join(store, 'a'), join(store, 'b', 'to-a')); // b/to-a -> a   (a -> b -> a)
    await mkdir(join(linked, 'skills'), { recursive: true });
    await symlink(join(store, 'a'), join(linked, 'skills', 'loop'));
    const tree = await reader(LINKED).skillTree('loop', { entries: 100, depth: 30 });
    expect(tree?.truncated).toBe(false);
    const byPath = new Map(tree?.entries.map(entry => [entry.path, entry.type]));
    expect(byPath.get('self')).toBe('symlink');
    expect(byPath.get('to-b/to-a')).toBe('symlink');
    expect([...byPath.keys()].some(path => path.split('/').length > 2)).toBe(false);
  });

  it('BG-033 a dangling link is skipped (not an error); a dangling document says so in one sentence', async () => {
    const { store, linked, reader } = await seed();
    await put(join(linked, 'skills', 'ok', 'SKILL.md'), '# ok\n');
    await symlink(join(store, 'missing'), join(linked, 'skills', 'gone'));
    await symlink(join(store, 'missing.md'), join(linked, 'skills', 'ok', 'gone.md'));
    await symlink(join(store, 'missing.json'), join(linked, 'settings.json'));
    expect((await reader(LINKED).skills(10)).map(skill => skill.name)).toEqual(['ok']);
    const tree = await reader(LINKED).skillTree('ok', { entries: 10, depth: 3 });
    expect(tree?.entries).toContainEqual({ path: 'gone.md', type: 'symlink', size: 0 });
    await expect(reader(LINKED).document('settings.json', 100)).rejects.toThrow(
      'settings.json is a link that is not followed (it leads nowhere, loops, is nested too deep, or leads to a place that is never read).',
    );
    expect(await reader(LINKED).skillFile('gone', 'SKILL.md', 100)).toEqual({ ok: false, reason: 'unreadable' });
  });

  it("BG-033 a link to a private place is never followed: the daemon's own home, a runtime home in the fleet, a sign-in file", async () => {
    const { world, store, linked, reader } = await seed();
    await put(join(world.home, 'state', 'secret.txt'), SECRET);
    await put(join(world.fleet, 'homes', 'someone', 'settings.json'), SECRET);
    await put(join(world.fleet, 'homes', 'someone', '.credentials.json'), SECRET);
    await put(join(world.person, '.codex', 'auth.json'), SECRET);
    await put(join(world.person, '.claude', '.credentials.json'), SECRET);
    await symlink(join(world.home, 'state', 'secret.txt'), join(linked, 'settings.json'));
    await symlink(join(world.fleet, 'homes', 'someone', 'settings.json'), join(linked, '.claude.json'));
    await symlink(join(world.person, '.codex', 'auth.json'), join(linked, 'config.toml'));
    await mkdir(join(linked, 'skills', 'inside'), { recursive: true });
    await symlink(join(world.home, 'state'), join(linked, 'skills', 'state'));
    await symlink(join(world.fleet, 'homes', 'someone'), join(linked, 'skills', 'someone'));
    await symlink(join(world.person, '.claude'), join(linked, 'skills', 'whole-home'));
    // Through the store too: a link in the store to the daemon's own home is the same refusal.
    await symlink(join(world.home, 'state', 'secret.txt'), join(store, 'hop.json'));
    await symlink(join(store, 'hop.json'), join(linked, 'skills', 'inside', 'SKILL.md'));
    await symlink(join(world.person, '.codex', 'auth.json'), join(linked, 'skills', 'inside', 'notes.md'));
    const found = reader(LINKED);
    for (const file of ['settings.json', '.claude.json', 'config.toml'] as const)
      await expect(found.document(file, 1000)).rejects.toThrow('is a link that is not followed');
    expect((await found.skills(10)).map(skill => skill.name)).toEqual(['inside', 'whole-home']);
    // The folder that IS followed (the person's own `.claude`) never lists or reads its sign-in file.
    const whole = await found.skillTree('whole-home', { entries: 10, depth: 3 });
    expect(JSON.stringify(whole)).not.toContain('credentials');
    expect(await found.skillFile('whole-home', '.credentials.json', 100)).toEqual({ ok: false, reason: 'unreadable' });
    expect(await found.skillFile('inside', 'SKILL.md', 100)).toEqual({ ok: false, reason: 'unreadable' });
    expect(await found.skillFile('inside', 'notes.md', 100)).toEqual({ ok: false, reason: 'unreadable' });
    expect(await found.skillManifest('inside', 100)).toBeUndefined();
    expect(await found.skillFile('state', 'secret.txt', 100)).toEqual({ ok: false, reason: 'unreadable' });
    expect(await found.skillFile('someone', 'settings.json', 100)).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('BG-033 the handle has no write member, and the root under it refuses a write through a link, leaving the target as it was', async () => {
    const { world, store, linked } = await seed();
    await put(join(store, 'settings.json'), 'as it was');
    await symlink(join(store, 'settings.json'), join(linked, 'settings.json'));
    const handle = followingHandle(world.roots, linked, linked);
    expect(Object.keys(handle).toSorted()).toEqual(['entries', 'readBytes', 'readText', 'resolve']);
    const reach = world.roots.root('harness-home', { subfolder: '/' });
    const at = reach.resolve(join(linked, 'settings.json'));
    if (!at.ok) throw new Error('the link did not resolve');
    await expect(reach.writeText(at.value, 'overwritten')).rejects.toThrow();
    await expect(reach.remove(at.value)).rejects.toThrow();
    expect(await readFile(join(store, 'settings.json'), 'utf8')).toBe('as it was');
    const folder = reach.resolve(linked);
    if (!folder.ok) throw new Error('the home did not resolve');
    expect((await reach.entries(folder.value)).map(entry => entry.name)).toContain('settings.json');
    // The link is still a link and the store file is still there after both refusals.
    expect(await readlink(join(linked, 'settings.json'))).toBe(join(store, 'settings.json'));
  });
});
