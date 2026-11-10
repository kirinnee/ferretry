/**
 * The preview daemon reaches NO host credential (!A469): the one environment builder (the `fy5` wrapper) strips every
 * credential by allow-list, gives the daemon an empty HOME, an empty `gh` folder and an empty git config, and the start
 * check proves it. Every value here is FAKE; nothing real is read, and no program but the stubs below is run.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialCheck, credentialNames, type Inspected } from '../../preview/credential-check.ts';
import { noCredsValues, shimText, wrapperText } from '../../preview/driver.ts';
import { PREVIEW } from '../../preview/plan.ts';
import type { Run } from '../../preview/start-checks.ts';
import { stopPreview } from '../../preview/stop.ts';

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
      expect(await readdir(join(base, folder))).toEqual([]);
    }
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
  test('NHC-2a a stopped daemon, and a daemon that was not running, both remove the folder', async () => {
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
    expect(removed).toEqual(['/h/p/no-host-creds', '/h/p/no-host-creds']);
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
    spawn([join(home, 'bin/fy5'), 'daemon', 'start'], { ...hostile, PATH: '/usr/bin:/bin' });
    const done = await credentialCheck({ ...realWorld(home), callerEnv: { ...hostile, PATH: '/usr/bin:/bin' } });
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
