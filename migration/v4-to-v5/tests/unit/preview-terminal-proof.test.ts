/**
 * The terminal the preview daemon opens finds the preview's `fy` and FY_HOME (the start's terminal proof), now that the
 * daemon's HOME is the empty no-host-creds one. The shell is a REAL zsh on a pty in a temp dir (what a tmux pane is, minus
 * tmux): with no zsh startup file in HOME, zsh runs its first-run menu and swallows the keys typed into the pane, so the
 * proof read nothing ("fy at nowhere, FY_HOME unset"). Nothing real is read: temp dirs, a stub `fy`, no daemon, no tmux.
 *
 * The libexec tests are the other half: `clean` then `prepare` must not lose the programs `build` installed.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanPreview, HOME_SHELL_RC, libexecParkFor, prepare, shimText, wrapperText } from '../../preview/driver.ts';
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
const canRunPane = process.platform === 'linux' && has('zsh') && has('script');

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
    read: () => output.replaceAll('\r', ''),
    close: () => child.kill(),
  };
}

/**
 * `fy5 ps|terminal ...` as the daemon answers them, over a real pane. A pane gets what a daemon-opened terminal gets: the
 * kernel's child environment (the daemon's PATH and HOME) plus Terminals' `environment` (the preview's FY_*).
 */
function daemonTerminals(home: string, hostile: Record<string, string>): { run: Run; closed: () => number } {
  const probe = wrapper(home, ['__daemon-probe', 'sh', '-c', 'printf "%s\\n%s" "$PATH" "$HOME"'], hostile);
  const [paneRoute = '', paneHome = ''] = probe.stdout.toString().split('\n');
  const env = { PATH: paneRoute, HOME: paneHome, TERM: 'xterm', ...previewShellEnv(home, PREVIEW.port) };
  let open: ReturnType<typeof pane> | undefined;
  let closes = 0;
  const run: Run = async argv => {
    const [, verb, action] = argv;
    if (verb === 'ps') return { code: 0, stdout: JSON.stringify([{ id: 'ferret1' }]) };
    if (action === 'open') {
      open = pane('zsh', env);
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
    open?.close();
    return { code: 0, stdout: '' };
  };
  return { run, closed: () => closes };
}

describe('TTP-1 the terminal the preview daemon opens finds the preview fy and FY_HOME', () => {
  test.skipIf(!canRunPane)(
    'TTP-1a a real zsh in the daemon HOME (the wrapper-made one) runs the typed proof command',
    async () => {
      const { home, hostile } = await previewHome();
      expect(wrapper(home, ['daemon', 'start'], hostile).exitCode).toBe(0);
      const terminals = daemonTerminals(home, hostile);
      const done = await terminalCheck({
        target: home,
        v4Home: V4,
        callerEnv: hostile,
        run: terminals.run,
      });
      expect(done.problems).toEqual([]);
      expect(done.ok).toBe(true);
      expect(done.passed.join('\n')).toContain(
        `finds the preview's fy (${join(home, 'bin', 'fy')}) and FY_HOME ${home}`,
      );
      expect(terminals.closed()).toBe(1);
    },
    30_000,
  );

  test.skipIf(!canRunPane)(
    'TTP-1b the proof stays strict: a pane whose PATH finds v4 fy, or lacks FY_HOME, is still refused',
    async () => {
      const { home, hostile } = await previewHome();
      wrapper(home, ['daemon', 'start'], hostile);
      const terminals = daemonTerminals(home, hostile);
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

  test('TTP-1c the wrapper makes the daemon HOME with exactly one file, an empty 0600 shell rc, and nothing else', async () => {
    const { home, hostile } = await previewHome();
    expect(wrapper(home, ['daemon', 'start'], hostile).exitCode).toBe(0);
    const base = join(home, PREVIEW.noCredsFolder, 'home');
    expect(await readdir(base)).toEqual([HOME_SHELL_RC]);
    const rc = await stat(join(base, HOME_SHELL_RC));
    expect(rc.isFile()).toBe(true);
    expect(rc.size).toBe(0);
    expect(rc.mode & 0o777).toBe(0o600);
    // A start makes it fresh: whatever a pane left in it is gone, and the file is empty again.
    await writeFile(join(base, HOME_SHELL_RC), 'export GH_TOKEN=fake\n');
    await writeFile(join(base, '.netrc'), 'fake\n');
    wrapper(home, ['daemon', 'start'], hostile);
    expect(await readdir(base)).toEqual([HOME_SHELL_RC]);
    expect(await readFile(join(base, HOME_SHELL_RC), 'utf8')).toBe('');
  });

  test('TTP-1d the shipped proof command reads fy and FY_HOME, and the done word is split so the typed line cannot match it', () => {
    expect(CHECK_COMMAND).toContain('command -v fy');
    expect(CHECK_COMMAND).toContain('$FY_HOME');
    expect(CHECK_COMMAND).not.toContain('FYCHECK-DONE');
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
