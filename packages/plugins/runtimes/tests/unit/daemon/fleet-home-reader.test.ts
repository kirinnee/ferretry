/**
 * The homes half of `RuntimesApi` over the kernel's REAL `fleet` root on a seeded temp fleet (never a real home): which
 * harness homes the manifest publishes, and the bounded reader of one. Every refusal here is the reader's own decision
 * on what a name IS (a link, a hard link, a non-regular file, an over-bound file), so a kernel that began to follow links
 * would not change a test's answer.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { chmod, link, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RootHandle, RootsPort } from '@ferretry/kernel/contract';
import { nodeFs } from '../../../../../core/kernel/host/adapters/node-fs.ts';
import { rootsPortFor } from '../../../../../core/kernel/host/roots.ts';
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
  options: {
    readonly second?: boolean;
    readonly outside?: boolean;
    readonly work?: boolean;
    readonly extra?: readonly ReturnType<typeof account>[];
  } = {},
): Promise<void> {
  const accounts = [
    ...(options.work === false ? [] : [account(world, WORK, 'claude-work', `${world.fleet}/homes/${WORK}`)]),
    ...(options.second === true
      ? [account(world, SECOND, 'codex-home', `${world.fleet}/homes/${SECOND}`, 'codex')]
      : []),
    // An operator's own folder is served read-only through the `harness-home` root.
    ...(options.outside === true ? [account(world, OUTSIDE, 'claude-away', `${world.person}/.claude-away`)] : []),
    ...(options.extra ?? []),
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

  it('lists a home an operator placed outside fleet/homes, under its account id, and none that is not a plain folder away from the fleet', async () => {
    const { world, api } = await seed({ outside: true });
    expect((await api.homes()).map(home => [home.id, home.home])).toEqual([
      [WORK, `${world.fleet}/homes/${WORK}`],
      [OUTSIDE, `${world.person}/.claude-away`],
    ]);
    const homes = [
      'relative/home',
      `${world.person}/../escape`,
      `${world.fleet}/setup`,
      world.fleet,
      // The Ferretry home and everything under it is the kernel's own: every read of it would be refused.
      world.home,
      `${world.home}/state/x`,
      `${world.person}/a\\b`,
    ];
    await publish(world, {
      extra: homes.map((home, index) =>
        account(world, `00000000-0000-4000-8000-00000000009${index}`, `claude-bad${index}`, home),
      ),
    });
    expect((await api.homes()).map(home => home.id)).toEqual([WORK]);
  });

  it('serves an id one folder only: an outside account whose id is a fleet home folder name is not listed', async () => {
    const { world, api } = await seed();
    // The first account's home folder is `homes/<SECOND>`; the second account's ID is <SECOND> but its folder is elsewhere.
    await publish(world, {
      work: false,
      extra: [
        account(world, WORK, 'claude-first', `${world.fleet}/homes/${SECOND}`),
        account(world, SECOND, 'claude-dup', `${world.person}/.claude-dup`),
      ],
    });
    expect((await api.homes()).map(home => [home.id, home.home])).toEqual([[SECOND, `${world.fleet}/homes/${SECOND}`]]);
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
    // `leak.md` links to a file with ONE name in the same folder: the kernel would follow it, so only the reader refuses.
    await writeFile(join(skills, 'plain', 'other.txt'), SECRET);
    await symlink(join(skills, 'plain', 'other.txt'), join(skills, 'plain', 'leak.md'));
    await symlink(join(world.fleet), join(skills, 'plain', 'linked-dir'));
    await link(join(homeFolder(world), 'private.txt'), join(skills, 'plain', 'hard.md'));
    expect(await home.skillFile('plain', 'other.txt', 100)).toEqual({
      ok: true,
      bytes: new TextEncoder().encode(SECRET),
    });
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

  it('refuses a leaf link inside a managed asset folder (to fleet/ids.json) and lists it as a link', async () => {
    const { home, world } = await withSkills();
    await symlink(join(world.fleet, 'ids.json'), join(world.fleet, 'assets', 'skills', 'managed-skill', 'leak.md'));
    expect(await home.skillFile('managed-skill', 'leak.md', 100)).toEqual({ ok: false, reason: 'unreadable' });
    expect((await home.skillTree('managed-skill', { entries: 10, depth: 3 }))?.entries).toContainEqual({
      path: 'leak.md',
      type: 'symlink',
      size: 0,
    });
  });

  it('opens no root at all for a path the reader refuses itself (an empty, ., .. or backslash segment)', async () => {
    const { world } = await seed();
    await mkdir(join(homeFolder(world), 'skills', 'plain'), { recursive: true });
    await writeFile(join(homeFolder(world), 'skills', 'plain', 'SKILL.md'), '# plain\n');
    const opened: string[] = [];
    const watching: Pick<RootsPort, 'root'> = {
      root: (name, scope) => {
        opened.push(`${name}:${scope?.subfolder ?? ''}`);
        return world.roots.root(name, scope);
      },
    };
    const api = fleetHomes(watching, new FleetPublication());
    await api.homes();
    const home = api.home(WORK);
    opened.length = 0;
    for (const bad of ['../x', 'a/../x', './x', 'a//x', '', 'a\\x', '..'])
      expect(await home?.skillFile('plain', bad, 100)).toEqual({ ok: false, reason: 'unreadable' });
    expect(opened).toEqual([]);
    expect((await home?.skillFile('plain', 'SKILL.md', 100))?.ok).toBe(true);
    expect(opened.length).toBeGreaterThan(0);
  });
});

/** Roots whose handles swap `victim` for a link to `target` just before the first readBytes (a link swapped in after the listing). */
function racing(roots: RootsPort, victim: string, target: string): Pick<RootsPort, 'root'> {
  let swapped = false;
  return {
    root: (name, scope) => {
      const real = roots.root(name, scope);
      return new Proxy(real, {
        get(on, key) {
          const value = Reflect.get(on, key) as unknown;
          if (key !== 'readBytes') return typeof value === 'function' ? value.bind(on) : value;
          return async (...args: Parameters<RootHandle['readBytes']>) => {
            if (!swapped) {
              swapped = true;
              await rm(victim);
              await symlink(target, victim);
            }
            return await on.readBytes(...args);
          };
        },
      });
    },
  };
}

describe('R1 M1 a link swapped in between the listing and the read is refused and no byte leaves', () => {
  const OTHER_CLAUDE = 'OTHER-HOME-CLAUDE-JSON';

  async function racingWorld() {
    const { world } = await seed({ second: true });
    const skills = join(homeFolder(world), 'skills');
    const asset = join(world.fleet, 'assets', 'skills', 'managed-skill');
    await mkdir(join(skills, 'plain'), { recursive: true });
    await writeFile(join(skills, 'plain', 'SKILL.md'), 'y'.repeat(64));
    await symlink(asset, join(skills, 'managed-skill'));
    await writeFile(join(asset, 'SKILL.md'), 'x'.repeat(64));
    await mkdir(homeFolder(world, SECOND), { recursive: true });
    await writeFile(join(homeFolder(world, SECOND), '.claude.json'), OTHER_CLAUDE);
    await writeFile(join(homeFolder(world), '.claude.json'), 'SAME-HOME-CLAUDE-JSON');
    return { world, skills, asset };
  }

  async function raced(world: FleetWorld, victim: string, target: string, name: string) {
    const api = fleetHomes(racing(world.roots, victim, target), new FleetPublication());
    await api.homes();
    return await api.home(WORK)?.skillFile(name, 'SKILL.md', 100);
  }

  it('a managed skill file swapped for a link to another home is unreadable', async () => {
    const { world, asset } = await racingWorld();
    const read = await raced(
      world,
      join(asset, 'SKILL.md'),
      join(homeFolder(world, SECOND), '.claude.json'),
      'managed-skill',
    );
    expect(read).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('a managed skill file swapped for a link to fleet/ids.json is unreadable', async () => {
    const { world, asset } = await racingWorld();
    await writeFile(join(world.fleet, 'ids.json'), SECRET);
    expect(await raced(world, join(asset, 'SKILL.md'), join(world.fleet, 'ids.json'), 'managed-skill')).toEqual({
      ok: false,
      reason: 'unreadable',
    });
  });

  it("a plain skill file swapped for a link to another home's file, or to its own home's .claude.json, is unreadable", async () => {
    const { world, skills } = await racingWorld();
    const victim = join(skills, 'plain', 'SKILL.md');
    expect(await raced(world, victim, join(homeFolder(world, SECOND), '.claude.json'), 'plain')).toEqual({
      ok: false,
      reason: 'unreadable',
    });
    await rm(victim);
    await writeFile(victim, 'y'.repeat(64));
    expect(await raced(world, victim, join(homeFolder(world), '.claude.json'), 'plain')).toEqual({
      ok: false,
      reason: 'unreadable',
    });
  });
});

describe('R1 m2 a FY_HOME reached through a link still shows its managed skills', () => {
  it('compares the resolved link target with the RESOLVED fleet folder', async () => {
    const world = await fleetWorld();
    const through = join(world.parent, 'linked-home');
    await symlink(world.home, through);
    const roots = rootsPortFor(
      nodeFs(() => crypto.randomUUID()),
      { home: through, plugin: 'runtimes', worktrees: join(world.parent, 'worktrees') },
      ['fleet', 'harness-home'],
      () => undefined,
      { harnessFiles: ['.claude.json'], setMode: true },
    );
    const base = roots.root('fleet').resolve('.');
    if (!base.ok) throw new Error('the fleet root did not open');
    const named = base.value.endsWith('/.') ? base.value.slice(0, -2) : base.value;
    // The root names the fleet folder through the link, not by its real path: that is the case this proves.
    expect(named.startsWith(through)).toBe(true);
    const asset = join(world.fleet, 'assets', 'skills', 'managed-skill');
    await mkdir(asset, { recursive: true });
    await writeFile(join(asset, 'SKILL.md'), '# managed\n');
    await mkdir(join(world.fleet, 'homes', WORK, 'skills'), { recursive: true });
    await symlink(asset, join(world.fleet, 'homes', WORK, 'skills', 'managed-skill'));
    await writeFile(
      join(world.fleet, 'manifest.json'),
      JSON.stringify(
        buildFleetManifest({
          generatedAt: '2027-01-15T08:00:00.000Z',
          accounts: [account(world, WORK, 'claude-work', `${named}/homes/${WORK}`)],
          runtimes: [],
        }),
      ),
    );
    const api = fleetHomes(roots, new FleetPublication());
    await api.homes();
    const home = api.home(WORK);
    expect((await home?.skills(10))?.map(entry => [entry.name, entry.managed])).toEqual([['managed-skill', true]]);
    expect(await home?.skillManifest('managed-skill', 100)).toBe('# managed\n');
  });
});

describe('R1 m3 every read runs whole inside ONE publication.reading, the manifest read ungated inside it', () => {
  it('waits for an apply in flight, then answers', async () => {
    const { world } = await seed();
    await writeFile(join(homeFolder(world), 'settings.json'), '{}');
    const publication = new FleetPublication();
    const api = fleetHomes(world.roots, publication);
    await api.homes();
    let release: () => void = () => undefined;
    const apply = publication.publishing(
      async () =>
        await new Promise<void>(resolve => {
          release = resolve;
        }),
    );
    let answered = false;
    const read = api
      .home(WORK)
      ?.document('settings.json', 100)
      .then(text => {
        answered = true;
        return text;
      });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(answered).toBe(false);
    release();
    await apply;
    expect(await read).toBe('{}');
  });

  it('takes the gate once per call and never nests it', async () => {
    const { world } = await seed();
    await writeFile(join(homeFolder(world), 'settings.json'), '{}');
    await mkdir(join(homeFolder(world), 'skills', 'plain'), { recursive: true });
    await writeFile(join(homeFolder(world), 'skills', 'plain', 'SKILL.md'), '# plain\n');
    const inner = new FleetPublication();
    let depth = 0;
    let deepest = 0;
    let taken = 0;
    const publication: Pick<FleetPublication, 'reading'> = {
      reading: async read => {
        taken += 1;
        depth += 1;
        deepest = Math.max(deepest, depth);
        try {
          return await inner.reading(read);
        } finally {
          depth -= 1;
        }
      },
    };
    const api = fleetHomes(world.roots, publication);
    await api.homes();
    const home = api.home(WORK);
    const calls: readonly (() => Promise<unknown> | undefined)[] = [
      () => api.homes(),
      () => home?.document('settings.json', 100),
      () => home?.skills(5),
      () => home?.skillManifest('plain', 100),
      () => home?.skillFile('plain', 'SKILL.md', 100),
      () => home?.skillTree('plain', { entries: 5, depth: 2 }),
    ];
    for (const call of calls) {
      taken = 0;
      await call();
      expect(taken).toBe(1);
    }
    expect(deepest).toBe(1);
  });
});

describe('R1 m5 every escape is typed', () => {
  it('names the manifest path, and no content, when the manifest is damaged', async () => {
    const { world, api } = await seed();
    const home = await reader(world, api);
    await mkdir(join(homeFolder(world), 'skills', 'plain'), { recursive: true });
    await writeFile(join(world.fleet, 'manifest.json'), `{"not":"a manifest ${SECRET}`);
    const path = `${world.fleet}/manifest.json`;
    const failures = await Promise.all(
      [
        () => api.homes(),
        () => home.document('settings.json', 100),
        () => home.skills(5),
        () => home.skillTree('plain', { entries: 5, depth: 2 }),
      ].map(call =>
        call().then(
          () => undefined,
          (error: unknown) => error as Error,
        ),
      ),
    );
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(RuntimeHomeUnreadable);
      expect(failure?.message).toBe(`The fleet manifest at ${path} could not be read.`);
    }
    expect(await home.skillManifest('plain', 100)).toBeUndefined();
    expect(await home.skillFile('plain', 'SKILL.md', 100)).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('refuses a manifest over the byte bound, naming the path and no content', async () => {
    const { world, api } = await seed();
    await writeFile(join(world.fleet, 'manifest.json'), `{"pad":"${'x'.repeat(4 * 1024 * 1024)}"}`);
    await expect(api.homes()).rejects.toThrow(`The fleet manifest at ${world.fleet}/manifest.json could not be read.`);
  });

  it('maps a kernel refusal while skillTree lists skills/ to RuntimeHomeUnreadable', async () => {
    const { world, api } = await seed();
    const home = await reader(world, api);
    await mkdir(join(homeFolder(world), 'skills', 'plain'), { recursive: true });
    await chmod(join(homeFolder(world), 'skills'), 0);
    const failure = await home.skillTree('plain', { entries: 5, depth: 2 }).then(
      () => undefined,
      (error: unknown) => error,
    );
    await chmod(join(homeFolder(world), 'skills'), 0o700);
    expect(failure).toBeInstanceOf(RuntimeHomeUnreadable);
    expect((failure as Error).message).toContain('That skill folder could not be listed (');
  });
});

describe('R1 m4 a home the manifest places outside fleet/homes is served read-only through harness-home', () => {
  async function away() {
    const { world, api } = await seed({ outside: true });
    const folder = join(world.person, '.claude-away');
    await mkdir(join(folder, 'skills', 'plain'), { recursive: true });
    await writeFile(join(folder, 'skills', 'plain', 'SKILL.md'), '# away\n');
    await writeFile(join(folder, 'settings.json'), '{"away":true}');
    await api.homes();
    const home = api.home(OUTSIDE);
    if (home === undefined) throw new Error('the outside home is not published');
    return { world, folder, home };
  }

  it('lists it, reads its three documents and its skills, and bounds them like a fleet home', async () => {
    const { world, folder, home } = await away();
    expect(await home.document('settings.json', 100)).toBe('{"away":true}');
    expect(await home.document('config.toml', 100)).toBeNull();
    await expect(home.document('settings.json', 3)).rejects.toThrow('is larger than the 3 bytes');
    expect(await home.skills(10)).toEqual([
      { name: 'plain', manifest: `${world.person}/.claude-away/skills/plain/SKILL.md`, managed: false },
    ]);
    expect(await home.skillManifest('plain', 100)).toBe('# away\n');
    expect((await home.skillTree('plain', { entries: 10, depth: 2 }))?.entries).toEqual([
      { path: 'SKILL.md', type: 'file', size: 7 },
    ]);
    expect(await home.skillManifest('plain', 3)).toBeUndefined();
    await writeFile(join(folder, 'skills', 'plain', 'a.md'), 'aa');
    expect(await home.skillFile('plain', 'a.md', 100)).toEqual({ ok: true, bytes: new TextEncoder().encode('aa') });
  });

  it('refuses a link out of it (a document, a skill folder, and a file inside a skill) and skips every link in skills/', async () => {
    const { world, folder, home } = await away();
    await writeFile(join(world.parent, 'elsewhere.json'), SECRET);
    await symlink(join(world.parent, 'elsewhere.json'), join(folder, '.claude.json'));
    await expect(home.document('.claude.json', 100)).rejects.toThrow('.claude.json is a link, which is never read.');
    await mkdir(join(world.parent, 'outside-skill'), { recursive: true });
    await writeFile(join(world.parent, 'outside-skill', 'SKILL.md'), SECRET);
    await symlink(join(world.parent, 'outside-skill'), join(folder, 'skills', 'leaves'));
    // Even a link into the fleet's assets is not followed out of an operator's folder.
    await symlink(join(world.fleet, 'assets', 'skills', 'managed-skill'), join(folder, 'skills', 'managed-skill'));
    await symlink(join(world.parent, 'elsewhere.json'), join(folder, 'skills', 'plain', 'leak.md'));
    expect((await home.skills(10)).map(entry => entry.name)).toEqual(['plain']);
    expect(await home.skillFile('leaves', 'SKILL.md', 100)).toEqual({ ok: false, reason: 'unreadable' });
    expect(await home.skillFile('managed-skill', 'SKILL.md', 100)).toEqual({ ok: false, reason: 'unreadable' });
    expect(await home.skillFile('plain', 'leak.md', 100)).toEqual({ ok: false, reason: 'unreadable' });
  });
});
