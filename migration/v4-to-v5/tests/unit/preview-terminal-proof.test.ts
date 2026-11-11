/**
 * The terminal the preview daemon opens finds the preview's `fy` and FY_HOME (the start's terminal proof), now that the
 * daemon's HOME is the empty no-host-creds one. The shell is a REAL zsh on a pty in a temp dir (what a tmux pane is, minus
 * tmux): with no zsh startup file in HOME, zsh runs its first-run menu and swallows the keys typed into the pane, so the
 * proof read nothing ("fy at nowhere, FY_HOME unset"). Nothing real is read: temp dirs, a stub `fy`, no daemon, no tmux.
 *
 * The libexec tests are the other half: `clean` then `prepare` must not lose the programs `build` installed.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { cleanPreview, HOME_SHELL_RC, libexecParkFor, prepare, shimText, wrapperText } from '../../preview/driver.ts';
import { TerminalsConfigSchema } from '@ferretry/plugin-terminals/contract';
import { quietYaml as parseYaml } from '../../src/v4/config.ts';
import { TmuxTerminalRuntime } from '../../../../packages/plugins/terminals/daemon/adapters/terminal/tmux-terminal-runtime.ts';
import { credentialCheck } from '../../preview/credential-check.ts';
import { inspectPath } from '../../preview/inspect-path.ts';
import { PREVIEW } from '../../preview/plan.ts';
import { CHECK_COMMAND, terminalCheck, type Run } from '../../preview/start-checks.ts';
import { previewShellEnv } from '../../src/v5/preview-env.ts';
import { fixture } from './ferret-fixture.ts';

let root = '';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'preview-terminal-proof-'));
});
afterEach(() => rm(root, { recursive: true, force: true }));

const V4 = '/nonexistent-v4/.ferretry';
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const has = (program: string): boolean => Bun.which(program) !== null;
const canRunPane = process.platform === 'linux' && has('script');

/** The login shell the passwd entry names for this user (what Terminals opens as `[shell, "-l"]`), or undefined. */
const passwdShell = (): string | undefined => {
  const line = Bun.spawnSync(['getent', 'passwd', userInfo().username]).stdout.toString().trim();
  const shell = line.split(':')[6];
  return shell !== undefined && shell !== '' && has(shell) ? shell : undefined;
};
/** A bash on this box, the other login shell a pane may be. */
const bashShell = (): string | undefined => Bun.which('bash') ?? undefined;
const PASSWD = passwdShell();
const BASH = bashShell();
/** The kernel's own rule for what a child of the daemon gets (not exported by the package, so loaded by path). */
const { childEnvironment } = (await import(
  join(import.meta.dir, '../../../../packages/core/kernel/host/adapters/process.ts')
)) as {
  childEnvironment: (
    program: string,
    base: Record<string, string>,
    tools: Record<string, string>,
    extra: Record<string, string>,
  ) => Record<string, string>;
};

/** A preview home: the real wrapper, the pinning shim, a stub raw `fy`, and the host's PATH (with a hostile v4 `fy` on it). */
async function previewHome(): Promise<{ home: string; hostile: Record<string, string> }> {
  const home = join(root, 'v5');
  const v4Bin = join(root, 'v4-bin');
  await mkdir(join(home, 'bin'), { recursive: true });
  await mkdir(join(home, 'libexec'), { recursive: true });
  await mkdir(v4Bin);
  await writeFile(join(home, 'libexec/fy'), '#!/bin/sh\nenv\n', { mode: 0o755 });
  await writeFile(join(home, 'bin/fy5'), wrapperText(home, V4), { mode: 0o755 });
  await writeFile(join(home, 'bin/fy'), shimText(home, 'fy'), { mode: 0o755 });
  await writeFile(join(v4Bin, 'fy'), '#!/bin/sh\necho v4\n', { mode: 0o755 });
  return {
    home,
    hostile: { PATH: `${v4Bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: join(root, 'real-home'), USER: 'u' },
  };
}

const wrapper = (home: string, args: string[], env: Record<string, string>) =>
  Bun.spawnSync([join(home, 'bin/fy5'), ...args], { env });

/** A pane: the daemon's login shell (`<shell> -l`) on a pty, with the keys typed into it after it starts. */
function pane(shell: string, env: Record<string, string>) {
  const child = Bun.spawn(['script', '-qec', `${shell} -l`, '/dev/null'], {
    env,
    cwd: root,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'ignore',
  });
  let output = '';
  const decoder = new TextDecoder();
  void (async () => {
    for await (const chunk of child.stdout) output += decoder.decode(chunk);
  })();
  return {
    type: (text: string) => {
      child.stdin.write(text);
      void child.stdin.flush();
    },
    // What tmux's capture-pane gives: the screen's text, without the escape sequences a shell prints (bash's bracketed paste).
    read: () => output.replaceAll('\r', '').replace(/\u001b\[[0-9;?]*[a-zA-Z]/gu, ''),
    close: () => child.kill(),
  };
}

/** The real Terminals runtime over a recording tmux: the `-e NAME=value` words of the `new-session` it sends, as an environment. */
async function runtimeEnvironment(environment: Readonly<Record<string, string>>): Promise<Record<string, string>> {
  const calls: (readonly string[])[] = [];
  const { environment: accepted } = TerminalsConfigSchema.parse({ environment });
  const runtime = new TmuxTerminalRuntime(
    {
      execute: async args => {
        calls.push(args);
        return { code: 0, stdout: '', stderr: '' };
      },
    },
    () => 1_000,
    { shell: async () => '/bin/sh' },
    undefined,
    () => accepted ?? {},
  );
  await runtime.create({
    ownerId: 'session-a',
    id: '0123456789ab',
    title: 'Terminal 1',
    cwd: '/tmp',
    size: { cols: 100, rows: 30 },
    openedBy: { by: 'local' },
  });
  const argv = calls[0] ?? [];
  expect(argv[0]).toBe('new-session');
  return Object.fromEntries(
    argv.flatMap((word, at) =>
      argv[at - 1] === '-e' ? [[word.slice(0, word.indexOf('=')), word.slice(word.indexOf('=') + 1)]] : [],
    ),
  );
}

/**
 * `fy5 ps|terminal ...` as the daemon answers them, over a real pane. A pane gets what a daemon-opened terminal gets: the
 * kernel's child environment (the daemon's PATH and HOME) plus Terminals' `environment` (the preview's FY_*).
 */
async function daemonTerminals(
  shell: string,
  home: string,
  hostile: Record<string, string>,
): Promise<{ run: Run; closed: () => number; zdotInPane: () => string | undefined }> {
  const probe = wrapper(home, ['__daemon-probe', 'sh', '-c', 'printf "%s\\n%s" "$PATH" "$HOME"'], hostile);
  const [paneRoute = '', paneHome = ''] = probe.stdout.toString().split('\n');
  // The environment the REAL Terminals runtime hands a new pane (`new-session -e NAME=value`), from the environment the
  // converter wrote into terminals.yaml, not from previewShellEnv directly.
  const env = {
    PATH: paneRoute,
    HOME: paneHome,
    TERM: 'xterm',
    ...(await runtimeEnvironment(previewShellEnv(home, PREVIEW.port))),
  };
  let zdot: string | undefined;
  let open: ReturnType<typeof pane> | undefined;
  let closes = 0;
  const run: Run = async argv => {
    const [, verb, action] = argv;
    if (verb === 'ps') return { code: 0, stdout: JSON.stringify([{ id: 'ferret1' }]) };
    if (action === 'open') {
      open = pane(shell, env);
      await sleep(400);
      open.type(`${argv.at(-1) ?? ''}\n`);
      return { code: 0, stdout: '' };
    }
    if (action === 'wait') {
      for (let tries = 0; tries < 60 && !(open?.read() ?? '').includes('FYCHECK-DONE'); tries++) await sleep(100);
      return { code: 0, stdout: '' };
    }
    if (action === 'read') return { code: 0, stdout: open?.read() ?? '' };
    closes++;
    open?.type('printf "ZDOT=%s\\n" "$ZDOTDIR"\n');
    await sleep(400);
    zdot = /^ZDOT=(.*)$/mu.exec(open?.read() ?? '')?.[1];
    // The shell leaves as a pane does (so a bash writes its history), then the pane goes.
    open?.type('exit\n');
    await sleep(600);
    open?.close();
    return { code: 0, stdout: '' };
  };
  return { run, closed: () => closes, zdotInPane: () => zdot };
}

describe('TTP-1 the terminal the preview daemon opens finds the preview fy and FY_HOME', () => {
  // The real start order: `fy5 daemon start`, `terminalCheck` over a pane of the shell Terminals resolves, THEN `credentialCheck`.
  // The pane's shell writes its own files (zsh: .zcompdump, bash: .bash_history); the daemon HOME must stay empty.
  const startOrder = async (shell: string) => {
    const { home, hostile } = await previewHome();
    await writeFile(join(home, 'bin', 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    expect(wrapper(home, ['daemon', 'start'], hostile).exitCode).toBe(0);
    const terminals = await daemonTerminals(shell, home, hostile);
    const proof = await terminalCheck({ target: home, v4Home: V4, callerEnv: hostile, run: terminals.run });
    const creds = await credentialCheck({
      target: home,
      callerEnv: hostile,
      childEnvironment: (program, base) => childEnvironment(program, { ...base }, {}, {}),
      run: async (argv, env) => {
        const done = Bun.spawnSync([...argv], { env: { ...env } });
        return { code: done.exitCode ?? undefined, stdout: done.stdout.toString() };
      },
      inspect: inspectPath,
    });
    return { home, proof, creds, terminals };
  };

  test.skipIf(!canRunPane || PASSWD === undefined)(
    'TTP-1a the passwd login shell in a pane runs the typed proof command, and the credential check passes after it',
    async () => {
      const { home, proof, creds, terminals } = await startOrder(PASSWD as string);
      expect(proof.problems).toEqual([]);
      expect(proof.ok).toBe(true);
      expect(proof.passed.join('\n')).toContain(
        `finds the preview's fy (${join(home, 'bin', 'fy')}) and FY_HOME ${home}`,
      );
      expect(terminals.closed()).toBe(1);
      // The HOME is still empty; whatever the shell wrote went to zdot/, beside the one empty rc.
      expect(await readdir(join(home, PREVIEW.noCredsFolder, 'home'))).toEqual([]);
      expect(await readdir(join(home, PREVIEW.noCredsFolder, 'zdot'))).toContain(HOME_SHELL_RC);
      expect(creds.problems).toEqual([]);
      expect(creds.ok).toBe(true);
      // ZDOTDIR REACHED the pane (through the runtime's new-session -e words), and it is the preview-owned folder.
      expect(terminals.zdotInPane()).toBe(join(home, PREVIEW.noCredsFolder, 'zdot'));
    },
    60_000,
  );

  test.skipIf(!canRunPane || BASH === undefined)(
    'TTP-1e a bash login shell in a pane leaves the daemon HOME empty, and the credential check passes (its history lands in zdot/)',
    async () => {
      const { home, proof, creds } = await startOrder(BASH as string);
      expect(proof.problems).toEqual([]);
      expect(await readdir(join(home, PREVIEW.noCredsFolder, 'home'))).toEqual([]);
      expect(creds.problems).toEqual([]);
      expect(creds.ok).toBe(true);
    },
    60_000,
  );

  test.skipIf(!canRunPane)(
    'TTP-1b the proof stays strict: a pane whose PATH finds v4 fy, or lacks FY_HOME, is still refused',
    async () => {
      const { home, hostile } = await previewHome();
      wrapper(home, ['daemon', 'start'], hostile);
      const terminals = await daemonTerminals(PASSWD ?? BASH ?? 'sh', home, hostile);
      // A pane that ran the command in a shell that knows nothing of the preview: the proof reads fy and home of THAT.
      const done = await terminalCheck({
        target: home,
        v4Home: V4,
        callerEnv: hostile,
        run: async (argv, env) => {
          if (argv[2] === 'open')
            return terminals.run([argv[0] as string, 'terminal', 'open', 'x', '--ferret', 'f', 'true'], env);
          if (argv[2] === 'read') return { code: 0, stdout: 'fy=/usr/bin/fy\nhome=\n' };
          return terminals.run(argv, env);
        },
      });
      expect(done.ok).toBe(false);
      expect(done.problems.join('\n')).toContain('found fy at /usr/bin/fy and FY_HOME unset');
    },
    30_000,
  );

  test('TTP-1c a daemon start makes the HOME empty and zdot/ with exactly one file, an empty 0600 shell rc', async () => {
    const { home, hostile } = await previewHome();
    expect(wrapper(home, ['daemon', 'start'], hostile).exitCode).toBe(0);
    const base = join(home, PREVIEW.noCredsFolder);
    expect(await readdir(join(base, 'home'))).toEqual([]);
    expect((await stat(join(base, 'zdot'))).mode & 0o777).toBe(0o700);
    expect(await readdir(join(base, 'zdot'))).toEqual([HOME_SHELL_RC]);
    const rc = await stat(join(base, 'zdot', HOME_SHELL_RC));
    expect(rc.isFile()).toBe(true);
    expect(rc.size).toBe(0);
    expect(rc.mode & 0o777).toBe(0o600);
    // A start makes it fresh: whatever a pane left in them is gone, and the file is empty again.
    await writeFile(join(base, 'zdot', HOME_SHELL_RC), 'export GH_TOKEN=fake\n');
    await writeFile(join(base, 'zdot', '.netrc'), 'fake\n');
    await writeFile(join(base, 'home', '.netrc'), 'fake\n');
    wrapper(home, ['daemon', 'start'], hostile);
    expect(await readdir(join(base, 'home'))).toEqual([]);
    expect(await readdir(join(base, 'zdot'))).toEqual([HOME_SHELL_RC]);
    expect(await readFile(join(base, 'zdot', HOME_SHELL_RC), 'utf8')).toBe('');
  });

  test('TTP-1d the shipped proof command reads fy and FY_HOME, and the done word is split so the typed line cannot match it', () => {
    expect(CHECK_COMMAND).toContain('command -v fy');
    expect(CHECK_COMMAND).toContain('$FY_HOME');
    expect(CHECK_COMMAND).not.toContain('FYCHECK-DONE');
  });
});

/** The credential check over a started wrapper home, with the real file system and no `gh` the host could sign in with. */
async function checked(home: string, hostile: Record<string, string>) {
  return credentialCheck({
    target: home,
    callerEnv: hostile,
    childEnvironment: (program, base) => childEnvironment(program, { ...base }, {}, {}),
    run: async (argv, env) => {
      const done = Bun.spawnSync([...argv], { env: { ...env } });
      return { code: done.exitCode ?? undefined, stdout: done.stdout.toString() };
    },
    inspect: inspectPath,
  });
}

describe('TTP-3 only a daemon start writes the shell rc, and a link is never followed or accepted', () => {
  test('TTP-3a status and __daemon-probe do not write or truncate the rc (a file planted since stays as it is)', async () => {
    const { home, hostile } = await previewHome();
    expect(wrapper(home, ['daemon', 'start'], hostile).exitCode).toBe(0);
    const rc = join(home, PREVIEW.noCredsFolder, 'zdot', HOME_SHELL_RC);
    await writeFile(rc, 'planted\n');
    wrapper(home, ['status'], hostile);
    wrapper(home, ['__daemon-probe', 'true'], hostile);
    expect(await readFile(rc, 'utf8')).toBe('planted\n');
  });

  test('TTP-3b a symlinked rc is not followed by status or a probe, and the check refuses it', async () => {
    const { home, hostile } = await previewHome();
    expect(wrapper(home, ['daemon', 'start'], hostile).exitCode).toBe(0);
    const zdot = join(home, PREVIEW.noCredsFolder, 'zdot');
    const target = join(root, 'fake-real-rc');
    await writeFile(target, 'fake-content\n', { mode: 0o600 });
    await rm(join(zdot, HOME_SHELL_RC));
    await symlink(target, join(zdot, HOME_SHELL_RC));
    wrapper(home, ['status'], hostile);
    wrapper(home, ['__daemon-probe', 'true'], hostile);
    expect(await readFile(target, 'utf8')).toBe('fake-content\n');
    // Even a link to an EMPTY 0600 file (what stat would accept as "the one empty rc") is refused.
    await writeFile(target, '', { mode: 0o600 });
    const done = await checked(home, hostile);
    expect(done.ok).toBe(false);
    expect(done.problems.join('\n')).toContain('zdot/ is not a 0700 folder');
  });

  test('TTP-3c a symlinked zdot folder is not followed by status or a probe, and the check refuses it', async () => {
    const { home, hostile } = await previewHome();
    expect(wrapper(home, ['daemon', 'start'], hostile).exitCode).toBe(0);
    const zdot = join(home, PREVIEW.noCredsFolder, 'zdot');
    const elsewhere = join(root, 'fake-real-home');
    await mkdir(elsewhere, { mode: 0o700 });
    await writeFile(join(elsewhere, HOME_SHELL_RC), 'fake-content\n', { mode: 0o600 });
    await rm(zdot, { recursive: true });
    await symlink(elsewhere, zdot);
    wrapper(home, ['status'], hostile);
    wrapper(home, ['__daemon-probe', 'true'], hostile);
    expect(await readFile(join(elsewhere, HOME_SHELL_RC), 'utf8')).toBe('fake-content\n');
    // Even a link to an empty 0700 folder holding one empty 0600 rc is refused.
    await writeFile(join(elsewhere, HOME_SHELL_RC), '', { mode: 0o600 });
    const done = await checked(home, hostile);
    expect(done.ok).toBe(false);
    expect(done.problems.join('\n')).toContain('zdot/ is not a 0700 folder');
  });

  test('TTP-3d a start replaces a link planted at the rc, the folder or the HOME and writes through none of them', async () => {
    const { home, hostile } = await previewHome();
    const base = join(home, PREVIEW.noCredsFolder);
    await mkdir(base, { recursive: true, mode: 0o700 });
    const elsewhere = join(root, 'fake-real-home');
    await mkdir(elsewhere, { mode: 0o700 });
    await writeFile(join(elsewhere, HOME_SHELL_RC), 'fake-content\n', { mode: 0o600 });
    await symlink(elsewhere, join(base, 'zdot'));
    await symlink(elsewhere, join(base, 'home'));
    expect(wrapper(home, ['daemon', 'start'], hostile).exitCode).toBe(0);
    expect(await readFile(join(elsewhere, HOME_SHELL_RC), 'utf8')).toBe('fake-content\n');
    expect(await readdir(join(base, 'zdot'))).toEqual([HOME_SHELL_RC]);
    expect(await readdir(elsewhere)).toEqual([HOME_SHELL_RC]);
  });
});

describe("TTP-4 the credential check: a shell's own state files in zdot/ by name, any other name refused", () => {
  test("TTP-4a the shells' state names beside the rc are tolerated, by name only", async () => {
    const { home, hostile } = await previewHome();
    await writeFile(join(home, 'bin', 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    expect(wrapper(home, ['daemon', 'start'], hostile).exitCode).toBe(0);
    const zdot = join(home, PREVIEW.noCredsFolder, 'zdot');
    for (const name of ['.zcompdump', '.zcompdump-host-5.9', '.zsh_history', '.bash_history'])
      await writeFile(join(zdot, name), 'x\n');
    await mkdir(join(zdot, '.zsh_sessions'));
    const done = await checked(home, hostile);
    expect(done.problems).toEqual([]);
    expect(done.ok).toBe(true);
  });

  for (const name of ['.netrc', '.npmrc', '.ssh', '.config', '.zshenv', '.zcompdumpx']) {
    test(`TTP-4b a file named ${name} in the HOME or in zdot/ is refused (names only in the message)`, async () => {
      const { home, hostile } = await previewHome();
      await writeFile(join(home, 'bin', 'gh'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      for (const folder of ['home', 'zdot']) {
        expect(wrapper(home, ['daemon', 'start'], hostile).exitCode).toBe(0);
        const where = join(home, PREVIEW.noCredsFolder, folder);
        await writeFile(join(where, name), 'fake-secret-content\n');
        const done = await checked(home, hostile);
        expect(done.ok).toBe(false);
        expect(done.problems.join('\n')).toContain(`${folder}/ is not`);
        expect(done.problems.join('\n')).not.toContain('fake-secret-content');
        expect(done.problems.join('\n')).not.toContain(name);
      }
    });
  }

  test('TTP-4c inspectPath is lstat-based: a link to an empty private folder or file is other, a folder lists its names', async () => {
    const folder = join(root, 'f');
    await mkdir(folder, { mode: 0o700 });
    await chmod(folder, 0o700);
    await writeFile(join(folder, 'a'), '');
    await symlink(folder, join(root, 'link-to-folder'));
    await symlink(join(folder, 'a'), join(root, 'link-to-file'));
    expect(await inspectPath(join(root, 'link-to-folder'))).toMatchObject({ kind: 'other', entries: 0 });
    expect(await inspectPath(join(root, 'link-to-file'))).toMatchObject({ kind: 'other' });
    expect(await inspectPath(folder)).toMatchObject({ kind: 'dir', mode: 0o700, entries: 1, names: ['a'] });
    expect(await inspectPath(join(folder, 'a'))).toMatchObject({ kind: 'file', size: 0 });
    expect(await inspectPath(join(root, 'nothing'))).toBeUndefined();
  });
});

describe("TTP-5 ZDOTDIR reaches a pane the daemon opens: terminals.yaml environment, then the runtime's new-session -e", () => {
  test('TTP-5a prepare writes ZDOTDIR and HISTFILE into config/terminals.yaml; Terminals accepts them and hands them to the pane', async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.from, 'layout-version'), '2\n');
      await mkdir(join(f.from, 'config'), { recursive: true });
      await writeFile(join(f.from, 'config/machine.yaml'), 'timeZone: UTC\n');
      const home = join(f.root, 'home');
      await mkdir(home);
      await prepare({
        v4Home: f.from,
        target: f.to,
        lock: { held: async () => false },
        now: () => new Date('2026-11-10T00:00:00Z'),
        home,
      });
      const text = await readFile(join(f.to, 'config/terminals.yaml'), 'utf8');
      const written = TerminalsConfigSchema.parse(parseYaml(text)).environment ?? {};
      const zdot = join(f.to, PREVIEW.noCredsFolder, 'zdot');
      expect(written.ZDOTDIR).toBe(zdot);
      expect(written.HISTFILE).toBe(join(zdot, '.bash_history'));
      // The runtime puts every entry into the pane's own environment.
      const pane = await runtimeEnvironment(written);
      expect(pane.ZDOTDIR).toBe(zdot);
      expect(pane.HISTFILE).toBe(join(zdot, '.bash_history'));
      expect(pane.FY_HOME).toBe(f.to);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});

describe('TTP-2 clean then prepare keeps the programs build installed', () => {
  /** A prepared preview home with a built `libexec` in it. */
  async function built() {
    const f = await fixture();
    await writeFile(join(f.from, 'layout-version'), '2\n');
    await mkdir(join(f.from, 'config'), { recursive: true });
    await writeFile(join(f.from, 'config/machine.yaml'), 'timeZone: UTC\n');
    const home = join(f.root, 'home');
    await mkdir(home);
    const again = () =>
      prepare({
        v4Home: f.from,
        target: f.to,
        lock: { held: async () => false },
        now: () => new Date('2026-11-10T00:00:00Z'),
        home,
      });
    await again();
    await mkdir(join(f.to, 'libexec'));
    await writeFile(join(f.to, 'libexec/fy'), 'built-fy\n', { mode: 0o755 });
    return { f, home, again };
  }

  test('TTP-2a clean parks libexec beside the home and says so; prepare puts it back', async () => {
    const { f, home, again } = await built();
    try {
      const said = await cleanPreview(f.from, f.to, home);
      expect(said).toContain(libexecParkFor(f.to));
      expect(await stat(f.to).catch(() => undefined)).toBeUndefined();
      expect(await readFile(join(libexecParkFor(f.to), 'fy'), 'utf8')).toBe('built-fy\n');
      const second = await again();
      expect(second.report?.complete).toBe(true);
      expect(await readFile(join(f.to, 'libexec/fy'), 'utf8')).toBe('built-fy\n');
      expect(await stat(libexecParkFor(f.to)).catch(() => undefined)).toBeUndefined();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test('TTP-2b a clean with no libexec parks nothing and leaves an older park alone only until replaced', async () => {
    const { f, home, again } = await built();
    try {
      await rm(join(f.to, 'libexec'), { recursive: true });
      expect(await cleanPreview(f.from, f.to, home)).not.toContain('kept');
      expect(await stat(libexecParkFor(f.to)).catch(() => undefined)).toBeUndefined();
      // prepare with nothing parked makes a home with no libexec (the owner builds after it).
      await again();
      expect(await stat(join(f.to, 'libexec')).catch(() => undefined)).toBeUndefined();
      // A newer build replaces an older park.
      await mkdir(libexecParkFor(f.to));
      await writeFile(join(libexecParkFor(f.to), 'old'), 'old\n');
      await mkdir(join(f.to, 'libexec'));
      await writeFile(join(f.to, 'libexec/fy'), 'newer\n');
      await cleanPreview(f.from, f.to, home);
      expect(await readdir(libexecParkFor(f.to))).toEqual(['fy']);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});
