/**
 * The account model's materialisation, end to end: `materialiseFleet` deciding and the real provisioner
 * writing, then the generated wrappers run by a real `sh` against stand-in harnesses.
 *
 * What these prove can only be seen on disk after an apply — or after a SECOND apply: that a
 * destination the profile stops filling is swept only when it is provably the plan's own (a link, or a
 * name the previous apply recorded), so a person's own `CLAUDE.md` or memory file in the config
 * directory survives; that Codex's own `skills/.system` survives; and that a credential link may point
 * at a login nobody has signed in to yet. No real harness and no real account is touched: every
 * directory is a temporary one, and the harnesses on `PATH` are scripts that print what they were given.
 */
import { afterEach, describe, it } from 'bun:test';
import { chmod, lstat, mkdir, readdir, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import should from 'should';

import { unavailableSharedHistory } from '../../daemon/adapters/shared-history-unavailable.ts';
import { CODEX_QUESTIONS_OFF_OVERRIDE, tomlString } from '../../daemon/lib/account/fixed-layer.ts';
import { EMPTY_RUNTIME_IDS, type RuntimeIds } from '../../daemon/lib/account/ids.ts';
import { materialiseFleet } from '../../daemon/lib/account/materialise.ts';
import { REAL_KITS } from '../support/real-kits.ts';
import { type AccountModelDocument, parseAccountModel } from '../../daemon/lib/account/schema.ts';
import type { FleetLayout, FleetModelApplyPlan, FleetWriteOperation } from '../../daemon/lib/provisioning.ts';
import { fleetWorld, type FleetWorld } from '../unit/support/fleet-world.ts';
import {
  HISTORY_CLAIM_HELD_EXIT_CODE,
  type RuntimeWrapperInput,
  renderRuntimeWrapperScript,
} from '../../daemon/lib/wrappers.ts';

const ID_CLAUDE = '00000000-0000-4000-8000-0000000000c1';
const ID_CODEX = '00000000-0000-4000-8000-0000000000c2';
const GENERATED_AT = '2026-10-13T08:00:00.000Z';

const temporaryDirectories: string[] = [];

/** The fleet world each temporary directory is the parent of: the kernel's real roots over it (`../unit/support/fleet-world.ts`). */
const worlds = new Map<string, FleetWorld>();

async function temporaryDirectory(): Promise<string> {
  const world = await fleetWorld();
  worlds.set(world.parent, world);
  temporaryDirectories.push(world.parent);
  return world.parent;
}

const worldOf = (root: string): FleetWorld => {
  const world = worlds.get(root);
  if (world === undefined) throw new Error('not a fleet world');
  return world;
};
const fleetOf = (root: string): string => worldOf(root).fleet;
// The pooling the daemon's own host assembly supplies (`daemon/host-assembly.ts`): history pooling is Conversation's and
// not wired, so an apply skips and names it. A provisioner given NO pooling refuses a plan that carries history requests.
const newProvisioner = (root: string) => worldOf(root).provisioner({ sharedHistory: unavailableSharedHistory });

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const layoutIn = (root: string): FleetLayout => ({
  stateHome: worldOf(root).home,
  userHome: path.join(root, 'person'),
  fleetDirectory: fleetOf(root),
  binDirectory: path.join(fleetOf(root), 'bin'),
  homesDirectory: path.join(fleetOf(root), 'homes'),
  assetsDirectory: path.join(fleetOf(root), 'assets'),
  manifestPath: path.join(fleetOf(root), 'manifest.json'),
  defaultHomeDirectories: { claude: path.join(root, 'person', '.claude'), codex: path.join(root, 'person', '.codex') },
});

/** One Claude agent on the person's own login and one Codex runtime on an empty Ferretry slot. */
const documentWith = (layers: readonly string[]): AccountModelDocument => ({
  version: 1,
  machine: { agentPermissions: 'skip' },
  credentials: {
    'claude-you': { harness: 'claude', store: 'host' },
    'codex-slot': { harness: 'codex', store: 'ferretry' },
  },
  components: {
    instructions: {
      main: { file: 'components/instructions/main.md' },
      extra: { file: 'components/instructions/extra.md' },
    },
    mcp: { notes: { command: 'notes-server' } },
    skills: { mine: { items: ['review'] } },
    modelSets: { models: { models: ['claude-opus-5-5', 'gpt-6'], default: 'claude-opus-5-5' } },
  },
  profiles: { default: { layers: [...layers, 'modelSets/models'] } },
  runtimes: {
    'claude-agent': { credential: 'claude-you', profile: 'default' },
    'codex-default': { credential: 'codex-slot', profile: 'default' },
  },
});

interface Machine {
  readonly root: string;
  readonly layout: FleetLayout;
  readonly claudeHome: string;
  readonly codexHome: string;
  /** What the last apply left undone and said so (the history pooling this host does not have). */
  readonly skippedByLastApply: () => readonly { readonly path: string; readonly reason: string }[];
  /** Plan and apply `layers`, carrying `ids.json` forward from the previous apply. */
  readonly apply: (layers: readonly string[]) => Promise<FleetModelApplyPlan>;
}

async function machine(): Promise<Machine> {
  const root = await temporaryDirectory();
  const layout = layoutIn(root);
  const assets = layout.assetsDirectory;
  await mkdir(path.join(assets, 'components', 'instructions'), { recursive: true });
  await writeFile(path.join(assets, 'components', 'instructions', 'main.md'), 'Main guidance.\n');
  await writeFile(path.join(assets, 'components', 'instructions', 'extra.md'), 'Extra guidance.\n');
  await mkdir(path.join(assets, 'skills', 'review'), { recursive: true });
  await writeFile(path.join(assets, 'skills', 'review', 'SKILL.md'), '---\nname: review\n---\n');
  // The shared history pool is the harness plugins' own (linked when a ferret starts); the pooling wired here is the
  // production one, so a plan carrying history requests has them skipped and named, never pooled by an apply.
  const provisioner = newProvisioner(root);
  let ids: RuntimeIds = EMPTY_RUNTIME_IDS;
  const minted = [ID_CLAUDE, ID_CODEX];
  let skipped: readonly { readonly path: string; readonly reason: string }[] = [];
  return {
    root,
    layout,
    skippedByLastApply: () => skipped,
    claudeHome: path.join(layout.homesDirectory, ID_CLAUDE),
    codexHome: path.join(layout.homesDirectory, ID_CODEX),
    apply: async layers => {
      const plan = materialiseFleet({
        model: parseAccountModel(documentWith(layers)),
        layout,
        ids,
        mint: () => minted.shift() ?? 'exhausted',
        generatedAt: GENERATED_AT,
        bodies: { instructions: { main: 'Main guidance.\n', extra: 'Extra guidance.\n' } },
        claudeStatusline: () => "'fy' statusline",
        fyCommand: path.join(root, 'no-such-fy'),
        acceptsAutoPermissionMode: true,
        kits: REAL_KITS,
      });
      const applied = await provisioner.apply(plan);
      skipped = applied.skipped ?? [];
      ids = plan.ids;
      return plan;
    },
  };
}

const exists = async (target: string): Promise<boolean> => {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
};

const isLink = async (target: string): Promise<boolean> => (await lstat(target)).isSymbolicLink();

describe('materialising the account model onto disk', () => {
  it('should write each config directory, its credential link, the wrappers, ids.json and the manifest', async () => {
    // Arrange
    const host = await machine();

    // Act
    await host.apply(['instructions/main', 'mcp/notes', 'skills/mine']);

    // Assert
    should(await readlink(path.join(host.claudeHome, 'CLAUDE.md'))).equal(
      path.join(host.layout.assetsDirectory, 'components', 'instructions', 'main.md'),
    );
    should(await readlink(path.join(host.claudeHome, 'skills', 'review'))).equal(
      path.join(host.layout.assetsDirectory, 'skills', 'review'),
    );
    // A Runtimes apply does not pool history: the apply stood and a person is not told about a missing engine.
    for (const skip of host.skippedByLastApply()) should(skip.reason).not.match(/pooling conversation history/);
    // A Ferretry-kept Codex login is Logins' (state/logins/credentials): no link to the old fleet store is made, and the
    // apply is not refused for a link out of the folders it may write (declared GAP: the kernel links that file, into a ferret's home only).
    should(await exists(path.join(host.codexHome, 'auth.json'))).be.false();
    should(await exists(path.join(host.layout.fleetDirectory, 'credentials'))).be.false();
    should(JSON.parse(await readFile(path.join(host.claudeHome, '.claude.json'), 'utf8'))).eql({
      mcpServers: { notes: { type: 'stdio', command: 'notes-server', args: [] } },
    });
    // The overlay names the mode as well: a flag-settings mode keeps the auto-default dialog away.
    should(JSON.parse(await readFile(path.join(host.claudeHome, '.fy', 'fixed.json'), 'utf8'))).eql({
      permissions: { defaultMode: 'bypassPermissions', deny: ['Bash(pkill:*)', 'Bash(killall:*)'] },
      remoteControlAtStartup: false,
      skipDangerousModePermissionPrompt: true,
    });
    // What each entry IS is read off the disk when the record is written: the two links are told apart, the overlay is hashed.
    const record = JSON.parse(await readFile(path.join(host.claudeHome, '.fy', 'materialised.json'), 'utf8'));
    should(record.entries).eql(['.fy/fixed.json', 'CLAUDE.md', 'skills/review']);
    should(Object.keys(record.links)).eql(['CLAUDE.md', 'skills/review']);
    should(Object.keys(record.hashes)).eql(['.fy/fixed.json']);
    should(Object.keys(record.members)).eql(['mcpServers.notes']);
    should((await lstat(path.join(host.layout.binDirectory, 'claude-agent'))).mode & 0o777).equal(0o755);
    should(JSON.parse(await readFile(path.join(host.layout.fleetDirectory, 'ids.json'), 'utf8')).runtimes).eql({
      'claude-agent': { id: ID_CLAUDE, formerNames: [] },
      'codex-default': { id: ID_CODEX, formerNames: [] },
    });
    const manifest = JSON.parse(await readFile(host.layout.manifestPath, 'utf8'));
    should(manifest.runtimes.map((runtime: { name: string }) => runtime.name)).eql(['claude-agent', 'codex-default']);
  });

  it("should never sweep a person's own CLAUDE.md or memory file, while removing the plan's own leftovers", async () => {
    // Arrange: a link the plan made, and then the person's own documents beside it.
    const host = await machine();
    await host.apply(['instructions/main']);
    should(await isLink(path.join(host.claudeHome, 'CLAUDE.md'))).be.true();

    // Act: the profile stops having instructions — the link is the plan's, so it goes.
    await host.apply(['mcp/notes']);

    // Assert
    should(await exists(path.join(host.claudeHome, 'CLAUDE.md'))).be.false();

    // Arrange: now the person writes their own, with /memory or by hand, plus a memory file.
    await writeFile(path.join(host.claudeHome, 'CLAUDE.md'), 'My own notes.\n');
    await writeFile(path.join(host.claudeHome, 'memory.md'), 'Remember this.\n');
    await mkdir(path.join(host.claudeHome, 'hooks'));
    await writeFile(path.join(host.claudeHome, 'hooks', 'mine.sh'), '#!/bin/sh\n');

    // Act: re-applying a profile that puts nothing at either name.
    await host.apply(['mcp/notes']);

    // Assert: a regular file and a directory that are neither a link nor recorded stay.
    should(await readFile(path.join(host.claudeHome, 'CLAUDE.md'), 'utf8')).equal('My own notes.\n');
    should(await readFile(path.join(host.claudeHome, 'memory.md'), 'utf8')).equal('Remember this.\n');
    should(await readFile(path.join(host.claudeHome, 'hooks', 'mine.sh'), 'utf8')).equal('#!/bin/sh\n');
  });

  it('should remove a generated document the previous apply recorded, and nothing it did not', async () => {
    // Arrange: two instructions make a GENERATED CLAUDE.md — a regular file, provable only by the record.
    const host = await machine();
    await host.apply(['instructions/main', 'instructions/extra']);
    const generated = path.join(host.claudeHome, 'CLAUDE.md');
    should(await isLink(generated)).be.false();
    should(await readFile(generated, 'utf8')).containEql('Main guidance.\n\nExtra guidance.');

    // Act
    await host.apply(['mcp/notes']);

    // Assert
    should(await exists(generated)).be.false();
    should(JSON.parse(await readFile(path.join(host.claudeHome, '.fy', 'materialised.json'), 'utf8')).entries).eql([
      '.fy/fixed.json',
    ]);
  });

  it(".claude.json: fold the profile's MCP servers in by name and keep Claude's own keys and the person's servers", async () => {
    // Arrange
    const host = await machine();
    await host.apply(['mcp/notes']);
    const claudeJson = path.join(host.claudeHome, '.claude.json');
    const written = JSON.parse(await readFile(claudeJson, 'utf8'));
    await writeFile(
      claudeJson,
      JSON.stringify({ ...written, numStartups: 3, mcpServers: { ...written.mcpServers, mine: { command: 'mine' } } }),
    );

    // Act
    await host.apply(['mcp/notes']);

    // Assert
    should(JSON.parse(await readFile(claudeJson, 'utf8'))).eql({
      numStartups: 3,
      mcpServers: { notes: { type: 'stdio', command: 'notes-server', args: [] }, mine: { command: 'mine' } },
    });
  });

  it("should sweep a dropped skill item and keep Codex's own skills/.system", async () => {
    // Arrange
    const host = await machine();
    await host.apply(['skills/mine']);
    await mkdir(path.join(host.codexHome, 'skills', '.system', 'bundled'), { recursive: true });
    await writeFile(path.join(host.codexHome, 'skills', '.system', 'bundled', 'SKILL.md'), 'bundled\n');

    // Act
    await host.apply(['mcp/notes']);

    // Assert
    should(await readdir(path.join(host.codexHome, 'skills'))).eql(['.system']);
    should(await readdir(path.join(host.claudeHome, 'skills'))).eql([]);
  });
});

describe('the narrowed sweep on its own', () => {
  const sweep = async (root: string, operation: FleetWriteOperation): Promise<void> => {
    const fleet = fleetOf(root);
    await newProvisioner(root).apply({
      manifest: { version: 1, generatedAt: GENERATED_AT, accounts: [], runtimes: [] },
      manifestPath: path.join(fleet, 'manifest.json'),
      operations: [operation],
    });
  };

  it('should read an unreadable or malformed record as no record, so nothing is removed, a link included', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const home = path.join(fleetOf(root), 'homes', 'one');
    await mkdir(path.join(home, '.fy', 'materialised.json'), { recursive: true });
    await writeFile(path.join(home, 'recorded.md'), 'mine\n');
    await writeFile(path.join(root, 'target.md'), 'target\n');
    const { symlink } = await import('node:fs/promises');
    await symlink(path.join(root, 'target.md'), path.join(home, 'linked.md'));
    await writeFile(path.join(home, 'bad.json'), 'not json');

    // Act: a record that is a directory, then one that is not JSON.
    await sweep(root, {
      kind: 'prune-directory',
      path: home,
      keep: [],
      only: ['recorded.md', 'linked.md', 'absent.md', '../escape', '.fy-stage-x'],
      record: path.join(home, '.fy', 'materialised.json'),
    });
    await sweep(root, {
      kind: 'prune-directory',
      path: home,
      keep: [],
      only: ['recorded.md'],
      record: path.join(home, 'bad.json'),
    });
    await sweep(root, { kind: 'prune-directory', path: home, keep: [], only: ['recorded.md'] });

    // Assert: with nothing to prove an entry by, a link is no more Ferretry's than a file is.
    should(await exists(path.join(home, 'linked.md'))).be.true();
    should(await readFile(path.join(home, 'recorded.md'), 'utf8')).equal('mine\n');
    should(await readFile(path.join(root, 'target.md'), 'utf8')).equal('target\n');
  });

  it('should keep a kept name even when the record lists it', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const home = path.join(fleetOf(root), 'homes', 'one');
    await mkdir(path.join(home, '.fy'), { recursive: true });
    await writeFile(path.join(home, 'kept.md'), 'kept\n');
    await writeFile(path.join(home, 'gone.md'), 'gone\n');
    const { createHash } = await import('node:crypto');
    const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
    await writeFile(
      path.join(home, '.fy', 'materialised.json'),
      JSON.stringify({
        version: 1,
        entries: ['kept.md', 'gone.md'],
        hashes: { 'kept.md': hash('kept\n'), 'gone.md': hash('gone\n') },
      }),
    );

    // Act
    await sweep(root, {
      kind: 'prune-directory',
      path: home,
      keep: ['kept.md'],
      only: ['kept.md', 'gone.md'],
      record: path.join(home, '.fy', 'materialised.json'),
    });

    // Assert
    should(await exists(path.join(home, 'kept.md'))).be.true();
    should(await exists(path.join(home, 'gone.md'))).be.false();
  });
});

describe('a runtime wrapper, run', () => {
  interface Run {
    readonly status: number;
    readonly stderr: string;
    /** What the stand-in harness was given, one argument per line, or undefined when it never ran. */
    readonly harness: string | undefined;
    readonly fyCalls: string | undefined;
  }

  const withWrapper = async (
    input: Partial<RuntimeWrapperInput>,
    options: {
      readonly fyStatus?: number;
      readonly cwdName?: string;
      readonly sessionId?: string;
      /** The ferret's launch mode, as the daemon hands it to the pane. */
      readonly mode?: 'auto' | 'interactive';
    } = {},
  ): Promise<{ readonly run: (...args: string[]) => Promise<Run>; readonly cwd: string }> => {
    const root = await temporaryDirectory();
    const bin = path.join(root, 'bin');
    const cwd = path.join(root, options.cwdName ?? 'work');
    await mkdir(bin, { recursive: true });
    await mkdir(cwd, { recursive: true });
    const harnessLog = path.join(root, 'harness.log');
    const fyLog = path.join(root, 'fy.log');
    for (const harness of ['claude', 'codex']) {
      await writeFile(
        path.join(bin, harness),
        `#!/bin/sh\nprintf 'HOME=%s\\n' "$HOME" > '${harnessLog}'\nfor a in "$@"; do printf '%s\\n' "$a" >> '${harnessLog}'; done\n`,
      );
      await chmod(path.join(bin, harness), 0o755);
    }
    const fy = path.join(bin, 'fy');
    if (options.fyStatus !== undefined) {
      await writeFile(fy, `#!/bin/sh\nprintf '%s\\n' "$*" > '${fyLog}'\nexit ${options.fyStatus}\n`);
      await chmod(fy, 0o755);
    }
    const script = path.join(root, 'wrapper');
    await writeFile(
      script,
      renderRuntimeWrapperScript({
        name: 'claude-default',
        id: ID_CLAUDE,
        harness: 'claude',
        configDirectory: path.join(root, 'home'),
        env: {},
        args: [],
        kit: REAL_KITS.get(input.harness ?? 'claude'),
        fyCommand: fy,
        ...input,
      }),
    );
    const read = async (file: string): Promise<string | undefined> => {
      try {
        return await readFile(file, 'utf8');
      } catch {
        return undefined;
      }
    };
    return {
      cwd,
      run: async (...args) => {
        await rm(harnessLog, { force: true });
        await rm(fyLog, { force: true });
        const child = Bun.spawn({
          cmd: ['/bin/sh', script, ...args],
          cwd,
          env: {
            PATH: `${bin}:/usr/bin:/bin`,
            HOME: path.join(root, 'person'),
            FY_SEED_FIRST_RUN: '0',
            ...(options.mode === undefined ? {} : { FY_SESSION_MODE: options.mode }),
            ...(options.sessionId === undefined ? {} : { FY_SESSION_ID: options.sessionId }),
          },
          stdout: 'ignore',
          stderr: 'pipe',
        });
        const stderr = await new Response(child.stderr).text();
        return { status: await child.exited, stderr, harness: await read(harnessLog), fyCalls: await read(fyLog) };
      },
    };
  };

  it('should not launch when fy history claim reports the conversation is held', async () => {
    // Arrange
    const { run } = await withWrapper({}, { fyStatus: HISTORY_CLAIM_HELD_EXIT_CODE });

    // Act
    const result = await run('--resume', '0b7e4c1a-1d2f-4c3b-9a8e-7f6d5c4b3a21');

    // Assert
    should(result.status).equal(HISTORY_CLAIM_HELD_EXIT_CODE);
    should(result.harness).be.undefined();
    should(result.fyCalls).match(/^history claim --harness claude --pid \d+ --from-arguments -- --resume 0b7e4c1a/);
  });

  it('should warn and launch anyway on any other claim failure', async () => {
    // Arrange
    const { run } = await withWrapper({}, { fyStatus: 1 });

    // Act
    const result = await run('-r', 'abc');

    // Assert
    should(result.status).equal(0);
    should(result.stderr).containEql('fy history claim exited 1), so launching anyway');
    should(result.harness).containEql('-r\nabc\n');
  });

  it('should warn and launch anyway when fy is missing, and never ask it for an ordinary launch', async () => {
    // Arrange
    const missing = await withWrapper({});
    const present = await withWrapper({}, { fyStatus: 0 });

    // Act
    const resumed = await missing.run('--session-id', 'abc');
    const ordinary = await present.run('--print', 'hello');

    // Assert
    should(resumed.status).equal(0);
    should(resumed.stderr).containEql('fy was not found');
    should(resumed.harness).containEql('--session-id\nabc\n');
    should(ordinary.fyCalls).be.undefined();
    should(ordinary.stderr).equal('');
  });

  // c58-36c (a): a wrapper run for a session (FY_SESSION_ID set) that cannot check its conversation refuses instead of
  // launching anyway. (A pane the daemon launches never runs the wrapper: the daemon moves its lease, see the lifecycle test.)
  it('should refuse to launch, with the reason, when a daemon-launched wrapper cannot renew its lease', async () => {
    // Arrange
    const { run } = await withWrapper({}, { fyStatus: 1, sessionId: 'mw7bp88g-50e00159' });

    // Act
    const result = await run('--resume', '0b7e4c1a-1d2f-4c3b-9a8e-7f6d5c4b3a21');

    // Assert
    should(result.status).equal(HISTORY_CLAIM_HELD_EXIT_CODE);
    should(result.harness).be.undefined();
    should(result.stderr).containEql('fy history claim exited 1').and.containEql('not launching');
  });

  it('should refuse to launch a daemon-launched wrapper when fy is missing', async () => {
    // Arrange
    const { run } = await withWrapper({}, { sessionId: 'mw7bp88g-50e00159' });

    // Act
    const result = await run('--session-id', 'abc');

    // Assert
    should(result.status).equal(HISTORY_CLAIM_HELD_EXIT_CODE);
    should(result.harness).be.undefined();
    should(result.stderr).containEql('fy was not found').and.containEql('not launching');
  });

  it('should launch a daemon-launched wrapper whose claim renewed, and ask nothing for an ordinary launch', async () => {
    // Arrange
    const { run } = await withWrapper({}, { fyStatus: 0, sessionId: 'mw7bp88g-50e00159' });

    // Act
    const resumed = await run('--resume', 'abc');
    const ordinary = await run('--print', 'hello');

    // Assert
    should(resumed.status).equal(0);
    should(resumed.harness).containEql('--resume\nabc\n');
    should(ordinary.status).equal(0);
    should(ordinary.fyCalls).be.undefined();
  });

  it("should keep the person's real HOME", async () => {
    // Arrange
    const { run } = await withWrapper({ env: { LOG_LEVEL: 'debug' } });

    // Act
    const result = await run();

    // Assert
    should(result.harness).match(/^HOME=.*\/person\n/);
  });

  it('should trust the physical launch folder with exactly the measured Codex override, quotes and backslashes included', async () => {
    // Arrange
    const { run, cwd } = await withWrapper(
      {
        harness: 'codex',
        args: ['--no-alt-screen'],
        autonomous: { args: ['--no-alt-screen'], seedFirstRun: false, trustLaunchFolder: true },
      },
      { cwdName: 'we"ird\\dir', mode: 'auto' },
    );

    // Act
    const result = await run('resume', '--last');

    // Assert
    should(result.status).equal(0);
    // `cwd` is already physical: its parent came from realpath (which Bun mis-resolves for a name holding a backslash).
    const args = (result.harness as string).split('\n').slice(1, -1);
    should(args).eql([
      '--no-alt-screen',
      '-c',
      CODEX_QUESTIONS_OFF_OVERRIDE,
      '-c',
      `projects={${tomlString(cwd)}={trust_level="trusted"}}`,
      'resume',
      '--last',
    ]);
  });

  it('should say why a runtime cannot start, and not start it', async () => {
    // Arrange
    const { run } = await withWrapper({ refusal: 'its login cannot be reached' });

    // Act
    const result = await run();

    // Assert
    should(result.status).equal(1);
    should(result.stderr).equal('ferretry: claude-default cannot start: its login cannot be reached\n');
    should(result.harness).be.undefined();
  });
});
