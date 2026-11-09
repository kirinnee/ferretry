/**
 * BG-033: the SKILLS of an account home outside the fleet follow a link ONLY when it resolves INSIDE that home, read-only
 * (a link out of the home is skipped silently); its three documents follow a link out (see `document-link.test.ts`). Real
 * kernel roots over a temp world; `store` is a folder OUTSIDE every home, standing in for a place the links of a
 * home-manager home lead to.
 *
 *   <parent>/store           a place outside every account home
 *   <parent>/person/<home>   the account homes outside the fleet
 *   <parent>/fy-home         the daemon's own home (the fence): fleet/, state/
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, readFile, readlink, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RuntimeHomeReader } from '../../../contract/index.ts';
import { fleetHomes } from '../../../daemon/adapters/fleet-home-reader.ts';
import { followingHandle } from '../../../daemon/adapters/following-handle.ts';
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

describe('BG-033 an outside account home follows a link only when it resolves inside the home', () => {
  it('BG-033 a link to a store-like folder OUTSIDE the home is skipped: not listed, not read, no error line (skills)', async () => {
    const { store, linked, reader } = await seed();
    await content(store);
    await put(join(store, 'loose', 'SKILL.md'), '# loose\n');
    // The home-manager shape: the whole `skills/` folder is a link out.
    await symlink(join(store, 'skills'), join(linked, 'skills'));
    expect(await reader(LINKED).skills(50)).toEqual([]);
    expect(await reader(LINKED).skillManifest('alpha', 100)).toBeUndefined();
    expect(await reader(LINKED).skillTree('alpha', { entries: 10, depth: 3 })).toBeUndefined();
    expect(await reader(LINKED).skillFile('alpha', 'SKILL.md', 100)).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('BG-033 a skill folder that is a link out, and a real skill folder whose SKILL.md is a link out, are skipped; the plain skill beside them is listed', async () => {
    const { store, linked, reader } = await seed();
    await content(store);
    await put(join(linked, 'skills', 'real', 'SKILL.md'), '# real\n');
    await symlink(join(store, 'skills', 'alpha'), join(linked, 'skills', 'out-folder'));
    await mkdir(join(linked, 'skills', 'out-manifest'), { recursive: true });
    await symlink(join(store, 'skills', 'beta', 'SKILL.md'), join(linked, 'skills', 'out-manifest', 'SKILL.md'));
    // Not one line, not one error: the listing is exactly the skills inside the home.
    expect((await reader(LINKED).skills(50)).map(skill => skill.name)).toEqual(['real']);
    expect(await reader(LINKED).skillManifest('out-manifest', 100)).toBeUndefined();
    expect(await reader(LINKED).skillManifest('out-folder', 100)).toBeUndefined();
  });

  it('BG-033 a document that is a link out of the home (a store) is followed and read: the home-manager home keeps its MCP servers and approvals', async () => {
    const { store, linked, reader } = await seed();
    await content(store);
    for (const file of ['settings.json', '.claude.json', 'config.toml'])
      await symlink(join(store, file), join(linked, file));
    expect(await reader(LINKED).document('settings.json', 1000)).toBe('{"permissions":{}}');
    expect(await reader(LINKED).document('.claude.json', 1000)).toBe('{"mcpServers":{"a":{}}}');
    expect(await reader(LINKED).document('config.toml', 1000)).toBe('model = "m"\n');
    // Only the three documents follow out: the skills of the same home do not.
    await symlink(join(store, 'skills'), join(linked, 'skills'));
    expect(await reader(LINKED).skills(50)).toEqual([]);
  });

  it('BG-033 a link that resolves INSIDE the home is followed, and the home reads exactly like the same plain home', async () => {
    const { linked, plain, reader } = await seed();
    await content(plain);
    // Everything lives in `.shared` inside the home; the home itself is made of links to it.
    await content(join(linked, '.shared'));
    await symlink(join(linked, '.shared', 'skills'), join(linked, 'skills'));
    for (const file of ['settings.json', '.claude.json', 'config.toml'])
      await symlink(join(linked, '.shared', file), join(linked, file));
    const expected = await everything(reader(PLAIN), plain);
    expect(expected.skills.map(skill => skill.name)).toEqual(['alpha', 'beta']);
    expect(expected.settings).toBe('{"permissions":{}}');
    expect(await everything(reader(LINKED), linked)).toEqual(expected);
  });

  it('BG-033 skill folders that are links inside the home are followed (a real `skills/` of links), identical to plain ones', async () => {
    const { linked, plain, reader } = await seed();
    await content(plain);
    await content(join(linked, '.shared'));
    await mkdir(join(linked, 'skills'), { recursive: true });
    for (const name of ['alpha', 'beta'])
      await symlink(join(linked, '.shared', 'skills', name), join(linked, 'skills', name));
    for (const file of ['settings.json', '.claude.json', 'config.toml'])
      await symlink(join(linked, '.shared', file), join(linked, file));
    expect(await everything(reader(LINKED), linked)).toEqual(await everything(reader(PLAIN), plain));
  });

  it('BG-033 inside links chained (a -> b -> c -> folder) are followed; a chain longer than the system allows is skipped', async () => {
    const { linked, reader } = await seed();
    await put(join(linked, 'real', 'SKILL.md'), '# real\n');
    await mkdir(join(linked, 'skills'), { recursive: true });
    await symlink(join(linked, 'real'), join(linked, 'c'));
    await symlink(join(linked, 'c'), join(linked, 'b'));
    await symlink(join(linked, 'b'), join(linked, 'skills', 'chained'));
    // 60 links, one to the next: more than the operating system resolves.
    await symlink(join(linked, 'real'), join(linked, 'n0'));
    for (let index = 1; index < 60; index += 1) await symlink(join(linked, `n${index - 1}`), join(linked, `n${index}`));
    await symlink(join(linked, 'n59'), join(linked, 'skills', 'too-long'));
    expect((await reader(LINKED).skills(50)).map(skill => skill.name)).toEqual(['chained']);
    expect(await reader(LINKED).skillManifest('chained', 100)).toBe('# real\n');
  });

  it('BG-033 a link back to the folder it is in or to one above it is a loop and is skipped; so are mutual and self links', async () => {
    const { linked, reader } = await seed();
    await put(join(linked, 'skills', 'SKILL.md'), '# the folder holds a manifest, so a link to it would be listed\n');
    await put(join(linked, 'skills', 'ok', 'SKILL.md'), '# ok\n');
    await symlink(join(linked, 'skills'), join(linked, 'skills', 'self')); // skills/self -> skills
    await symlink(linked, join(linked, 'skills', 'whole-home')); // skills/whole-home -> the home
    await symlink(join(linked, 'skills', 'm2'), join(linked, 'skills', 'm1')); // m1 -> m2 -> m1
    await symlink(join(linked, 'skills', 'm1'), join(linked, 'skills', 'm2'));
    await symlink(join(linked, 'skills', 'me'), join(linked, 'skills', 'me')); // me -> me
    expect((await reader(LINKED).skills(50)).map(skill => skill.name)).toEqual(['ok']);
  });

  it('BG-033 a dangling link is skipped (not an error); a dangling document is absent, as a document that is not there', async () => {
    const { linked, reader } = await seed();
    await put(join(linked, 'skills', 'ok', 'SKILL.md'), '# ok\n');
    await symlink(join(linked, 'missing'), join(linked, 'skills', 'gone'));
    await symlink(join(linked, 'missing.md'), join(linked, 'skills', 'ok', 'gone.md'));
    await symlink(join(linked, 'missing.json'), join(linked, 'settings.json'));
    expect((await reader(LINKED).skills(10)).map(skill => skill.name)).toEqual(['ok']);
    const tree = await reader(LINKED).skillTree('ok', { entries: 10, depth: 3 });
    expect(tree?.entries).toContainEqual({ path: 'gone.md', type: 'symlink', size: 0 });
    expect(await reader(LINKED).document('settings.json', 100)).toBeNull();
    expect(await reader(LINKED).skillFile('gone', 'SKILL.md', 100)).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('BG-033 inside a skill folder no link is followed: a link there is a link (tree) and unreadable (file), inside the home or not', async () => {
    const { store, linked, reader } = await seed();
    await put(join(linked, 'keep', 'notes.md'), 'notes');
    await put(join(store, 'out.md'), 'out');
    await put(join(linked, 'skills', 'alpha', 'SKILL.md'), '# alpha\n');
    await symlink(join(linked, 'keep', 'notes.md'), join(linked, 'skills', 'alpha', 'inside.md'));
    await symlink(join(linked, 'keep'), join(linked, 'skills', 'alpha', 'folder'));
    await symlink(join(store, 'out.md'), join(linked, 'skills', 'alpha', 'outside.md'));
    const tree = await reader(LINKED).skillTree('alpha', { entries: 10, depth: 3 });
    expect(tree?.entries.toSorted((left, right) => (left.path < right.path ? -1 : 1))).toEqual([
      { path: 'SKILL.md', type: 'file', size: 8 },
      { path: 'folder', type: 'symlink', size: 0 },
      { path: 'inside.md', type: 'symlink', size: 0 },
      { path: 'outside.md', type: 'symlink', size: 0 },
    ]);
    for (const file of ['inside.md', 'outside.md', 'folder/notes.md'])
      expect(await reader(LINKED).skillFile('alpha', file, 100)).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('BG-033 a SKILL.md that is a link to a file inside the home lists and reads (the inventory read it through one)', async () => {
    const { linked, reader } = await seed();
    await put(join(linked, 'shared', 'manifest.md'), '# via link\n');
    await mkdir(join(linked, 'skills', 'alpha'), { recursive: true });
    await symlink(join(linked, 'shared', 'manifest.md'), join(linked, 'skills', 'alpha', 'SKILL.md'));
    expect((await reader(LINKED).skills(10)).map(skill => skill.name)).toEqual(['alpha']);
    expect(await reader(LINKED).skillManifest('alpha', 100)).toBe('# via link\n');
    expect(await reader(LINKED).skillFile('alpha', 'SKILL.md', 100)).toEqual({ ok: false, reason: 'unreadable' });
  });

  it("BG-033 a link to a private place is never followed: the daemon's own home, a runtime home in the fleet, a sign-in file inside the home", async () => {
    const { world, linked, reader } = await seed();
    await put(join(world.home, 'state', 'secret.txt'), SECRET);
    await put(join(world.fleet, 'homes', 'someone', 'settings.json'), SECRET);
    await put(join(linked, '.credentials.json'), SECRET);
    await put(join(linked, 'auth.json'), SECRET);
    await put(join(linked, 'nested', '.credentials.json'), SECRET);
    await put(join(linked, 'nested', 'SKILL.md'), '# nested\n');
    await symlink(join(world.home, 'state', 'secret.txt'), join(linked, 'settings.json'));
    await symlink(join(world.fleet, 'homes', 'someone', 'settings.json'), join(linked, '.claude.json'));
    await symlink(join(linked, 'auth.json'), join(linked, 'config.toml')); // inside the home, but a sign-in file
    await mkdir(join(linked, 'skills'), { recursive: true });
    await symlink(join(world.home, 'state'), join(linked, 'skills', 'state'));
    await symlink(join(world.fleet, 'homes', 'someone'), join(linked, 'skills', 'someone'));
    await symlink(join(linked, 'nested'), join(linked, 'skills', 'nested'));
    await symlink(join(linked, '.credentials.json'), join(linked, 'skills', 'creds'));
    const found = reader(LINKED);
    for (const file of ['settings.json', '.claude.json', 'config.toml'] as const)
      await expect(found.document(file, 1000)).rejects.toThrow(`${file} is a link whose target is not read`);
    expect((await found.skills(10)).map(skill => skill.name)).toEqual(['nested']);
    // The folder that IS followed never lists or reads its sign-in file.
    const nested = await found.skillTree('nested', { entries: 10, depth: 3 });
    expect(JSON.stringify(nested)).not.toContain('credentials');
    expect(await found.skillFile('nested', '.credentials.json', 100)).toEqual({ ok: false, reason: 'unreadable' });
    expect(await found.skillFile('state', 'secret.txt', 100)).toEqual({ ok: false, reason: 'unreadable' });
    expect(await found.skillFile('someone', 'settings.json', 100)).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('BG-033 the handle has no write member, and the root under it refuses a write through a link, leaving the target as it was', async () => {
    const { world, linked } = await seed();
    await put(join(linked, 'shared', 'settings.json'), 'as it was');
    await symlink(join(linked, 'shared', 'settings.json'), join(linked, 'settings.json'));
    const handle = followingHandle(world.roots, linked, linked, true);
    expect(Object.keys(handle).toSorted()).toEqual(['entries', 'readBytes', 'readText', 'resolve']);
    const reach = world.roots.root('harness-home', { subfolder: linked });
    const at = reach.resolve(join(linked, 'settings.json'));
    if (!at.ok) throw new Error('the link did not resolve');
    await expect(reach.writeText(at.value, 'overwritten')).rejects.toThrow();
    await expect(reach.remove(at.value)).rejects.toThrow();
    expect(await readFile(join(linked, 'shared', 'settings.json'), 'utf8')).toBe('as it was');
    // The link is still a link and the target is still there after both refusals.
    expect(await readlink(join(linked, 'settings.json'))).toBe(join(linked, 'shared', 'settings.json'));
  });
});
