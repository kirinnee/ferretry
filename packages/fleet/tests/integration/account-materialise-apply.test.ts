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
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import should from 'should';
import { FileFleetProvisioner } from '../../src/adapters/file-provisioner.ts';
import { FileSharedHistoryFileSystem } from '../../src/adapters/file-shared-history.ts';
import { CLAUDE_QUESTION_HOOKS, codexTrustOverride } from '../../src/lib/account/fixed-layer.ts';
import { EMPTY_RUNTIME_IDS, type RuntimeIds } from '../../src/lib/account/ids.ts';
import { materialiseFleet } from '../../src/lib/account/materialise.ts';
import { type AccountModelDocument, parseAccountModel } from '../../src/lib/account/schema.ts';
import type { FleetLayout, FleetModelApplyPlan, FleetWriteOperation } from '../../src/lib/provisioning.ts';
import { SharedHistoryMigration } from '../../src/lib/shared-history.ts';
import {
  HISTORY_CLAIM_HELD_EXIT_CODE,
  type RuntimeWrapperInput,
  renderRuntimeWrapperScript,
} from '../../src/lib/wrappers.ts';

const ID_CLAUDE = '00000000-0000-4000-8000-0000000000c1';
const ID_CODEX = '00000000-0000-4000-8000-0000000000c2';
const GENERATED_AT = '2026-10-13T08:00:00.000Z';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  // realpath: macOS hands out /var/… for /private/var/…, and a home compared by path must be canonical.
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), 'fy-account-apply-')));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const layoutIn = (root: string): FleetLayout => ({
  stateHome: root,
  userHome: path.join(root, 'person'),
  fleetDirectory: path.join(root, 'fleet'),
  binDirectory: path.join(root, 'fleet', 'bin'),
  homesDirectory: path.join(root, 'fleet', 'homes'),
  assetsDirectory: path.join(root, 'fleet', 'assets'),
  manifestPath: path.join(root, 'fleet', 'manifest.json'),
  defaultHomeDirectories: { claude: path.join(root, 'person', '.claude'), codex: path.join(root, 'person', '.codex') },
});

/** One Claude agent on the person's own login and one Codex runtime on an empty Ferretry slot. */
const documentWith = (layers: readonly string[]): AccountModelDocument => ({
  version: 2,
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
    'claude-agent': { credential: 'claude-you', profile: 'default', agent: true },
    'codex-default': { credential: 'codex-slot', profile: 'default' },
  },
});

interface Machine {
  readonly root: string;
  readonly layout: FleetLayout;
  readonly claudeHome: string;
  readonly codexHome: string;
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
  const provisioner = new FileFleetProvisioner(
    [root],
    new SharedHistoryMigration(new FileSharedHistoryFileSystem([root])),
  );
  let ids: RuntimeIds = EMPTY_RUNTIME_IDS;
  const minted = [ID_CLAUDE, ID_CODEX];
  return {
    root,
    layout,
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
      });
      await provisioner.apply(plan);
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
    // The slot has no login yet; the link waits for the sign-in that writes through it.
    should(await readlink(path.join(host.codexHome, 'auth.json'))).equal(
      path.join(host.layout.fleetDirectory, 'credentials', 'codex-slot', 'auth.json'),
    );
    should(await exists(path.join(host.layout.fleetDirectory, 'credentials', 'codex-slot', 'auth.json'))).be.false();
    should(JSON.parse(await readFile(path.join(host.claudeHome, '.claude.json'), 'utf8'))).eql({
      mcpServers: { notes: { type: 'stdio', command: 'notes-server', args: [] } },
    });
    // The overlay names the mode as well: a flag-settings mode keeps the auto-default dialog away.
    should(JSON.parse(await readFile(path.join(host.claudeHome, '.fy', 'fixed.json'), 'utf8'))).eql({
      permissions: { defaultMode: 'bypassPermissions' },
      remoteControlAtStartup: false,
      skipDangerousModePermissionPrompt: true,
      hooks: CLAUDE_QUESTION_HOOKS,
    });
    should(JSON.parse(await readFile(path.join(host.claudeHome, '.fy', 'materialised.json'), 'utf8'))).eql({
      version: 1,
      entries: ['CLAUDE.md'],
    });
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
    should(JSON.parse(await readFile(path.join(host.claudeHome, '.fy', 'materialised.json'), 'utf8')).entries).eql([]);
  });

  it(".claude.json: replace the profile's MCP servers whole and keep Claude's own keys", async () => {
    // Arrange
    const host = await machine();
    await host.apply(['mcp/notes']);
    const claudeJson = path.join(host.claudeHome, '.claude.json');
    const written = JSON.parse(await readFile(claudeJson, 'utf8'));
    await writeFile(
      claudeJson,
      JSON.stringify({ ...written, numStartups: 3, mcpServers: { ...written.mcpServers, old: { command: 'gone' } } }),
    );

    // Act
    await host.apply(['mcp/notes']);

    // Assert
    should(JSON.parse(await readFile(claudeJson, 'utf8'))).eql({
      numStartups: 3,
      mcpServers: { notes: { type: 'stdio', command: 'notes-server', args: [] } },
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
    const fleet = path.join(root, 'fleet');
    await new FileFleetProvisioner([root]).apply({
      manifest: { version: 1, generatedAt: GENERATED_AT, accounts: [] },
      manifestPath: path.join(fleet, 'manifest.json'),
      operations: [operation],
    });
  };

  it('should read an unreadable or malformed record as no record, so only links are removed', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const home = path.join(root, 'fleet', 'homes', 'one');
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

    // Assert
    should(await exists(path.join(home, 'linked.md'))).be.false();
    should(await readFile(path.join(home, 'recorded.md'), 'utf8')).equal('mine\n');
    should(await readFile(path.join(root, 'target.md'), 'utf8')).equal('target\n');
  });

  it('should keep a kept name even when the record lists it', async () => {
    // Arrange
    const root = await temporaryDirectory();
    const home = path.join(root, 'fleet', 'homes', 'one');
    await mkdir(path.join(home, '.fy'), { recursive: true });
    await writeFile(path.join(home, 'kept.md'), 'kept\n');
    await writeFile(path.join(home, 'gone.md'), 'gone\n');
    await writeFile(
      path.join(home, '.fy', 'materialised.json'),
      JSON.stringify({ version: 1, entries: ['kept.md', 'gone.md'] }),
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
    options: { readonly fyStatus?: number; readonly cwdName?: string } = {},
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
        agent: false,
        configDirectory: path.join(root, 'home'),
        env: {},
        args: [],
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
          env: { PATH: `${bin}:/usr/bin:/bin`, HOME: path.join(root, 'person'), FY_SEED_FIRST_RUN: '0' },
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

  it("should keep the person's real HOME", async () => {
    // Arrange
    const { run } = await withWrapper({ env: { LOG_LEVEL: 'debug' } });

    // Act
    const result = await run();

    // Assert
    should(result.harness).match(/^HOME=.*\/person\n$/);
  });

  it('should trust the physical launch folder with exactly the measured Codex override, quotes and backslashes included', async () => {
    // Arrange
    const { run, cwd } = await withWrapper(
      { harness: 'codex', agent: true, trustLaunchFolder: true, args: ['--no-alt-screen'] },
      { cwdName: 'we"ird\\dir' },
    );

    // Act
    const result = await run('resume', '--last');

    // Assert
    should(result.status).equal(0);
    // `cwd` is already physical: its parent came from realpath (which Bun mis-resolves for a name holding a backslash).
    const args = (result.harness as string).split('\n').slice(1, -1);
    should(args).eql(['--no-alt-screen', '-c', codexTrustOverride(cwd), 'resume', '--last']);
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
