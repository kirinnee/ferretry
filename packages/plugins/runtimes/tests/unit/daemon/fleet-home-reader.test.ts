/**
 * The homes half of `RuntimesApi` over the kernel's REAL `fleet` root on a seeded temp fleet (never a real home): which
 * harness homes the manifest publishes, and the bounded reader of one. Every refusal here is the reader's own decision
 * on what a name IS (a link, a hard link, a non-regular file, an over-bound file), so a kernel that began to follow links
 * would not change a test's answer.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { chmod, link, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { RuntimeHomeUnreadable } from '../../../contract/index.ts';
import { fleetHomes } from '../../../daemon/adapters/fleet-home-reader.ts';
import { buildFleetManifest } from '../../../daemon/lib/manifest.ts';
import { FleetPublication } from '../../../daemon/lib/service/publication.ts';
import { cleanupWorlds, fleetWorld, type FleetWorld } from '../support/fleet-world.ts';

afterEach(cleanupWorlds);

const WORK = '00000000-0000-4000-8000-000000000001';
const SECOND = '00000000-0000-4000-8000-000000000002';
const OUTSIDE = '00000000-0000-4000-8000-000000000003';
const SECRET = 'SECRET-VALUE-THAT-MUST-NEVER-SURFACE';

const account = (
  world: FleetWorld,
  id: string,
  wrapper: string,
  home: string,
  kind: 'claude' | 'codex' = 'claude',
) => ({
  id,
  kind,
  mode: 'interactive' as const,
  wrapper: `${world.fleet}/bin/${wrapper}`,
  home,
  displayName: wrapper,
  defaultModel: 'm',
  models: [{ id: 'm', available: true as const }],
  available: true,
  unavailableReason: null,
});

const runtime = (world: FleetWorld, id: string, name: string, wrapper: string, harness: 'claude' | 'codex') => ({
  id,
  name,
  harness,
  credential: 'c',
  profile: 'p',
  agent: true,
  wrapper: `${world.fleet}/bin/${wrapper}`,
  models: [],
  defaultModel: null,
});

/** Publishes a manifest naming the homes the options list. */
async function publish(
  world: FleetWorld,
  options: { readonly second?: boolean; readonly outside?: boolean; readonly work?: boolean } = {},
): Promise<void> {
  const accounts = [
    ...(options.work === false ? [] : [account(world, WORK, 'claude-work', `${world.fleet}/homes/${WORK}`)]),
    ...(options.second === true
      ? [account(world, SECOND, 'codex-home', `${world.fleet}/homes/${SECOND}`, 'codex')]
      : []),
    // An operator's own folder is not a fleet home: it is not listed, and nothing reaches it.
    ...(options.outside === true ? [account(world, OUTSIDE, 'claude-away', `${world.person}/.claude-away`)] : []),
  ];
  const manifest = buildFleetManifest({
    generatedAt: '2027-01-15T08:00:00.000Z',
    accounts,
    runtimes: [
      ...(options.work === false ? [] : [runtime(world, WORK, 'claude-agent', 'claude-agent', 'claude')]),
      // Its wrapper is the account's own: the same name is listed once.
      ...(options.second === true ? [runtime(world, SECOND, 'codex-home', 'codex-home', 'codex')] : []),
    ],
  });
  await writeFile(join(world.fleet, 'manifest.json'), JSON.stringify(manifest));
}

const homeFolder = (world: FleetWorld, id = WORK): string => join(world.fleet, 'homes', id);

async function seed(options: { readonly second?: boolean; readonly outside?: boolean } = {}) {
  const world = await fleetWorld();
  await mkdir(homeFolder(world), { recursive: true });
  await mkdir(join(world.fleet, 'assets', 'skills', 'managed-skill'), { recursive: true });
  await writeFile(join(world.fleet, 'assets', 'skills', 'managed-skill', 'SKILL.md'), '# managed\n');
  await publish(world, options);
  const api = fleetHomes(world.roots, new FleetPublication());
  return { world, api };
}

async function reader(_world: FleetWorld, api: ReturnType<typeof fleetHomes>) {
  await api.homes();
  const found = api.home(WORK);
  if (found === undefined) throw new Error('the seeded home is not published');
  return found;
}

describe('R1 homes() reads fleet/manifest.json', () => {
  it('answers [] while no apply has published a manifest', async () => {
    const world = await fleetWorld();
    expect(await fleetHomes(world.roots, new FleetPublication()).homes()).toEqual([]);
  });

  it('lists each fleet home once, in manifest order, with its runtimes deduped and the display paths absolute', async () => {
    const { world, api } = await seed({ second: true });
    const homes = await api.homes();
    expect(homes.map(home => home.id)).toEqual([WORK, SECOND]);
    expect({ ...homes[0], runtimes: homes[0]?.runtimes.map(String) }).toEqual({
      id: WORK,
      harness: 'claude-code',
      runtimes: ['claude-work', 'claude-agent'],
      home: `${world.fleet}/homes/${WORK}`,
      wrapper: `${world.fleet}/bin/claude-work`,
    });
    expect(homes[1]?.harness).toBe('codex');
    expect(homes[1]?.runtimes.map(String)).toEqual(['codex-home']);
  });

  it('does not list a home an operator placed outside fleet/homes (nothing reaches it)', async () => {
    const { api } = await seed({ outside: true });
    expect((await api.homes()).map(home => home.id)).toEqual([WORK]);
  });
});

describe('R1 home(id) answers only an id homes() answers now', () => {
  it('answers undefined for an id homes() does not answer, and before homes() has been read', async () => {
    const { api } = await seed();
    expect(api.home(WORK)).toBeUndefined();
    await api.homes();
    expect(api.home(WORK)).toBeDefined();
    expect(api.home(SECOND)).toBeUndefined();
    expect(api.home('../fleet')).toBeUndefined();
  });

  it('refuses a home removed between two calls, and stops answering it once homes() is read again', async () => {
    const { world, api } = await seed();
    const home = await reader(world, api);
    await writeFile(join(homeFolder(world), 'settings.json'), '{}');
    expect(await home.document('settings.json', 100)).toBe('{}');
    await publish(world, { work: false, second: true });
    await expect(home.document('settings.json', 100)).rejects.toBeInstanceOf(RuntimeHomeUnreadable);
    await expect(home.skills(10)).rejects.toThrow('not published any more');
    expect(await home.skillManifest('managed-skill', 100)).toBeUndefined();
    expect(await home.skillFile('managed-skill', 'SKILL.md', 100)).toEqual({ ok: false, reason: 'unreadable' });
    await expect(home.skillTree('managed-skill', { entries: 10, depth: 4 })).rejects.toThrow('not published any more');
  });

  it('stops answering the id once homes() reads the manifest without it', async () => {
    const { world, api } = await seed();
    await api.homes();
    await publish(world, { work: false, second: true });
    await api.homes();
    expect(api.home(WORK)).toBeUndefined();
  });
});

describe('R1 document() serves exactly the three RuntimeHomeDocument names', () => {
  it('reads .claude.json, settings.json and config.toml, and answers null for one that is absent', async () => {
    const { world, api } = await seed();
    const home = await reader(world, api);
    await writeFile(join(homeFolder(world), '.claude.json'), '{"mcpServers":{}}');
    await writeFile(join(homeFolder(world), 'settings.json'), '{"a":1}');
    await writeFile(join(homeFolder(world), 'config.toml'), 'model = "m"\n');
    expect(await home.document('.claude.json', 1000)).toBe('{"mcpServers":{}}');
    expect(await home.document('settings.json', 1000)).toBe('{"a":1}');
    expect(await home.document('config.toml', 1000)).toBe('model = "m"\n');
  });

  it('answers null when the document is absent', async () => {
    const { world, api } = await seed();
    expect(await (await reader(world, api)).document('config.toml', 1000)).toBeNull();
  });

  it('does not address any other name: a credential file, a path, a parent and a near-miss are not served', async () => {
    const { world, api } = await seed();
    const home = await reader(world, api);
    await writeFile(join(homeFolder(world), '.credentials.json'), SECRET);
    await writeFile(join(world.fleet, 'manifest.json.bak'), SECRET);
    for (const name of [
      '.credentials.json',
      '../manifest.json',
      'skills/x/SKILL.md',
      'Settings.json',
      '',
      '/etc/passwd',
    ]) {
      const failure = await home.document(name as never, 1000).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(RuntimeHomeUnreadable);
      expect((failure as Error).message).not.toContain(SECRET);
    }
  });

  it('refuses a link, in or out of fleet/, and the message names no value and no target', async () => {
    const { world, api } = await seed();
    const home = await reader(world, api);
    await writeFile(join(world.parent, 'elsewhere.json'), SECRET);
    await symlink(join(world.parent, 'elsewhere.json'), join(homeFolder(world), 'settings.json'));
    await writeFile(join(homeFolder(world), 'real.json'), SECRET);
    await symlink(join(homeFolder(world), 'real.json'), join(homeFolder(world), '.claude.json'));
    for (const name of ['settings.json', '.claude.json'] as const) {
      const failure = await home.document(name, 1000).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(RuntimeHomeUnreadable);
      expect((failure as Error).message).toBe(`${name} is a link, which is never read.`);
    }
  });

  it('refuses a hard-linked file, a folder named like a document, and an over-bound file', async () => {
    const { world, api } = await seed();
    const home = await reader(world, api);
    await writeFile(join(world.parent, 'other-name.json'), SECRET);
    await link(join(world.parent, 'other-name.json'), join(homeFolder(world), 'settings.json'));
    await mkdir(join(homeFolder(world), 'config.toml'));
    await writeFile(join(homeFolder(world), '.claude.json'), 'x'.repeat(50));
    await expect(home.document('settings.json', 1000)).rejects.toThrow('has another name on this machine');
    await expect(home.document('config.toml', 1000)).rejects.toThrow('config.toml is not a regular file.');
    await expect(home.document('.claude.json', 49)).rejects.toThrow('is larger than the 49 bytes');
    expect(await home.document('.claude.json', 50)).toBe('x'.repeat(50));
  });

  it('refuses a bound that is not a positive whole number, and a document the host cannot open', async () => {
    const { world, api } = await seed();
    const home = await reader(world, api);
    await writeFile(join(homeFolder(world), 'settings.json'), '{}');
    await expect(home.document('settings.json', 0)).rejects.toThrow('needs a size bound of at least one byte');
    await expect(home.document('settings.json', 1.5)).rejects.toBeInstanceOf(RuntimeHomeUnreadable);
    await chmod(join(homeFolder(world), 'settings.json'), 0);
    await expect(home.document('settings.json', 100)).rejects.toThrow('settings.json could not be read (');
    await chmod(join(homeFolder(world), 'settings.json'), 0o600);
  });

  it('refuses a published home whose folder is not on the disk', async () => {
    const { api } = await seed({ second: true });
    await api.homes();
    const away = api.home(SECOND);
    expect(away).toBeDefined();
    await expect(away?.document('settings.json', 100)).rejects.toBeInstanceOf(RuntimeHomeUnreadable);
    await expect(away?.skills(5)).rejects.toThrow('could not be listed');
  });
});

describe('R1 skills() lists the folders of <home>/skills', () => {
  it('marks a link into the fleet assets managed and a plain folder not managed, in name order with absolute manifest paths', async () => {
    const { world, api } = await seed();
    const home = await reader(world, api);
    const skills = join(homeFolder(world), 'skills');
    await mkdir(join(skills, 'plain-skill'), { recursive: true });
    await symlink(join(world.fleet, 'assets', 'skills', 'managed-skill'), join(skills, 'managed-skill'));
    expect(await home.skills(10)).toEqual([
      {
        name: 'managed-skill',
        manifest: `${world.fleet}/homes/${WORK}/skills/managed-skill/SKILL.md`,
        managed: true,
      },
      { name: 'plain-skill', manifest: `${world.fleet}/homes/${WORK}/skills/plain-skill/SKILL.md`, managed: false },
    ]);
  });

  it('skips a link whose target leaves fleet/, a link that stays in fleet/ but not in assets/, a dangling link, a file and a dot-entry', async () => {
    const { world, api } = await seed();
    const home = await reader(world, api);
    const skills = join(homeFolder(world), 'skills');
    await mkdir(join(skills, 'kept'), { recursive: true });
    await mkdir(join(world.parent, 'outside-skill'), { recursive: true });
    await writeFile(join(world.parent, 'outside-skill', 'SKILL.md'), SECRET);
    await symlink(join(world.parent, 'outside-skill'), join(skills, 'leaves-fleet'));
    await mkdir(join(world.fleet, 'setup'), { recursive: true });
    await symlink(join(world.fleet, 'setup'), join(skills, 'fleet-but-not-assets'));
    await symlink(join(world.fleet, 'assets', 'skills', 'gone'), join(skills, 'dangling'));
    await symlink(join(world.fleet, 'assets', 'skills', 'managed-skill', 'SKILL.md'), join(skills, 'a-file-link'));
    await writeFile(join(skills, 'notes.md'), 'not a folder');
    await mkdir(join(skills, '.hidden'), { recursive: true });
    expect((await home.skills(10)).map(entry => entry.name)).toEqual(['kept']);
  });

  it('answers [] when the home has no skills folder, or its skills is not a folder', async () => {
    const { world, api } = await seed();
    const home = await reader(world, api);
    expect(await home.skills(10)).toEqual([]);
    await writeFile(join(homeFolder(world), 'skills'), 'a file');
    expect(await home.skills(10)).toEqual([]);
  });

  it('stops at limit + 1 so a caller can tell there are more', async () => {
    const { world, api } = await seed();
    const home = await reader(world, api);
    for (const name of ['a', 'b', 'c', 'd']) await mkdir(join(homeFolder(world), 'skills', name), { recursive: true });
    expect((await home.skills(2)).map(entry => entry.name)).toEqual(['a', 'b', 'c']);
    expect((await home.skills(4)).map(entry => entry.name)).toEqual(['a', 'b', 'c', 'd']);
    expect(await home.skills(0)).toHaveLength(1);
    await expect(home.skills(-1)).rejects.toThrow('needs a bound of zero or more');
  });
});

describe('R1 the skill reads cover listed folders only', () => {
  async function withSkills() {
    const { world, api } = await seed();
    const home = await reader(world, api);
    const skills = join(homeFolder(world), 'skills');
    await mkdir(join(skills, 'plain', 'docs', 'deep'), { recursive: true });
    await writeFile(join(skills, 'plain', 'SKILL.md'), '# plain\n');
    await writeFile(join(skills, 'plain', 'docs', 'a.md'), 'aaaa');
    await writeFile(join(skills, 'plain', 'docs', 'deep', 'b.md'), 'bb');
    await symlink(join(world.fleet, 'assets', 'skills', 'managed-skill'), join(skills, 'managed-skill'));
    // Outside the listed folders: a file the reader must never serve.
    await writeFile(join(homeFolder(world), 'private.txt'), SECRET);
    await writeFile(join(world.fleet, 'ids.json'), SECRET);
    return { world, home, skills };
  }

  it('reads SKILL.md of a plain folder and of a managed link, and of nothing unlisted', async () => {
    const { home } = await withSkills();
    expect(await home.skillManifest('plain', 100)).toBe('# plain\n');
    expect(await home.skillManifest('managed-skill', 100)).toBe('# managed\n');
    expect(await home.skillManifest('absent', 100)).toBeUndefined();
    expect(await home.skillManifest('.hidden', 100)).toBeUndefined();
    expect(await home.skillManifest('plain', 3)).toBeUndefined();
  });

  it('refuses skillFile of an unlisted folder or a ../ path', async () => {
    const { home, world, skills } = await withSkills();
    const unreadable = { ok: false, reason: 'unreadable' } as const;
    expect(await home.skillFile('not-listed', 'SKILL.md', 100)).toEqual(unreadable);
    expect(await home.skillFile('..', 'private.txt', 100)).toEqual(unreadable);
    expect(await home.skillFile('../skills/plain', 'SKILL.md', 100)).toEqual(unreadable);
    expect(await home.skillFile('plain', '../../private.txt', 100)).toEqual(unreadable);
    expect(await home.skillFile('plain', 'docs/../../../private.txt', 100)).toEqual(unreadable);
    expect(await home.skillFile('plain', '/etc/passwd', 100)).toEqual(unreadable);
    expect(await home.skillFile('plain', 'docs//a.md', 100)).toEqual(unreadable);
    expect(await home.skillFile('plain', './SKILL.md', 100)).toEqual(unreadable);
    expect(await home.skillFile('plain', 'docs\\a.md', 100)).toEqual(unreadable);
    expect(await home.skillFile('plain', '', 100)).toEqual(unreadable);
    // A folder that is a link leaving fleet/ or staying outside assets/ is not listed, so it is not readable either.
    await mkdir(join(world.parent, 'outside-skill'), { recursive: true });
    await writeFile(join(world.parent, 'outside-skill', 'SKILL.md'), SECRET);
    await symlink(join(world.parent, 'outside-skill'), join(skills, 'leaves-fleet'));
    await symlink(world.fleet, join(skills, 'whole-fleet'));
    expect(await home.skillFile('leaves-fleet', 'SKILL.md', 100)).toEqual(unreadable);
    expect(await home.skillFile('whole-fleet', 'ids.json', 100)).toEqual(unreadable);
    expect(await home.skillManifest('whole-fleet', 100)).toBeUndefined();
    expect(await home.skillTree('whole-fleet', { entries: 10, depth: 4 })).toBeUndefined();
  });

  it('reads a nested file, and answers too_big for one over the bound', async () => {
    const { home } = await withSkills();
    const read = await home.skillFile('plain', 'docs/a.md', 100);
    expect(read.ok && new TextDecoder().decode(read.bytes)).toBe('aaaa');
    expect(await home.skillFile('plain', 'docs/a.md', 3)).toEqual({ ok: false, reason: 'too_big' });
    expect(await home.skillFile('plain', 'docs/a.md', -1)).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('never follows a link inside a skill folder, a hard link, a folder as a file, or a file as a folder', async () => {
    const { home, world, skills } = await withSkills();
    const unreadable = { ok: false, reason: 'unreadable' } as const;
    await symlink(join(homeFolder(world), 'private.txt'), join(skills, 'plain', 'leak.md'));
    await symlink(join(world.fleet), join(skills, 'plain', 'linked-dir'));
    await link(join(homeFolder(world), 'private.txt'), join(skills, 'plain', 'hard.md'));
    expect(await home.skillFile('plain', 'leak.md', 100)).toEqual(unreadable);
    expect(await home.skillFile('plain', 'linked-dir/ids.json', 100)).toEqual(unreadable);
    expect(await home.skillFile('plain', 'hard.md', 100)).toEqual(unreadable);
    expect(await home.skillFile('plain', 'docs', 100)).toEqual(unreadable);
    expect(await home.skillFile('plain', 'SKILL.md/x', 100)).toEqual(unreadable);
    expect(await home.skillFile('plain', 'missing.md', 100)).toEqual(unreadable);
    expect(await home.skillManifest('plain', 100)).toBe('# plain\n');
  });

  it('reports a file the host cannot open as unreadable', async () => {
    const { home, skills } = await withSkills();
    await chmod(join(skills, 'plain', 'SKILL.md'), 0);
    expect(await home.skillFile('plain', 'SKILL.md', 100)).toEqual({ ok: false, reason: 'unreadable' });
    await chmod(join(skills, 'plain', 'SKILL.md'), 0o600);
  });

  it('walks a tree with each entry typed and never entered through a link', async () => {
    const { home, world, skills } = await withSkills();
    await symlink(join(homeFolder(world), 'private.txt'), join(skills, 'plain', 'leak.md'));
    await symlink(join(world.fleet), join(skills, 'plain', 'linked-dir'));
    await link(join(homeFolder(world), 'private.txt'), join(skills, 'plain', 'hard.md'));
    const listing = await home.skillTree('plain', { entries: 100, depth: 4 });
    expect(listing?.truncated).toBe(false);
    expect(listing?.entries).toEqual([
      { path: 'SKILL.md', type: 'file', size: 8 },
      { path: 'hard.md', type: 'hardlink', size: 0 },
      { path: 'leak.md', type: 'symlink', size: 0 },
      { path: 'linked-dir', type: 'symlink', size: 0 },
      { path: 'docs/a.md', type: 'file', size: 4 },
      { path: 'docs/deep/b.md', type: 'file', size: 2 },
    ]);
  });

  it('enforces the entry bound (truncated) and the depth bound (a deeper folder is listed as deep, not entered)', async () => {
    const { home } = await withSkills();
    const cut = await home.skillTree('plain', { entries: 3, depth: 4 });
    expect(cut?.truncated).toBe(true);
    expect(cut?.entries.length).toBeLessThanOrEqual(3);
    const shallow = await home.skillTree('plain', { entries: 100, depth: 2 });
    expect(shallow?.entries).toContainEqual({ path: 'docs/deep', type: 'deep', size: 0 });
    expect(shallow?.entries.map(entry => entry.path)).not.toContain('docs/deep/b.md');
    expect(await home.skillTree('plain', { entries: 0, depth: 2 })).toBeUndefined();
    expect(await home.skillTree('plain', { entries: 5, depth: 0 })).toBeUndefined();
    expect(await home.skillTree('plain', { entries: 1.5, depth: 2 })).toBeUndefined();
    expect(await home.skillTree('not-listed', { entries: 5, depth: 2 })).toBeUndefined();
  });

  it('walks a managed link folder, lists a folder it cannot open as other, and gives up on a root it cannot open', async () => {
    const { home, skills } = await withSkills();
    expect((await home.skillTree('managed-skill', { entries: 10, depth: 3 }))?.entries).toEqual([
      { path: 'SKILL.md', type: 'file', size: 10 },
    ]);
    await mkdir(join(skills, 'plain', 'locked'));
    await chmod(join(skills, 'plain', 'locked'), 0);
    const partial = await home.skillTree('plain', { entries: 100, depth: 4 });
    expect(partial?.entries).toContainEqual({ path: 'locked', type: 'other', size: 0 });
    await chmod(join(skills, 'plain', 'locked'), 0o700);
    await chmod(join(skills, 'plain'), 0);
    expect(await home.skillTree('plain', { entries: 100, depth: 4 })).toBeUndefined();
    await chmod(join(skills, 'plain'), 0o700);
  });

  it('types a socket-like entry as other', async () => {
    const { home, skills } = await withSkills();
    const { createServer } = await import('node:net');
    const server = createServer();
    await new Promise<void>(resolve => server.listen(join(skills, 'plain', 'sock'), resolve));
    try {
      const listing = await home.skillTree('plain', { entries: 100, depth: 4 });
      expect(listing?.entries).toContainEqual({ path: 'sock', type: 'other', size: 0 });
    } finally {
      server.close();
    }
  });
});
