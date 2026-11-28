/**
 * SIT for runtimes plan U2b, fix round: ONE ownership principle for everything in a runtime home.
 *
 * Ferretry removes or replaces an entry only when the entry captured at that moment is provably the one it wrote: the
 * record of THIS runtime names the exact path, and the entry still matches what was recorded (a file: the same hash; a
 * link: the same stamp; a folder: written by Ferretry). Anything else is kept word for word and named as skipped.
 *
 * Each case below was reproduced against the first head of the PR (red) and holds after the fix (green). They run the
 * real materialiser into the real provisioner over temporary directories, on a machine with BOTH a Claude and a Codex
 * runtime, because the person's homes are shared and a name is only ever one runtime's. Nothing of a real home is read.
 */
import { afterEach, describe, it } from 'bun:test';
import { appendFile, lstat, mkdir, readdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import should from 'should';

import { unavailableSharedHistory } from '../../daemon/adapters/shared-history-unavailable.ts';
import { EMPTY_RUNTIME_IDS, type RuntimeIds } from '../../daemon/lib/account/ids.ts';
import { materialiseFleet } from '../../daemon/lib/account/materialise.ts';
import { REAL_KITS } from '../support/real-kits.ts';
import { type AccountModelDocument, parseAccountModel } from '../../daemon/lib/account/schema.ts';
import type { FleetLayout } from '../../daemon/lib/provisioning.ts';
import { fleetWorld } from '../unit/support/fleet-world.ts';

const ID_CLAUDE = '00000000-0000-4000-8000-0000000000d1';
const ID_CODEX = '00000000-0000-4000-8000-0000000000d2';

const parents: string[] = [];
afterEach(async () => {
  await Promise.all(parents.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const text = (file: string): Promise<string> => readFile(file, 'utf8');
const exists = async (target: string): Promise<boolean> => {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
};
const isLink = async (target: string): Promise<boolean> => (await lstat(target)).isSymbolicLink();

const documentWith = (layers: readonly string[]): AccountModelDocument => ({
  version: 1,
  machine: { agentPermissions: 'skip' },
  credentials: {
    'claude-you': { harness: 'claude', store: 'host' },
    'codex-you': { harness: 'codex', store: 'host' },
  },
  components: {
    instructions: {
      main: { file: 'components/instructions/main.md' },
      extra: { file: 'components/instructions/extra.md' },
    },
    mcp: { notes: { command: 'notes-server' }, old: { command: 'old-server', args: ['--legacy'] } },
    skills: { mine: { items: ['review'] } },
    modelSets: { models: { models: ['claude-opus-5-5', 'gpt-6'], default: 'claude-opus-5-5' } },
  },
  profiles: { default: { layers: [...layers, 'modelSets/models'] } },
  runtimes: {
    'claude-agent': { credential: 'claude-you', profile: 'default' },
    'codex-default': { credential: 'codex-you', profile: 'default' },
  },
});

/** A Claude and a Codex runtime on one temp machine; `apply` runs the real materialiser and provisioner, as often as asked. */
async function machine() {
  const world = await fleetWorld();
  parents.push(world.parent);
  const layout: FleetLayout = {
    stateHome: world.home,
    userHome: path.join(world.parent, 'person'),
    fleetDirectory: world.fleet,
    binDirectory: path.join(world.fleet, 'bin'),
    homesDirectory: path.join(world.fleet, 'homes'),
    assetsDirectory: path.join(world.fleet, 'assets'),
    manifestPath: path.join(world.fleet, 'manifest.json'),
    defaultHomeDirectories: {
      claude: path.join(world.parent, 'person', '.claude'),
      codex: path.join(world.parent, 'person', '.codex'),
    },
  };
  const assets = layout.assetsDirectory;
  await mkdir(path.join(assets, 'components', 'instructions'), { recursive: true });
  await writeFile(path.join(assets, 'components', 'instructions', 'main.md'), 'Main guidance.\n');
  await writeFile(path.join(assets, 'components', 'instructions', 'extra.md'), 'Extra guidance.\n');
  await mkdir(path.join(assets, 'skills', 'review'), { recursive: true });
  await writeFile(path.join(assets, 'skills', 'review', 'SKILL.md'), '---\nname: review\n---\n');
  // The person's own Codex login, which the Codex runtime's auth.json links to.
  const hostCodexHome = path.join(world.parent, 'person', '.codex');
  await writeFile(path.join(hostCodexHome, 'auth.json'), '{"token":"host"}\n');
  const fakeFy = path.join(world.parent, 'fakes', 'fy');
  await mkdir(path.dirname(fakeFy), { recursive: true });
  await writeFile(fakeFy, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  const provisioner = world.provisioner({ sharedHistory: unavailableSharedHistory });
  let ids: RuntimeIds = EMPTY_RUNTIME_IDS;
  const minted = [ID_CLAUDE, ID_CODEX];
  const apply = async (layers: readonly string[]) => {
    const plan = materialiseFleet({
      model: parseAccountModel(documentWith(layers)),
      layout,
      ids,
      mint: () => minted.shift() ?? 'exhausted',
      generatedAt: '2026-11-23T08:00:00.000Z',
      bodies: { instructions: { main: 'Main guidance.\n', extra: 'Extra guidance.\n' } },
      claudeStatusline: () => "'fy' statusline",
      fyCommand: fakeFy,
      hostCodexHome,
      acceptsAutoPermissionMode: true,
      kits: REAL_KITS,
    });
    ids = plan.ids;
    return await provisioner.apply(plan);
  };
  return {
    layout,
    apply,
    person: path.join(world.parent, 'person'),
    claudeHome: path.join(layout.homesDirectory, ID_CLAUDE),
    codexHome: path.join(layout.homesDirectory, ID_CODEX),
  };
}

const left = (result: { readonly skipped?: readonly { readonly path: string }[] }): readonly string[] =>
  (result.skipped ?? []).map(entry => entry.path);

const reasonFor = (
  result: { readonly skipped?: readonly { readonly path: string; readonly reason: string }[] },
  target: string,
): string | undefined => (result.skipped ?? []).find(entry => entry.path === target)?.reason;

const recordOf = async (home: string) =>
  JSON.parse(await text(path.join(home, '.fy', 'materialised.json'))) as {
    entries: string[];
    hashes?: Record<string, string>;
    links?: Record<string, string>;
  };

const TWO = ['instructions/main', 'instructions/extra'];

describe('case 1: CLAUDE.md is never claimed from its text, and retirement honours its hash', () => {
  it('should keep an unrecorded CLAUDE.md that holds exactly the proposed text, and still keep it when the profile stops filling it', async () => {
    const host = await machine();
    await host.apply(TWO);
    const file = path.join(host.claudeHome, 'CLAUDE.md');
    const proposed = await text(file);
    // The record is gone (an older install never had one): what is there is the proposed text, but nothing proves it is Ferretry's.
    await rm(path.join(host.claudeHome, '.fy', 'materialised.json'));

    const same = await host.apply(TWO);
    should(left(same)).containEql(file);
    should(reasonFor(same, file)).equal(
      "CLAUDE.md predates Ferretry's tracking; Ferretry left it. Delete it to get the generated one.",
    );
    should((await recordOf(host.claudeHome)).entries).not.containEql('CLAUDE.md');

    const retired = await host.apply(['mcp/notes']);
    should(await text(file)).equal(proposed);
    should(left(retired)).containEql(file);
  });

  it('should keep a file that only STARTS with the generated header, since a header cannot prove it is unedited', async () => {
    const host = await machine();
    await host.apply(TWO);
    const file = path.join(host.claudeHome, 'CLAUDE.md');
    const edited = `${await text(file)}\n- remembered by /memory: rotate the deploy key on Friday\n`;
    await writeFile(file, edited);
    await rm(path.join(host.claudeHome, '.fy', 'materialised.json'));

    await host.apply(TWO);
    await host.apply(['mcp/notes']);

    should(await text(file)).equal(edited);
  });

  it('should keep a recorded CLAUDE.md that was edited since when the profile stops filling it, and say so', async () => {
    const host = await machine();
    await host.apply(TWO);
    const file = path.join(host.claudeHome, 'CLAUDE.md');
    await appendFile(file, '\n- remembered by /memory: the staging password lives in the vault\n');
    const edited = await text(file);

    const retired = await host.apply(['mcp/notes']);

    should(await text(file)).equal(edited);
    should(left(retired)).containEql(file);
  });

  it('should still remove a recorded CLAUDE.md nobody touched', async () => {
    const host = await machine();
    await host.apply(TWO);

    const retired = await host.apply(['mcp/notes']);

    should(await exists(path.join(host.claudeHome, 'CLAUDE.md'))).be.false();
    should(left(retired)).not.containEql(path.join(host.claudeHome, 'CLAUDE.md'));
  });
});

describe('case 2: a link or a copy is replaced or removed only if it is the one Ferretry made', () => {
  it("should keep a person's own symlink at a name the profile stopped filling", async () => {
    const host = await machine();
    await host.apply(['mcp/notes']);
    const notes = path.join(host.person, 'notes.md');
    await writeFile(notes, 'My notes.\n');
    const mine = path.join(host.claudeHome, 'CLAUDE.md');
    await symlink(notes, mine);

    const result = await host.apply(['mcp/notes']);

    should(await isLink(mine)).be.true();
    should(await readlink(mine)).equal(notes);
    should(await text(notes)).equal('My notes.\n');
    should(left(result)).containEql(mine);
  });

  it('should not turn an edited CLAUDE.md into a link', async () => {
    const host = await machine();
    await host.apply(TWO);
    const file = path.join(host.claudeHome, 'CLAUDE.md');
    await appendFile(file, '\n- remembered by /memory: use the blue runner\n');
    const edited = await text(file);

    // One instructions layer is a link to the component, so the plan now wants a link where the edited file is.
    const result = await host.apply(['instructions/main']);

    should(await isLink(file)).be.false();
    should(await text(file)).equal(edited);
    should(left(result)).containEql(file);
  });

  it("should not replace a person's regular auth.json after the managed link was replaced", async () => {
    const host = await machine();
    await host.apply(['mcp/notes']);
    const auth = path.join(host.codexHome, 'auth.json');
    should(await isLink(auth)).be.true();
    // The person signs in by hand: the link is gone and their own regular file is there.
    await rm(auth);
    await writeFile(auth, '{"token":"mine"}\n');

    const result = await host.apply(['mcp/notes']);

    should(await isLink(auth)).be.false();
    should(await text(auth)).equal('{"token":"mine"}\n');
    should(left(result)).containEql(auth);
    should((await recordOf(host.codexHome)).entries).not.containEql('auth.json');
  });

  it('should keep a link the person swapped in for a managed one, even to the same place', async () => {
    const host = await machine();
    await host.apply(['skills/mine']);
    const skill = path.join(host.claudeHome, 'skills', 'review');
    const target = await readlink(skill);
    await rm(skill);
    await symlink(target, skill);

    const result = await host.apply(['mcp/notes']);

    should(await isLink(skill)).be.true();
    should(left(result)).containEql(skill);
  });
});

describe('case 3: the state folder, settings files and the generated files beside them', () => {
  it('should keep an unrecorded note in the state folder, and sweep only what Ferretry recorded', async () => {
    const host = await machine();
    await host.apply(['mcp/notes']);
    const state = path.join(host.claudeHome, '.fy');
    await writeFile(path.join(state, 'notes.txt'), 'my notes about this runtime\n');
    await writeFile(path.join(state, 'old-overlay.json'), '{}\n');
    // One of the two is Ferretry's old overlay, which the record names; the person's note is not named.
    const record = await recordOf(host.claudeHome);
    await writeFile(
      path.join(state, 'materialised.json'),
      JSON.stringify({
        ...record,
        entries: [...record.entries, '.fy/old-overlay.json'],
        hashes: { ...record.hashes, '.fy/old-overlay.json': await sha('{}\n') },
      }),
    );

    const result = await host.apply(['mcp/notes']);

    should(await text(path.join(state, 'notes.txt'))).equal('my notes about this runtime\n');
    should(await exists(path.join(state, 'old-overlay.json'))).be.false();
    should(left(result)).containEql(path.join(state, 'notes.txt'));
  });

  it("should merge into a person's existing .claude.json on the first apply, keeping their MCP servers and every other key", async () => {
    const host = await machine();
    await mkdir(host.claudeHome, { recursive: true });
    await writeFile(
      path.join(host.claudeHome, '.claude.json'),
      JSON.stringify({ numStartups: 7, mcpServers: { mine: { command: 'my-server', args: ['--x'] } } }),
    );

    await host.apply(['mcp/notes']);

    const written = JSON.parse(await text(path.join(host.claudeHome, '.claude.json')));
    should(written.numStartups).equal(7);
    should(written.mcpServers.mine).eql({ command: 'my-server', args: ['--x'] });
    should(written.mcpServers.notes).containEql({ command: 'notes-server' });
  });

  it('should drop a server the profile wrote and no longer has, and nothing else, and keep a same-named server of the person', async () => {
    const host = await machine();
    await host.apply(['mcp/notes']);
    const file = path.join(host.claudeHome, '.claude.json');
    const written = JSON.parse(await text(file));
    await writeFile(
      file,
      JSON.stringify({ ...written, mcpServers: { ...written.mcpServers, mine: { command: 'mine' } } }),
    );

    await host.apply(['skills/mine']);

    const after = JSON.parse(await text(file));
    should(Object.keys(after.mcpServers)).eql(['mine']);

    // A person's server of the profile's own name is theirs, and stays as they have it.
    await writeFile(file, JSON.stringify({ mcpServers: { notes: { command: 'my-own-notes' } } }));
    const result = await host.apply(['mcp/notes']);
    should(JSON.parse(await text(file)).mcpServers.notes).eql({ command: 'my-own-notes' });
    should(left(result)).containEql(file);
  });

  it('should leave a settings file that is a link, and say nothing was written to it', async () => {
    const host = await machine();
    await host.apply(['mcp/notes']);
    const settings = path.join(host.claudeHome, 'settings.json');
    const theirs = path.join(host.person, 'settings-from-dotfiles.json');
    await writeFile(theirs, '{"theme":"dark"}\n');
    await rm(settings);
    await symlink(theirs, settings);

    const result = await host.apply(['mcp/notes']);

    should(await isLink(settings)).be.true();
    should(await text(theirs)).equal('{"theme":"dark"}\n');
    should(left(result)).containEql(settings);
  });

  it('should keep an unrelated folder at the name of a generated state file', async () => {
    const host = await machine();
    const overlay = path.join(host.claudeHome, '.fy', 'fixed.json');
    await mkdir(overlay, { recursive: true });
    await writeFile(path.join(overlay, 'mine.txt'), 'a person made a folder here\n');

    const result = await host.apply(['mcp/notes']);

    should(await text(path.join(overlay, 'mine.txt'))).equal('a person made a folder here\n');
    should(left(result)).containEql(overlay);
  });

  it('should replace a regular file at the record name whatever it holds, and keep a link or a folder there', async () => {
    const host = await machine();
    const record = path.join(host.claudeHome, '.fy', 'materialised.json');
    await mkdir(path.dirname(record), { recursive: true });
    await writeFile(record, 'not a record at all\n');

    const result = await host.apply(['mcp/notes']);

    should((await recordOf(host.claudeHome)).entries).be.an.Array();
    should(left(result)).not.containEql(record);

    await rm(record);
    await mkdir(record);
    const folder = await host.apply(['mcp/notes']);
    should((await lstat(record)).isDirectory()).be.true();
    should(left(folder)).containEql(record);
  });
});

describe('case 4: what one runtime declines is never another runtime’s', () => {
  it("should keep Codex's skill in its record when Claude's same-named skill was the person's, and remove it when the profile drops it", async () => {
    const host = await machine();
    await host.apply(['skills/mine']);
    const claudeSkill = path.join(host.claudeHome, 'skills', 'review');
    const codexSkill = path.join(host.codexHome, 'skills', 'review');
    // The person replaces Claude's managed link with a skill folder of their own.
    await rm(claudeSkill);
    await mkdir(claudeSkill);
    await writeFile(path.join(claudeSkill, 'SKILL.md'), '# the person’s own review\n');

    const again = await host.apply(['skills/mine']);
    should(left(again)).containEql(claudeSkill);
    should((await recordOf(host.codexHome)).entries).containEql('skills/review');

    await host.apply(['mcp/notes']);

    should(await exists(codexSkill)).be.false();
    should(await text(path.join(claudeSkill, 'SKILL.md'))).equal('# the person’s own review\n');
  });

  it('should remove a skill link from before the record held skills only if it leads into Ferretry’s own skills store', async () => {
    const host = await machine();
    await host.apply(['mcp/notes']);
    // A record from before links were kept: it names no link, so none can be vouched for by its stamp.
    await writeFile(path.join(host.codexHome, '.fy', 'materialised.json'), '{"version":1,"entries":[]}\n');
    const store = path.join(host.layout.assetsDirectory, 'skills', 'review');
    const elsewhere = path.join(host.person, 'their-skill');
    await mkdir(elsewhere);
    await mkdir(path.join(host.codexHome, 'skills'), { recursive: true });
    const ferretrys = path.join(host.codexHome, 'skills', 'old-ferretry-link');
    const theirs = path.join(host.codexHome, 'skills', 'their-link');
    await symlink(store, ferretrys);
    await symlink(elsewhere, theirs);

    const result = await host.apply(['mcp/notes']);

    should(await exists(ferretrys)).be.false();
    should(await isLink(theirs)).be.true();
    should(left(result)).containEql(theirs);
    should(left(result)).not.containEql(ferretrys);
  });

  it('should keep a skill the person added by hand, and name it', async () => {
    const host = await machine();
    await host.apply(['skills/mine']);
    const mine = path.join(host.codexHome, 'skills', 'by-hand');
    await mkdir(mine);
    await writeFile(path.join(mine, 'SKILL.md'), '# by hand\n');

    const result = await host.apply(['mcp/notes']);

    should(await readdir(path.join(host.codexHome, 'skills'))).containEql('by-hand');
    should(left(result)).containEql(mine);
  });
});

describe('case 5: a narrowed retirement that keeps an unrecorded file says so', () => {
  it("should name the person's own CLAUDE.md when the profile stops filling the name", async () => {
    const host = await machine();
    await host.apply(['mcp/notes']);
    const file = path.join(host.claudeHome, 'CLAUDE.md');
    await writeFile(file, 'My own rules.\n');

    const result = await host.apply(['mcp/notes']);

    should(await text(file)).equal('My own rules.\n');
    should(left(result)).containEql(file);
  });
});

describe('upgrade: a home an older Ferretry filled is taken over once, and nothing of the person’s is lost', () => {
  /**
   * What the code before this fix left: a record that is only `{version, entries:[top-level names]}`, with no hashes, links,
   * dirs or members. Everything else on disk is what that Ferretry wrote — plus what the person put beside it.
   */
  const asOlderFerretryLeftIt = async (host: Awaited<ReturnType<typeof machine>>) => {
    await writeFile(
      path.join(host.claudeHome, '.fy', 'materialised.json'),
      `${JSON.stringify({ version: 1, entries: ['CLAUDE.md'] })}\n`,
    );
    await writeFile(
      path.join(host.codexHome, '.fy', 'materialised.json'),
      `${JSON.stringify({ version: 1, entries: ['AGENTS.md', 'auth.json'] })}\n`,
    );
  };
  const OLD_PLAN = ['instructions/main', 'mcp/notes', 'mcp/old', 'skills/mine'];
  const servers = async (host: Awaited<ReturnType<typeof machine>>) =>
    (JSON.parse(await text(path.join(host.claudeHome, '.claude.json'))) as { mcpServers: Record<string, unknown> })
      .mcpServers;
  const named = (result: Parameters<typeof left>[0]): string =>
    (result.skipped ?? []).map(entry => entry.path).join('\n');
  /** The runtime home as the old Ferretry left it, plus a stale overlay, a person's own server and one nobody can vouch for. */
  const upgraded = async () => {
    const host = await machine();
    await host.apply(OLD_PLAN);
    const fixed = path.join(host.claudeHome, '.fy', 'fixed.json');
    const current = await text(fixed);
    await asOlderFerretryLeftIt(host);
    // The overlay an older Ferretry wrote: it forced a laxer permission default than this one does.
    await writeFile(fixed, '{"permissions":{"defaultMode":"bypassPermissions"}}\n');
    const claudeJson = path.join(host.claudeHome, '.claude.json');
    const written = JSON.parse(await text(claudeJson)) as { mcpServers: Record<string, unknown> };
    await writeFile(
      claudeJson,
      JSON.stringify({
        ...written,
        mcpServers: {
          ...written.mcpServers,
          mine: { type: 'stdio', command: 'mine-server', args: [] },
          ghost: { type: 'stdio', command: 'ghost-server', args: ['--who-knows'] },
        },
      }),
    );
    return { host, fixed, current };
  };

  it('should bring Ferretry’s own fixed files, links and servers up to date, and keep what the person added', async () => {
    const { host, fixed, current } = await upgraded();
    const claudeMd = path.join(host.claudeHome, 'CLAUDE.md');
    const agentsMd = path.join(host.codexHome, 'AGENTS.md');
    const skill = path.join(host.claudeHome, 'skills', 'review');
    const auth = path.join(host.codexHome, 'auth.json');
    const authTarget = await readlink(auth);

    // The profile now reads another instructions file and has dropped the old server.
    const first = await host.apply(['instructions/extra', 'mcp/notes', 'skills/mine']);

    // The overlay is Ferretry's by name: it is written again, so a stale permission default cannot stay in force.
    should(await text(fixed)).equal(current);
    // The links an older Ferretry made are claimed once: the instructions follow the profile, nothing says otherwise.
    should(await readlink(claudeMd)).endWith(path.join('instructions', 'extra.md'));
    should(await readlink(agentsMd)).endWith(path.join('instructions', 'extra.md'));
    should(await isLink(skill)).be.true();
    should(await readlink(auth)).equal(authTarget);
    // The server the profile dropped is provably Ferretry's (written exactly as its component renders), so it goes.
    const afterFirst = await servers(host);
    should(Object.keys(afterFirst).toSorted()).eql(['ghost', 'mine', 'notes']);
    // Nothing of Ferretry's own is called the person's; what cannot be proved is kept, and named once.
    const mentioned = named(first);
    for (const own of [fixed, claudeMd, agentsMd, skill, auth]) should(mentioned).not.containEql(own);
    should(
      (first.skipped ?? [])
        .filter(entry => entry.path.endsWith('.claude.json'))
        .map(entry => entry.reason)
        .toSorted(),
    ).eql([
      'mcpServers "ghost" may have been put there by an older Ferretry, which cannot be proved; Ferretry left it',
      'mcpServers "mine" may have been put there by an older Ferretry, which cannot be proved; Ferretry left it',
    ]);

    // The record now vouches for all of it, so the SECOND apply has nothing left to say about Ferretry's own entries.
    const second = await host.apply(['instructions/extra', 'mcp/notes', 'skills/mine']);
    should(second.skipped ?? []).eql([]);
    should(await servers(host)).eql(afterFirst);
  });

  it('should remove a link of Ferretry’s when the profile drops what it led to, and keep the person’s own', async () => {
    const { host } = await upgraded();
    const claudeMd = path.join(host.claudeHome, 'CLAUDE.md');
    const agentsMd = path.join(host.codexHome, 'AGENTS.md');
    const skill = path.join(host.claudeHome, 'skills', 'review');
    const theirs = path.join(host.claudeHome, 'skills', 'their-link');
    await symlink(path.join(host.person, '.codex'), theirs);

    // Instructions and the skill are dropped: the older Ferretry's links must not outlive the profile that made them.
    const result = await host.apply(['mcp/notes']);

    should(await exists(claudeMd)).be.false();
    should(await exists(agentsMd)).be.false();
    should(await exists(skill)).be.false();
    should(await isLink(theirs)).be.true();
    should(named(result)).not.containEql(claudeMd);
    should(named(result)).not.containEql(skill);
    should(left(result)).containEql(theirs);
    should(Object.keys(await servers(host)).toSorted()).eql(['ghost', 'mine', 'notes']);
  });
});

async function sha(content: string): Promise<string> {
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(content).digest('hex');
}
