/**
 * What an agent runtime's Codex wrapper and materialised home rely on (design §8.3, §8.4, G8).
 *
 * Every claim here was INFERRED in the design and is pinned only by this file:
 *
 * - **Trust override.** The design's `-c projects."<cwd>".trust_level="trusted"` does NOT suppress
 *   the trust prompt on the pinned 0.145.0 — the quotes become part of the key. The spelling that
 *   works is a TOML inline table, `-c 'projects={"<cwd>"={trust_level="trusted"}}'`, and it MERGES
 *   with `config.toml`'s own `projects` table rather than replacing it. It also covers a launch in a
 *   subdirectory of a Git repository, where Codex's own "yes" would trust the whole repository.
 * - **What replaced the trust model from 0.160.** Nothing replaced it for a PROJECT: a folder inside a
 *   Git repository (or holding another project root marker) is still asked about, from 0.156 on a
 *   "Folder access" screen ("Trust this folder?"). What changed is a folder with NO project marker and
 *   no saved decision: Codex no longer asks, and instead starts it on workspace-write with granular
 *   approvals — unless the launch names its own sandbox or approval policy, or a saved trust decision
 *   exists. Ferretry's launch names all three, so its runtimes start in the mode Ferretry chose on
 *   either version; `/status` is read off the real session to say so.
 * - **The correlation root.** The `--add-dir` every Codex session declares is recorded as a workspace
 *   root without being created, and neither is its parent.
 * - **Skills directory.** `<CODEX_HOME>/skills/<item>/SKILL.md` is listed as a user skill, including
 *   when `<item>` is a symlink into an asset tree, which is how the account model materialises it.
 *
 * Each claim is read off the real first screen in a pseudo-terminal beside the control that shows
 * what it suppresses. A claim that changed at a release is gated on the version measured.
 */
import { afterAll, afterEach, beforeAll, describe, it } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import should from 'should';
import { screenOf, startAppServer } from './support/fixtures.ts';
import {
  atLeast,
  contract,
  type HarnessVersion,
  harnessEnv,
  harnessVersion,
  reap,
  run,
  requireHarness,
  type Sandbox,
  sandbox,
} from './support/harness.ts';
import { type RecordingProxy, startProxy } from './support/network.ts';

/** The trust question: 0.145's wording, and the "Folder access" screen's from 0.156. */
const TRUST = /Do you trust the contents of this directory|Trust this folder\?/;
/** The note on a trust screen raised in a subdirectory of a Git repository. */
const REPOSITORY_ROOT = /Trusting will apply to the repository root/;
/** `/status`'s permissions row, which is followed by its `Agents.md` row on both versions. */
const PERMISSIONS = /Permissions: (.+?) (?:│ )*Agents\.md:/;

/** The release from which a folder with no project marker is no longer asked about. */
const PROJECTLESS_UNASKED: HarnessVersion = [0, 160, 0];

/** The override U6's wrapper emits for the launch folder. */
const trustOverride = (cwd: string): string => `projects={${JSON.stringify(cwd)}={trust_level="trusted"}}`;

/** The permission overrides the fixed layer emits, per machine Agent permissions (`CODEX_PERMISSIONS`). */
const AUTO = ['-c', 'approval_policy="on-request"', '-c', 'sandbox_mode="workspace-write"'];
const SKIP = ['-c', 'approval_policy="never"', '-c', 'sandbox_mode="danger-full-access"'];

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/**
 * Past every startup screen: the composer's status line, `<model> <effort> · <folder>`. Not the
 * `OpenAI Codex (v…)` header — from 0.160 that is drawn while the session is still loading, BEFORE
 * the trust check, so settling on it measured nothing.
 */
const composer = (cwd: string): RegExp => new RegExp(`· ${escaped(cwd)}`);

const skillDocument = (name: string): string =>
  `---\nname: ${name}\ndescription: Ferretry contract probe ${name}.\n---\nNothing to do.\n`;

describe.skipIf(!contract.enabled)('codex contract: launching an agent runtime', () => {
  let box: Sandbox;
  let proxy: RecordingProxy;
  let version: HarnessVersion;
  let counter = 0;
  const codex = () => requireHarness('codex');

  beforeAll(async () => {
    box = await sandbox('codex-launch');
    proxy = startProxy();
    version = await harnessVersion(codex().bin, harnessEnv(box.home, proxy.port, { CODEX_HOME: box.dir('version') }));
  });
  afterEach(async () => {
    await reap(box.root);
  });
  afterAll(async () => {
    await reap(box.root);
    proxy.stop();
    await box.dispose();
  });

  /**
   * A runtime home with a fresh fake login, and a working folder: a Git repository unless
   * `projectless`, launched in its `sub` folder when `subdirectory`. `config` is appended to config.toml.
   */
  const runtime = async (
    options: { projectless?: boolean; subdirectory?: boolean; config?: (cwd: string) => string } = {},
  ) => {
    counter++;
    const root = box.dir(`r${counter}`);
    const codexHome = path.join(root, 'codex');
    const work = path.join(root, 'work');
    const home = path.join(root, 'home');
    for (const directory of [codexHome, work, home]) await mkdir(directory, { recursive: true });
    // `.git` is the project root marker Codex discovers by default. From 0.160 a `.git` folder counts
    // only with a `HEAD` in it; nothing reads further than that.
    if (options.projectless !== true) {
      await mkdir(path.join(work, '.git'));
      await writeFile(path.join(work, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    }
    if (options.subdirectory === true) await mkdir(path.join(work, 'sub'));
    const cwd = await realpath(options.subdirectory === true ? path.join(work, 'sub') : work);
    // An API-key login: trust does not depend on how the runtime signs in, and from 0.16x a ChatGPT
    // login makes the TUI call the network while starting, so offline it exits before any prompt.
    await writeFile(path.join(codexHome, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: 'sk-FAKE-contract' }), {
      mode: 0o600,
    });
    await writeFile(
      path.join(codexHome, 'config.toml'),
      `cli_auth_credentials_store = "file"\n${options.config?.(cwd) ?? ''}`,
    );
    const env = harnessEnv(home, proxy.port, { CODEX_HOME: codexHome });
    const screen = (args: string[]) =>
      screenOf([codex().bin, '--no-alt-screen', ...args], { env, cwd, settled: [TRUST, composer(cwd)] });
    /** The permissions `/status` reports for a launch with `args`, or `undefined` when it never got there. */
    const permissions = async (args: string[]) => {
      const shown = await screenOf([codex().bin, '--no-alt-screen', ...args], {
        env,
        cwd,
        cols: 400,
        settled: [TRUST, composer(cwd)],
        afterwards: { type: '/status', settled: [PERMISSIONS] },
      });
      return PERMISSIONS.exec(shown)?.[1];
    };
    return { root, codexHome, cwd, env, screen, permissions };
  };

  it('asks whether to trust a Git project it has no decision for (the control)', async () => {
    const screen = await (await runtime()).screen([]);
    should(screen).match(
      TRUST,
      'codex no longer asks whether to trust an unknown Git project, so the override below measures nothing — find out what replaced the trust model before moving the pin',
    );
  });

  it('asks about a folder with no project marker before 0.160, and from 0.160 starts it unasked', async () => {
    const r = await runtime({ projectless: true });
    const screen = await r.screen([]);
    if (atLeast(version, PROJECTLESS_UNASKED)) {
      should(screen).match(composer(r.cwd));
      should(screen).not.match(TRUST, `codex ${version.join('.')} asks about a projectless folder again`);
    } else {
      should(screen).match(TRUST);
    }
  });

  it('skips the trust prompt with the inline-table -c override for the launch folder', async () => {
    const r = await runtime();
    const screen = await r.screen(['-c', trustOverride(r.cwd)]);
    should(screen).match(composer(r.cwd));
    should(screen).not.match(TRUST);
  });

  it('asks to trust the whole repository from a subdirectory of one (the control)', async () => {
    const screen = await (await runtime({ subdirectory: true })).screen([]);
    should(screen).match(TRUST);
    should(screen).match(REPOSITORY_ROOT);
  });

  it('skips that prompt with the override for the subdirectory alone', async () => {
    const r = await runtime({ subdirectory: true });
    const screen = await r.screen(['-c', trustOverride(r.cwd)]);
    should(screen).match(composer(r.cwd));
    should(screen).not.match(TRUST);
  });

  it("merges the override with config.toml's projects: a folder the file trusts stays trusted", async () => {
    const r = await runtime({ config: cwd => `[projects.${JSON.stringify(cwd)}]\ntrust_level = "trusted"\n` });
    const elsewhere = path.join(r.root, 'some-other-folder');
    const screen = await r.screen(['-c', trustOverride(elsewhere)]);
    should(screen).match(composer(r.cwd));
    should(screen).not.match(TRUST);
  });

  it('from 0.160 starts an unasked projectless folder on its own workspace defaults (the control)', async () => {
    if (!atLeast(version, PROJECTLESS_UNASKED)) return;
    const shown = await (await runtime({ projectless: true })).permissions([]);
    should(shown).equal('Workspace (granular)');
  });

  it("keeps the fixed layer's permission mode in a projectless folder, on either version", async () => {
    const r = await runtime({ projectless: true });
    const trusted = ['-c', trustOverride(r.cwd)];
    should(await r.permissions([...AUTO, ...trusted])).equal('Workspace (Ask for approval)');
    should(await r.permissions([...SKIP, ...trusted])).equal('Full Access');
  });

  it('declares the correlation root as a workspace root, and creates neither it nor its parent', async () => {
    const r = await runtime({ projectless: true });
    const parent = path.join(r.root, 'state', 'sessions', 's1', 'codex-correlation');
    const declared = path.join(parent, 'unreachable');
    await mkdir(path.dirname(parent), { recursive: true });
    const shown = await r.permissions([...AUTO, '-c', trustOverride(r.cwd), '--add-dir', declared]);
    should(shown).equal(`Workspace [${declared}] (Ask for approval)`);
    should(existsSync(declared)).be.false();
    should(existsSync(parent)).be.false();
  });

  // macOS only: Linux's bubblewrap skips a writable root that does not exist, so there neither root
  // is writable whatever its parent is (read off `linux-sandbox/src/bwrap.rs`).
  it.skipIf(process.platform !== 'darwin')(
    'lets a Seatbelt-sandboxed command create a missing writable root, but not one whose parent is missing too',
    async () => {
      const r = await runtime({ projectless: true });
      await mkdir(path.join(r.root, 'state', 'sessions', 's1'), { recursive: true });
      const session = await realpath(path.join(r.root, 'state', 'sessions', 's1'));
      const bare = path.join(session, 'codex-correlation');
      const nested = path.join(session, 'nested', 'unreachable');
      const stray = path.join(session, 'stray');
      const roots = `sandbox_workspace_write.writable_roots=${JSON.stringify([bare, nested])}`;
      const ran = await run(
        [
          codex().bin,
          'sandbox',
          '-c',
          'sandbox_mode="workspace-write"',
          '-c',
          roots,
          // The sandbox lives under $TMPDIR, which workspace-write makes writable by default; a
          // Ferretry session directory is under neither it nor /tmp.
          '-c',
          'sandbox_workspace_write.exclude_tmpdir_env_var=true',
          '-c',
          'sandbox_workspace_write.exclude_slash_tmp=true',
          '--',
          '/bin/sh',
          '-c',
          'mkdir "$1"; echo "stray=$?"; mkdir "$2"; echo "bare=$?"; mkdir -p "$3"; echo "nested=$?"',
          'sh',
          stray,
          bare,
          nested,
        ],
        { env: r.env, cwd: r.cwd },
      );
      // That the measurement is isolated: a folder beside them that is no root cannot be made.
      should(ran.stdout).match(/stray=[1-9]/u, `${ran.stdout}\n${ran.stderr}`);
      should(existsSync(stray)).be.false();
      // The control: a missing root whose parent exists becomes writable, which is why Ferretry's
      // correlation root sits one level further down.
      should(ran.stdout).match(/bare=0/u, `${ran.stdout}\n${ran.stderr}`);
      should(existsSync(bare)).be.true();
      should(ran.stdout).match(/nested=[1-9]/u, `${ran.stdout}\n${ran.stderr}`);
      should(existsSync(path.dirname(nested))).be.false();
    },
  );

  it('lists skills under skills/<item>, including an item that is a symlink into an asset tree', async () => {
    const r = await runtime();
    await mkdir(path.join(r.codexHome, 'skills', 'fy-contract-real'), { recursive: true });
    await writeFile(
      path.join(r.codexHome, 'skills', 'fy-contract-real', 'SKILL.md'),
      skillDocument('fy-contract-real'),
    );
    const asset = path.join(r.root, 'assets', 'fy-contract-linked');
    await mkdir(asset, { recursive: true });
    await writeFile(path.join(asset, 'SKILL.md'), skillDocument('fy-contract-linked'));
    await symlink(asset, path.join(r.codexHome, 'skills', 'fy-contract-linked'));

    const server = await startAppServer(codex().bin, { env: r.env, cwd: r.cwd });
    try {
      const answer = (await server.request('skills/list', { cwds: [r.cwd], forceReload: true })) as {
        result?: { data?: { skills?: { name: string; scope: string }[] }[] };
      };
      const skills = (answer.result?.data ?? []).flatMap(entry => entry.skills ?? []);
      const user = skills.filter(skill => skill.scope === 'user').map(skill => skill.name);
      should(user).containEql('fy-contract-real').and.containEql('fy-contract-linked');
    } finally {
      await server.stop();
    }
  });
});
