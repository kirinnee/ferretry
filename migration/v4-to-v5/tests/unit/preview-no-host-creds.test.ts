/**
 * The preview daemon reaches NO host credential (!A469): the one environment builder (the `fy5` wrapper) strips every
 * credential by allow-list, gives the daemon an empty HOME, an empty `gh` folder and an empty git config, and the start
 * check proves it. Every value here is FAKE; nothing real is read, and no program but the stubs below is run.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialCheck, credentialNames, readDaemonEnviron, type Inspected } from '../../preview/credential-check.ts';
import { HOME_SHELL_RC, noCredsValues, shimText, wrapperText } from '../../preview/driver.ts';
import { PREVIEW } from '../../preview/plan.ts';
import type { Run } from '../../preview/start-checks.ts';
import { stopPreview } from '../../preview/stop.ts';

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
const kernelChild = (program: string, base: Readonly<Record<string, string>>) =>
  childEnvironment(program, { ...base }, {}, {});

/**
 * A FAKE real `ssh`: logs its arguments and answers `-G` the way OpenSSH does: with `-F /dev/null` and `IdentityFile=none`
 * the alias comes back unchanged and there is no identity; without them a (fake) user config rewrites the host name and
 * names a key.
 */
const fakeSsh = (log: string): string =>
  [
    '#!/bin/sh',
    `echo "$@" >> "${log}"`,
    'case " $* " in',
    '  *" -G "*)',
    '    for last in "$@"; do :; done',
    '    case " $* " in',
    '      *" -F /dev/null "*) echo "hostname $last" ;;',
    '      *) echo "hostname rewritten-by-fake-user-config" ;;',
    '    esac',
    '    case " $* " in',
    '      *" IdentityFile=none "*) echo "identityfile none" ;;',
    '      *) echo "identityfile ~/.ssh/id_fake" ;;',
    '    esac',
    '    exit 0',
    '    ;;',
    'esac',
    'exit 1',
    '',
  ].join('\n');

let root = '';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'preview-no-host-creds-'));
});
afterEach(() => rm(root, { recursive: true, force: true }));

const FAKE = 'fake-not-a-token';

/** Every credential name the brief lists, plus a few nobody named (the allow-list must stop those too). */
const HOSTILE_NAMES = [
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GH_HOST',
  'GH_CONFIG_DIR',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'GIT_SSH_COMMAND',
  'GIT_SSH',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_KEY_0',
  'GIT_CONFIG_VALUE_0',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'SSH_AUTH_SOCK',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_PROFILE',
  'AZURE_CLIENT_SECRET',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GCLOUD_PROJECT',
  'NPM_TOKEN',
  'NPM_CONFIG_USERCONFIG',
  'DOCKER_CONFIG',
  'DOCKER_HOST',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CODEX_HOME',
  'SOME_NEW_CLOUD_TOKEN',
  'SOME_SERVICE_KEY',
  'SOME_SERVICE_SECRET',
  'SOME_SERVICE_PASSWORD',
  'SOME_SERVICE_PASS',
  'SOME_SERVICE_CREDENTIALS',
] as const;

/** A preview home with the wrapper and a stub `fy` that prints its environment, and a stubs folder for fake programs. */
async function previewHome(): Promise<{ home: string; stubs: string; hostile: Record<string, string> }> {
  const home = join(root, 'v5');
  const stubs = join(root, 'stubs');
  await mkdir(join(home, 'bin'), { recursive: true });
  await mkdir(join(home, 'libexec'), { recursive: true });
  await mkdir(stubs);
  await writeFile(join(stubs, 'ssh'), fakeSsh(join(root, 'ssh.log')), { mode: 0o755 });
  await writeFile(join(home, 'libexec/fy'), '#!/bin/sh\nprintf "arg:%s\\n" "$@"\nenv\n', { mode: 0o755 });
  await writeFile(join(home, 'bin/fy5'), wrapperText(home, '/nonexistent-v4/.ferretry'), { mode: 0o755 });
  await writeFile(join(home, 'bin/fy'), shimText(home, 'fy'), { mode: 0o755 });
  const hostile: Record<string, string> = {
    PATH: `${stubs}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    HOME: join(root, 'real-home'),
    USER: 'u',
    ...Object.fromEntries(HOSTILE_NAMES.map(name => [name, `${FAKE}-${name}`])),
  };
  return { home, stubs, hostile };
}

const spawn = (argv: string[], env: Record<string, string>) => Bun.spawnSync(argv, { env });

/**
 * A PATH with the system's programs but no `gh`, on any host: a GitHub runner ships `/usr/bin/gh`, so a bare
 * `/usr/bin:/bin` is not "no gh" there (CI run 42926458871 failed NHC-3b on exactly that). Every entry of
 * `/usr/bin` and `/bin` but `gh` is linked into a temp folder, the first one found winning, as PATH order does.
 */
async function pathWithoutGh(): Promise<string> {
  const dir = join(root, 'no-gh-bin');
  await mkdir(dir);
  for (const from of ['/usr/bin', '/bin']) {
    const names = await readdir(from).catch(() => [] as string[]);
    for (const name of names) {
      if (name === 'gh') continue;
      await symlink(join(from, name), join(dir, name)).catch(() => undefined);
    }
  }
  return dir;
}
const parseEnv = (out: string): Map<string, string> =>
  new Map(
    out
      .split('\n')
      .filter(line => !line.startsWith('arg:') && line.includes('='))
      .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)] as const),
  );

describe('NHC-1 the daemon environment holds no host credential', () => {
  test('NHC-1a a hostile parent environment full of fake credentials reaches the daemon as none', async () => {
    const { home, hostile } = await previewHome();
    const result = spawn([join(home, 'bin/fy5'), 'daemon', 'start'], hostile);
    expect(result.exitCode).toBe(0);
    const text = result.stdout.toString();
    const seen = parseEnv(text);
    // By value: nothing the parent held, however it is spelled, is anywhere in what the daemon got.
    expect(text).not.toContain(FAKE);
    expect(text).not.toContain(join(root, 'real-home'));
    // By name: only the names the wrapper sets (with the preview's own values) survive of the credential-shaped ones.
    expect(credentialNames([...seen.keys()])).toEqual([]);
    const own = noCredsValues(home);
    for (const name of HOSTILE_NAMES) {
      if (name in own) expect(seen.get(name)).toBe(own[name] as string);
      else expect(seen.has(name)).toBe(false);
    }
    // The shape of the stand-ins.
    expect(seen.get('HOME')).toBe(join(home, PREVIEW.noCredsFolder, 'home'));
    expect(seen.get('GH_CONFIG_DIR')).toBe(join(home, PREVIEW.noCredsFolder, 'gh'));
    expect(seen.get('GIT_CONFIG_GLOBAL')).toBe(join(home, PREVIEW.noCredsFolder, 'gitconfig'));
    expect(seen.get('GIT_CONFIG_SYSTEM')).toBe('/dev/null');
    expect(seen.get('GIT_CONFIG_NOSYSTEM')).toBe('1');
    expect(seen.get('GIT_TERMINAL_PROMPT')).toBe('0');
    const base = join(home, PREVIEW.noCredsFolder);
    for (const folder of ['home', 'gh']) {
      expect((await stat(join(base, folder))).mode & 0o777).toBe(0o700);
      // The HOME holds the one empty shell rc file (zsh's first-run menu would swallow a terminal's keys); gh holds nothing.
      expect(await readdir(join(base, folder))).toEqual(folder === 'home' ? [HOME_SHELL_RC] : []);
    }
    expect((await stat(join(base, 'home', HOME_SHELL_RC))).size).toBe(0);
    const git = await stat(join(base, 'gitconfig'));
    expect(git.isFile()).toBe(true);
    expect(git.size).toBe(0);
    expect(git.mode & 0o777).toBe(0o600);
  });

  test('NHC-1b every other verb gets the same stand-ins, not the host home', async () => {
    const { home, hostile } = await previewHome();
    const seen = parseEnv(spawn([join(home, 'bin/fy5'), 'pair'], hostile).stdout.toString());
    expect(seen.get('HOME')).toBe(join(home, PREVIEW.noCredsFolder, 'home'));
    expect(credentialNames([...seen.keys()])).toEqual([]);
  });

  test('NHC-1c a daemon start makes the stand-ins fresh, a probe leaves them alone', async () => {
    const { home, hostile } = await previewHome();
    spawn([join(home, 'bin/fy5'), 'daemon', 'start'], hostile);
    const left = join(home, PREVIEW.noCredsFolder, 'gh', 'hosts.yml');
    await writeFile(left, 'fake: not-a-login\n');
    spawn([join(home, 'bin/fy5'), '__daemon-probe', 'true'], hostile);
    expect(await readdir(join(home, PREVIEW.noCredsFolder, 'gh'))).toEqual(['hosts.yml']);
    spawn([join(home, 'bin/fy5'), 'daemon', 'start'], hostile);
    expect(await readdir(join(home, PREVIEW.noCredsFolder, 'gh'))).toEqual([]);
  });

  test('NHC-1d the name patterns catch the credential shapes and leave ordinary names', () => {
    expect(credentialNames(['PATH', 'FY_HOME', 'LANG', 'TERM', 'XDG_RUNTIME_DIR', 'HOME', 'GH_CONFIG_DIR'])).toEqual(
      [],
    );
    expect(credentialNames(['FOO_TOKEN', 'AWS_REGION', 'SSH_AUTH_SOCK', 'GIT_ASKPASS', 'X_PASS'])).toEqual([
      'FOO_TOKEN',
      'AWS_REGION',
      'SSH_AUTH_SOCK',
      'GIT_ASKPASS',
      'X_PASS',
    ]);
  });
});

describe('NHC-2 stop removes the stand-ins', () => {
  test('NHC-2a a stopped daemon, and a daemon that was not running, both remove the stand-ins and never the folder or the shim', async () => {
    const removed: string[] = [];
    let held = [4];
    const ports = {
      holders: async () => held,
      kill: () => {
        held = [];
      },
      sleep: async () => {},
      remove: async (path: string) => void removed.push(path),
    };
    expect((await stopPreview('/h/p', ports)).stopped).toBe(true);
    expect((await stopPreview('/h/p', ports)).stopped).toBe(true);
    const standIns = ['/h/p/no-host-creds/home', '/h/p/no-host-creds/gh', '/h/p/no-host-creds/gitconfig'];
    expect(removed).toEqual([...standIns, ...standIns]);
    // A holder that stays is not "stopped": nothing is removed from under it.
    removed.length = 0;
    const stuck = await stopPreview('/h/p', { ...ports, holders: async () => [9], attempts: 1 });
    expect(stuck.stopped).toBe(false);
    expect(removed).toEqual([]);
  });
});

/** The check's own ports over the real wrapper and the real file system (a fake `gh` on a temp PATH). */
const realWorld = (home: string, inspectOverride?: (path: string) => Promise<Inspected | undefined>) => ({
  run: (async (argv, env) => {
    const done = spawn([...argv], { ...env });
    return { code: done.exitCode ?? undefined, stdout: done.stdout.toString() };
  }) satisfies Run,
  childEnvironment: kernelChild,
  inspect:
    inspectOverride ??
    (async (path: string): Promise<Inspected | undefined> => {
      const seen = await stat(path).catch(() => undefined);
      if (seen === undefined) return undefined;
      return {
        kind: seen.isDirectory() ? 'dir' : seen.isFile() ? 'file' : 'other',
        mode: seen.mode & 0o777,
        size: seen.size,
        entries: seen.isDirectory() ? (await readdir(path)).length : 0,
      };
    }),
  target: home,
});

/** A `gh` that answers "signed in" only when its config folder holds a login, like the real one. */
const GH_STUB = [
  '#!/bin/sh',
  'if [ -n "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ] || [ -s "${GH_CONFIG_DIR:-$HOME/.config/gh}/hosts.yml" ] || [ -s "$HOME/.config/gh/hosts.yml" ]; then echo "Logged in"; exit 0; fi',
  'echo "You are not logged into any GitHub hosts." >&2',
  'exit 1',
  '',
].join('\n');

describe('NHC-3 the start check proves the daemon reaches no credential, and refuses when it does', () => {
  test('NHC-3a with a fake gh that WOULD answer for the host login, the daemon environment is not signed in', async () => {
    const { home, stubs, hostile } = await previewHome();
    // The host's login exists under the (fake) real home and in the parent environment.
    await mkdir(join(root, 'real-home/.config/gh'), { recursive: true });
    await writeFile(join(root, 'real-home/.config/gh/hosts.yml'), 'fake: not-a-login\n');
    await writeFile(join(stubs, 'gh'), GH_STUB, { mode: 0o755 });
    // The host's own environment would be signed in (control).
    expect(spawn([join(stubs, 'gh'), 'auth', 'status'], hostile).exitCode).toBe(0);
    spawn([join(home, 'bin/fy5'), 'daemon', 'start'], hostile);
    const done = await credentialCheck({ ...realWorld(home), callerEnv: hostile });
    expect(done.problems).toEqual([]);
    expect(done.ok).toBe(true);
    expect(done.passed.join('\n')).toContain('says it is not signed in');
  });

  test('NHC-3b with no gh on the PATH the check passes and says so', async () => {
    const { home, hostile } = await previewHome();
    const noGh = await pathWithoutGh();
    expect(await lstat(join(noGh, 'gh')).catch(() => null)).toBeNull();
    spawn([join(home, 'bin/fy5'), 'daemon', 'start'], { ...hostile, PATH: noGh });
    const done = await credentialCheck({ ...realWorld(home), callerEnv: { ...hostile, PATH: noGh } });
    expect(done.ok).toBe(true);
    expect(done.passed.join('\n')).toContain('no `gh` on the preview daemon PATH');
  });

  test("NHC-3g a gh stub installed as <home>/bin/gh is the preview's own and is accepted without being asked", async () => {
    const { home, hostile } = await previewHome();
    // Says "signed in" to everything, like the watcher's gh stub: it must not be asked.
    await writeFile(join(home, 'bin/gh'), '#!/bin/sh\necho "Logged in"\nexit 0\n', { mode: 0o755 });
    spawn([join(home, 'bin/fy5'), 'daemon', 'start'], hostile);
    const done = await credentialCheck({ ...realWorld(home), callerEnv: hostile });
    expect(done.problems).toEqual([]);
    expect(done.passed.join('\n')).toContain("is the preview's own");
  });

  test('NHC-3c a daemon environment that still reaches a credential refuses, by NAME only', async () => {
    const { home, stubs, hostile } = await previewHome();
    spawn([join(home, 'bin/fy5'), 'daemon', 'start'], hostile);
    // A wrapper that lets a token and the host HOME through (the bug this unit closes).
    await writeFile(
      join(home, 'bin/fy5'),
      wrapperText(home, '/nonexistent-v4/.ferretry').replace(
        'exec env -i ',
        `exec env -i GH_TOKEN="${FAKE}" SSH_AUTH_SOCK="/fake/sock" `,
      ),
      { mode: 0o755 },
    );
    await writeFile(join(stubs, 'gh'), GH_STUB, { mode: 0o755 });
    const done = await credentialCheck({ ...realWorld(home), callerEnv: hostile });
    expect(done.ok).toBe(false);
    const said = done.problems.join('\n');
    expect(said).toContain('GH_TOKEN');
    expect(said).toContain('SSH_AUTH_SOCK');
    expect(said).toContain('IS signed in');
    expect(said).not.toContain(FAKE);
  });

  test('NHC-3d an environment that lacks the preview stand-ins refuses', async () => {
    const { home, hostile } = await previewHome();
    spawn([join(home, 'bin/fy5'), 'daemon', 'start'], hostile);
    await writeFile(
      join(home, 'bin/fy5'),
      wrapperText(home, '/nonexistent-v4/.ferretry').replace(`GIT_CONFIG_NOSYSTEM="1" `, ''),
      { mode: 0o755 },
    );
    const done = await credentialCheck({ ...realWorld(home), callerEnv: hostile });
    expect(done.ok).toBe(false);
    expect(done.problems.join('\n')).toContain('GIT_CONFIG_NOSYSTEM');
  });

  test('NHC-3e the stand-in folders must be empty and private, each miss is named', async () => {
    const { home, hostile } = await previewHome();
    spawn([join(home, 'bin/fy5'), 'daemon', 'start'], hostile);
    const base = join(home, PREVIEW.noCredsFolder);
    const real = realWorld(home).inspect;
    const cases: Record<string, (path: string) => Promise<Inspected | undefined>> = {
      'home/ is not an empty 0700 folder': async path => (path === join(base, 'home') ? undefined : real(path)),
      'home/ is not an empty 0700 folder (a second entry beside the shell rc)': async path =>
        path === join(base, 'home') ? { kind: 'dir', mode: 0o700, size: 0, entries: 2 } : real(path),
      'home/ is not an empty 0700 folder (no shell rc)': async path =>
        path === join(base, 'home') ? { kind: 'dir', mode: 0o700, size: 0, entries: 0 } : real(path),
      'home/ is not an empty 0700 folder (rc missing)': async path =>
        path === join(base, 'home', HOME_SHELL_RC) ? undefined : real(path),
      'home/ is not an empty 0700 folder (rc has content)': async path =>
        path === join(base, 'home', HOME_SHELL_RC) ? { kind: 'file', mode: 0o600, size: 9, entries: 0 } : real(path),
      'home/ is not an empty 0700 folder (rc mode)': async path =>
        path === join(base, 'home', HOME_SHELL_RC) ? { kind: 'file', mode: 0o644, size: 0, entries: 0 } : real(path),
      'home/ is not an empty 0700 folder (rc is a folder)': async path =>
        path === join(base, 'home', HOME_SHELL_RC) ? { kind: 'dir', mode: 0o600, size: 0, entries: 0 } : real(path),
      'gh/ is not an empty 0700 folder': async path =>
        path === join(base, 'gh') ? { kind: 'dir', mode: 0o700, size: 0, entries: 1 } : real(path),
      'gh/ is not an empty 0700 folder (mode)': async path =>
        path === join(base, 'gh') ? { kind: 'dir', mode: 0o755, size: 0, entries: 0 } : real(path),
      'home/ is not an empty 0700 folder (a file)': async path =>
        path === join(base, 'home') ? { kind: 'file', mode: 0o700, size: 0, entries: 0 } : real(path),
      'gitconfig is not an empty 0600 file': async path =>
        path === join(base, 'gitconfig') ? { kind: 'file', mode: 0o600, size: 5, entries: 0 } : real(path),
      'gitconfig is not an empty 0600 file (missing)': async path =>
        path === join(base, 'gitconfig') ? undefined : real(path),
      'gitconfig is not an empty 0600 file (mode)': async path =>
        path === join(base, 'gitconfig') ? { kind: 'file', mode: 0o644, size: 0, entries: 0 } : real(path),
      'gitconfig is not an empty 0600 file (a folder)': async path =>
        path === join(base, 'gitconfig') ? { kind: 'dir', mode: 0o600, size: 0, entries: 0 } : real(path),
    };
    for (const [sentence, inspect] of Object.entries(cases)) {
      const done = await credentialCheck({ ...realWorld(home, inspect), callerEnv: hostile });
      expect(done.ok).toBe(false);
      expect(done.problems.join('\n')).toContain(sentence.replace(/ \(.*\)$/u, ''));
    }
  });

  test('NHC-3f a daemon environment that cannot be read refuses', async () => {
    const { home, hostile } = await previewHome();
    const done = await credentialCheck({
      ...realWorld(home),
      run: async () => ({ code: undefined, stdout: '' }),
      callerEnv: hostile,
    });
    expect(done.ok).toBe(false);
    expect(done.problems.join('\n')).toContain('could not read the daemon');
  });
});

/** The wrapper with a leaky allow-list: GH_TOKEN passes from the caller to the daemon (the bug the start check must see). */
const leakyWrapper = (home: string): string =>
  wrapperText(home, '/nonexistent-v4/.ferretry').replace('for name in USER ', 'for name in GH_TOKEN USER ');

describe('NHC-4 the check sees the environment the daemon really has (B1)', () => {
  test('NHC-4a a leaky allow-list and a hostile caller environment: the check refuses, names GH_TOKEN, never the value', async () => {
    const { home, stubs, hostile } = await previewHome();
    await writeFile(join(home, 'bin/fy5'), leakyWrapper(home), { mode: 0o755 });
    await writeFile(join(stubs, 'gh'), GH_STUB, { mode: 0o755 });
    spawn([join(home, 'bin/fy5'), 'daemon', 'start'], hostile);
    const done = await credentialCheck({ ...realWorld(home), callerEnv: hostile });
    expect(done.ok).toBe(false);
    const said = done.problems.join('\n');
    expect(said).toContain('GH_TOKEN');
    expect(said).toContain('IS signed in');
    expect(said).not.toContain(FAKE);
    // The whole answer (passed AND problems), not only the problems: no value of the environment is anywhere in it.
    expect(JSON.stringify(done)).not.toContain(FAKE);
  });

  test('NHC-4b the running daemon environment, when readable, is what is judged; the probe is not asked for it', async () => {
    const { home, hostile } = await previewHome();
    spawn([join(home, 'bin/fy5'), 'daemon', 'start'], hostile);
    const asked: string[] = [];
    const real = realWorld(home);
    const own = Object.entries(noCredsValues(home)).map(([name, value]) => `${name}=${value}`);
    const done = await credentialCheck({
      ...real,
      run: async (argv, env) => {
        asked.push(argv.join(' '));
        return real.run(argv, env);
      },
      callerEnv: hostile,
      daemonEnviron: async () => [...own, `GH_TOKEN=${FAKE}`, 'PATH=/usr/bin'].join('\0'),
    });
    expect(done.ok).toBe(false);
    expect(done.problems.join('\n')).toContain('GH_TOKEN');
    expect(done.problems.join('\n')).not.toContain(FAKE);
    expect(JSON.stringify(done)).not.toContain(FAKE);
    expect(asked.some(line => line.endsWith('env -0'))).toBe(false);
  });

  test('NHC-4c the daemon environment is read from the pid that holds the lock, and from none when nothing does', async () => {
    const holders = async (lock: string) => (lock === '/l/held' ? [7, 8] : []);
    const environOf = async (pid: number) => `PID=${String(pid)}`;
    expect(await readDaemonEnviron('/l/held', { holders, environOf })).toBe('PID=7');
    expect(await readDaemonEnviron('/l/free', { holders, environOf })).toBeUndefined();
  });
});

/** Starts the daemon through the wrapper and returns the PATH its children are given (read through the wrapper's probe). */
function startAndPath(home: string, hostile: Record<string, string>): string {
  spawn([join(home, 'bin/fy5'), 'daemon', 'start'], hostile);
  return spawn([join(home, 'bin/fy5'), '__daemon-probe', 'printenv', 'PATH'], hostile)
    .stdout.toString()
    .trim();
}

describe('NHC-5 ssh through a child of the daemon reads no user config and no keys (B2)', () => {
  test('NHC-5a a real git over ssh, in the environment the kernel gives a git child, runs ssh through the shim', async () => {
    const { home, hostile } = await previewHome();
    const log = join(root, 'ssh.log');
    const path = startAndPath(home, hostile);
    const env = kernelChild('git', { PATH: path, HOME: join(home, PREVIEW.noCredsFolder, 'home') });
    // The kernel's own rule: nothing but PATH and HOME reaches the child (no GIT_SSH_COMMAND can).
    expect(Object.keys(env).sort()).toEqual(['HOME', 'PATH']);
    Bun.spawnSync(['git', 'ls-remote', 'ssh://example.invalid/repo'], { env });
    const seen = await readFile(log, 'utf8');
    expect(seen).toContain('-F /dev/null');
    expect(seen).toContain('-o IdentityFile=none');
    expect(seen).toContain('-o IdentitiesOnly=yes');
    expect(seen).toContain('-o IdentityAgent=none');
    expect(seen).toContain('-o BatchMode=yes');
    expect(seen).toContain(`-o UserKnownHostsFile=${join(home, PREVIEW.noCredsFolder, 'known_hosts')}`);
    expect(seen).toContain('example.invalid');
  });

  test('NHC-5b the shim is a fresh 0700 file in a fresh 0700 folder, runs the real ssh by absolute path, and skips its own', async () => {
    const { home, stubs, hostile } = await previewHome();
    // A (fake) ssh in the preview's own bin is skipped when the real one is looked for.
    await writeFile(join(home, 'bin/ssh'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
    startAndPath(home, { ...hostile, PATH: `${join(home, 'bin')}:${hostile.PATH}` });
    const folder = join(home, PREVIEW.noCredsFolder, 'bin');
    expect((await stat(folder)).mode & 0o777).toBe(0o700);
    const shim = join(folder, 'ssh');
    expect((await stat(shim)).mode & 0o777).toBe(0o700);
    expect(await readFile(shim, 'utf8')).toContain(`exec "${join(stubs, 'ssh')}" -F /dev/null`);
    // Replaced (not deleted) by every daemon start: a crashed start's temp file is cleared, nothing else is touched.
    await writeFile(join(folder, 'left-behind'), 'x');
    await writeFile(join(folder, '.ssh.new.999'), 'x');
    spawn([join(home, 'bin/fy5'), 'daemon', 'start'], hostile);
    expect((await readdir(folder)).sort()).toEqual(['left-behind', 'ssh']);
  });

  test('NHC-5g a folder that is not ours-0700, or a symlink, is refused rather than deleted or followed', async () => {
    const { home, hostile } = await previewHome();
    const base = join(home, PREVIEW.noCredsFolder);
    await mkdir(base, { mode: 0o755 });
    await chmod(base, 0o755);
    const open = spawn([join(home, 'bin/fy5'), 'daemon', 'start'], hostile);
    expect(open.exitCode).toBe(1);
    expect(open.stderr.toString()).toContain('not a private (0700) folder');
    expect(await stat(base)).toBeDefined();
    await rm(base, { recursive: true });
    await mkdir(join(root, 'elsewhere'), { mode: 0o700 });
    await symlink(join(root, 'elsewhere'), base);
    expect(spawn([join(home, 'bin/fy5'), 'daemon', 'start'], hostile).exitCode).toBe(1);
    expect((await lstat(base)).isSymbolicLink()).toBe(true);
    await rm(base);
    await mkdir(base, { mode: 0o700 });
    await mkdir(join(base, 'bin'), { mode: 0o755 });
    await chmod(join(base, 'bin'), 0o755);
    expect(spawn([join(home, 'bin/fy5'), 'daemon', 'start'], hostile).exitCode).toBe(1);
  });

  test('NHC-5h NEW-2 a live pane resolves ssh to the shim before stop, after stop and all through a restart', async () => {
    const { home, hostile } = await previewHome();
    const path = startAndPath(home, hostile);
    const shim = join(home, PREVIEW.noCredsFolder, 'bin', 'ssh');
    // The pane: a child whose environment is the kernel's rule for a tmux server (PATH and HOME only).
    const pane = kernelChild('tmux', { PATH: path, HOME: join(home, PREVIEW.noCredsFolder, 'home') });
    const resolves = () => Bun.spawnSync(['/bin/sh', '-c', 'command -v ssh'], { env: pane }).stdout.toString().trim();
    expect(resolves()).toBe(shim);
    // Stop (the real function, the real removal): the daemon is not running, so the stand-ins go. The shim stays.
    const done = await stopPreview(home, {
      holders: async () => [],
      kill: () => {},
      sleep: async () => {},
      remove: path => rm(path, { recursive: true, force: true }),
    });
    expect(done.stopped).toBe(true);
    expect(await stat(join(home, PREVIEW.noCredsFolder, 'home')).catch(() => undefined)).toBeUndefined();
    expect(resolves()).toBe(shim);
    // A restart replaces the shim by rename: at no instant is it missing, and no half-written file is ever its name.
    for (let round = 0; round < 3; round++) {
      const child = Bun.spawn([join(home, 'bin/fy5'), 'daemon', 'start'], { env: hostile, stdout: 'ignore' });
      let seen = 0;
      let exited = false;
      void child.exited.then(() => (exited = true));
      while (!exited) {
        const text = await readFile(shim, 'utf8');
        expect(text).toContain('exec "');
        expect(text.endsWith('"$@"\n')).toBe(true);
        seen++;
      }
      await child.exited;
      expect(seen).toBeGreaterThan(0);
      expect(resolves()).toBe(shim);
    }
  });

  test('NHC-5c the check says an ssh through a child environment shows no identity and no user config', async () => {
    const { home, hostile } = await previewHome();
    spawn([join(home, 'bin/fy5'), 'daemon', 'start'], hostile);
    const done = await credentialCheck({ ...realWorld(home), callerEnv: hostile });
    expect(done.problems).toEqual([]);
    expect(done.passed.join('\n')).toContain('reads no user config and offers no key');
    expect(done.passed.join('\n')).toContain('a pane or launch that sets its own PATH');
    expect(done.passed.join('\n')).toContain('/usr/bin/ssh by absolute path');
  });

  test('NHC-5d without the shim the check refuses, naming ssh and the shim', async () => {
    const { home, hostile } = await previewHome();
    spawn([join(home, 'bin/fy5'), 'daemon', 'start'], hostile);
    await rm(join(home, PREVIEW.noCredsFolder, 'bin/ssh'));
    const done = await credentialCheck({ ...realWorld(home), callerEnv: hostile });
    expect(done.ok).toBe(false);
    const said = done.problems.join('\n');
    expect(said).toContain('ssh -G fy-preview-ssh-check.invalid');
    expect(said).toContain('shim');
  });

  test('NHC-5e a real ssh path with a quote is not written into the shim, so the check refuses', async () => {
    const { home, hostile } = await previewHome();
    const odd = join(root, "odd'stubs");
    await mkdir(odd);
    await writeFile(join(odd, 'ssh'), fakeSsh(join(root, 'ssh.log')), { mode: 0o755 });
    const env = { ...hostile, PATH: `${odd}:/usr/bin:/bin` };
    spawn([join(home, 'bin/fy5'), 'daemon', 'start'], env);
    expect(await stat(join(home, PREVIEW.noCredsFolder, 'bin')).catch(() => undefined)).toBeUndefined();
    const done = await credentialCheck({ ...realWorld(home), callerEnv: env });
    expect(done.ok).toBe(false);
  });

  test('NHC-5f no ssh that starts, or one that fails, is told apart', async () => {
    const { home, hostile } = await previewHome();
    spawn([join(home, 'bin/fy5'), 'daemon', 'start'], hostile);
    const real = realWorld(home);
    const only =
      (answer: { code: number | undefined; stdout: string }): Run =>
      async (argv, env) =>
        argv[0] === 'ssh' ? answer : real.run(argv, env);
    const none = await credentialCheck({ ...real, run: only({ code: undefined, stdout: '' }), callerEnv: hostile });
    expect(none.passed.join('\n')).toContain('no `ssh` on the preview daemon PATH');
    const failed = await credentialCheck({ ...real, run: only({ code: 255, stdout: '' }), callerEnv: hostile });
    expect(failed.ok).toBe(false);
    expect(failed.problems.join('\n')).toContain('(exit 255)');
  });
});

describe('NHC-6 a miss in the credential check stops the daemon, and says so (B3)', () => {
  const script = join(import.meta.dir, '../../preview/preview.sh');

  /** A fake `bun` that records its arguments and fails `credential-check` only. */
  const start = async (stopCode: number) => {
    const bin = join(root, 'fakebin');
    const target = join(root, 'v5');
    const log = join(root, 'bun.log');
    await mkdir(bin, { recursive: true });
    await mkdir(join(target, 'bin'), { recursive: true });
    await writeFile(
      join(bin, 'bun'),
      [
        '#!/bin/sh',
        'echo "$@" >> "$FAKE_LOG"',
        'case "$2" in',
        '  guard) printf "%s\\n%s\\n" "$FAKE_V4" "$FAKE_TARGET" ;;',
        '  credential-check) exit 1 ;;',
        '  stop) exit "$FAKE_STOP_CODE" ;;',
        '  *) exit 0 ;;',
        'esac',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    await writeFile(join(target, 'bin', 'fy5'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const result = Bun.spawnSync([script, 'start', '--v4', join(root, 'v4'), '--target', target], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: root,
        FAKE_LOG: log,
        FAKE_V4: join(root, 'v4'),
        FAKE_TARGET: target,
        FAKE_STOP_CODE: String(stopCode),
      },
    });
    const calls = (await readFile(log, 'utf8'))
      .split('\n')
      .filter(line => line !== '')
      .map(line => line.split(' ')[1]);
    return { result, calls };
  };

  test('NHC-6a the daemon is stopped, the sentence says it was, and the exit is 1', async () => {
    const { result, calls } = await start(0);
    expect(calls.at(-2)).toBe('credential-check');
    expect(calls.at(-1)).toBe('stop');
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain(
      'the preview daemon was stopped because it could reach a host credential',
    );
  });

  test('NHC-6b when stop itself fails the sentence says the daemon could not be stopped and names the command', async () => {
    const { result, calls } = await start(1);
    expect(calls.at(-1)).toBe('stop');
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain('could reach a host credential AND could not be stopped');
    expect(result.stderr.toString()).toContain("preview.sh stop' now");
  });
});
