import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { probeEnforcement } from '../../../../packages/plugins/terminals/daemon/lib/cgroups/enforcement.ts';
import { cleanPreview, prepare, proofNow, shimText, wrapperText } from '../../preview/driver.ts';
import { gatedFields } from '../../preview/gate.ts';
import { needlesFor } from '../../src/v4/homes.ts';
import { PREVIEW } from '../../preview/plan.ts';
import { claimPaths, PROOF_FOLDER, proofPathFor, snapshot } from '../../preview/proof.ts';
import { startChecks, type Run } from '../../preview/start-checks.ts';
import { previewFolder, PREVIEW_WORKSPACE } from '../../src/v5/harness-paths.ts';
import { PREVIEW_SETTINGS_ITEM, previewShellEnv, SHELL_GUARD_ENV } from '../../src/v5/preview-env.ts';
import { fixture } from './ferret-fixture.ts';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fy-fix3-'));
});
afterEach(() => rm(root, { recursive: true, force: true }));

const V4 = '/nonexistent-v4/.ferretry';

/** A preview home with the wrapper, the shims and a stub `fy` that prints its environment, plus a stub `systemctl`. */
async function previewHome(): Promise<{ home: string; stubs: string; env: Record<string, string> }> {
  const home = join(root, 'v5');
  const stubs = join(root, 'stubs');
  await mkdir(join(home, 'bin'), { recursive: true });
  await mkdir(join(home, 'libexec'), { recursive: true });
  await mkdir(stubs);
  await writeFile(join(home, 'libexec/fy'), '#!/bin/sh\nprintf "arg:%s\\n" "$@"\nenv\n', { mode: 0o755 });
  await writeFile(join(home, 'bin/fy5'), wrapperText(home, V4), { mode: 0o755 });
  await writeFile(join(home, 'bin/fy'), shimText(home, 'fy'), { mode: 0o755 });
  // A fake manager: answers only to a caller that holds a bus address or the "real" runtime folder, like systemd.
  await writeFile(
    join(stubs, 'systemctl'),
    [
      '#!/bin/sh',
      'if [ -n "${DBUS_SESSION_BUS_ADDRESS:-}" ] || [ "${XDG_RUNTIME_DIR:-}" = "/run/user/real" ]; then echo "HOME=/x"; exit 0; fi',
      'echo "Failed to connect to bus: No medium found" >&2',
      'exit 1',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  const env = {
    PATH: `${stubs}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    HOME: '/home/u',
    XDG_RUNTIME_DIR: '/run/user/real',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/real/bus',
  };
  return { home, stubs, env };
}

const spawn = (argv: string[], env: Record<string, string>) => Bun.spawnSync(argv, { env });
const envNames = (out: string): Map<string, string> =>
  new Map(
    out
      .split('\n')
      .filter(line => !line.startsWith('arg:') && line.includes('='))
      .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)] as const),
  );

describe('MAJOR-A the daemon is started where no user systemd manager answers', () => {
  test('daemon start gets a private 0700 XDG_RUNTIME_DIR and no session bus', async () => {
    const { home, env } = await previewHome();
    const result = spawn([join(home, 'bin/fy5'), 'daemon', 'start'], env);
    expect(result.exitCode).toBe(0);
    const seen = envNames(result.stdout.toString());
    expect(seen.get('XDG_RUNTIME_DIR')).toBe(join(home, PREVIEW.xdgRunFolder));
    expect(seen.has('DBUS_SESSION_BUS_ADDRESS')).toBe(false);
    expect((await stat(join(home, PREVIEW.xdgRunFolder))).mode & 0o777).toBe(0o700);
  });

  test('other verbs (pair, status) keep the caller runtime folder and session bus', async () => {
    const { home, env } = await previewHome();
    for (const verb of ['pair', 'status']) {
      const seen = envNames(spawn([join(home, 'bin/fy5'), verb], env).stdout.toString());
      expect(seen.get('XDG_RUNTIME_DIR')).toBe('/run/user/real');
      expect(seen.get('DBUS_SESSION_BUS_ADDRESS')).toBe('unix:path=/run/user/real/bus');
    }
  });

  test('the product detection says direct for the daemon env, and cgroups for the control env', async () => {
    const { home, env } = await previewHome();
    const host = {
      platform: 'linux',
      unifiedHierarchy: true,
      cpus: 4,
      physicalBytes: 1,
      memoryCeilingBytes: 1,
      ceilingSource: 'test',
      swapBytes: 0,
    };
    // The port runs a command the way each environment would: through the real wrapper, or the bare caller env.
    const through = (prefix: string[], childEnv: Record<string, string>) => ({
      execute: async (argv: readonly string[]) => {
        const result = spawn([...prefix, ...argv], childEnv);
        return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
      },
    });
    const daemon = await probeEnforcement(host, through([join(home, 'bin/fy5'), '__daemon-probe'], env));
    expect(daemon.kind).toBe('direct');
    // What 5.0's kernel gives a child: PATH and HOME only (no runtime folder, no bus).
    const kernel = await probeEnforcement(host, through([], { PATH: env.PATH ?? '', HOME: env.HOME ?? '' }));
    expect(kernel.kind).toBe('direct');
    // The control: with the caller's own runtime folder and bus the same stub is reachable, so the probe says cgroups.
    const control = await probeEnforcement(host, through([], env));
    expect(control.kind).toBe('cgroups');
  });
});

describe('MAJOR-A the start self-check refuses a reachable manager', () => {
  const callerEnv = {
    HOME: '/home/u',
    PATH: '/usr/bin',
    XDG_RUNTIME_DIR: '/run/user/real',
    DBUS_SESSION_BUS_ADDRESS: 'x',
  };

  test('passes when the stub manager does not answer in the daemon environment', async () => {
    const { home, env } = await previewHome();
    const real: Run = async (argv, e) => {
      const result = spawn([...argv], { ...e });
      return { code: result.exitCode, stdout: result.stdout.toString() };
    };
    const asShell: Run = async (argv, e) =>
      argv[0] === 'bash' || argv[0] === 'zsh' ? { code: undefined, stdout: '' } : real(argv, e);
    const done = await startChecks({ target: home, v4Home: V4, callerEnv: env, run: asShell });
    expect(done.problems.filter(p => p.includes('systemd manager'))).toEqual([]);
    expect(done.passed.some(line => line.includes('no user systemd manager'))).toBe(true);
  });

  test('refuses when the manager answers (exit 0)', async () => {
    const { home } = await previewHome();
    const run: Run = async argv =>
      argv.includes('show-environment')
        ? { code: 0, stdout: 'HOME=/x' }
        : argv.includes('-c')
          ? { code: 0, stdout: `${join(home, PREVIEW.xdgRunFolder)}|unset` }
          : { code: undefined, stdout: '' };
    const done = await startChecks({ target: home, v4Home: V4, callerEnv, run });
    expect(done.ok).toBe(false);
    expect(done.problems.join('\n')).toContain('still reaches your user systemd manager');
  });

  test('refuses when the wrapper does not give the daemon the private runtime folder', async () => {
    const { home } = await previewHome();
    const run: Run = async argv =>
      argv.includes('-c') ? { code: 0, stdout: '/run/user/real|unix:path=/bus' } : { code: undefined, stdout: '' };
    const done = await startChecks({ target: home, v4Home: V4, callerEnv, run });
    expect(done.ok).toBe(false);
    expect(done.problems.join('\n')).toContain('did not give the daemon the private runtime folder');
  });
});

describe('MAJOR-B login shells find the preview fy', () => {
  const callerEnv = { HOME: '/home/u', PATH: '/usr/bin' };

  test('the guard env carries the nix guard, FY_HOME, FY_PORT, FY_URL, ZDOTDIR and HISTFILE', () => {
    expect(SHELL_GUARD_ENV.__ETC_PROFILE_NIX_SOURCED).toBe('1');
    expect(previewShellEnv('/h/v5', 7458)).toEqual({
      __ETC_PROFILE_NIX_SOURCED: '1',
      FY_HOME: '/h/v5',
      FY_PORT: '7458',
      FY_URL: 'http://127.0.0.1:7458',
      ZDOTDIR: '/h/v5/no-host-creds/zdot',
      HISTFILE: '/h/v5/no-host-creds/zdot/.bash_history',
    });
  });

  test('passes when both shells answer the shim, refuses when either answers another fy', async () => {
    const { home } = await previewHome();
    const shim = join(home, 'bin', 'fy');
    const answering =
      (bash: string, zsh: string): Run =>
      async argv => {
        if (argv[0] === 'bash') return { code: 0, stdout: `${bash}\n` };
        if (argv[0] === 'zsh') return { code: 0, stdout: `${zsh}\n` };
        if (argv.includes('show-environment')) return { code: 1, stdout: '' };
        return { code: 0, stdout: `${join(home, PREVIEW.xdgRunFolder)}|unset` };
      };
    const good = await startChecks({ target: home, v4Home: V4, callerEnv, run: answering(shim, shim) });
    expect(good.ok).toBe(true);
    const badBash = await startChecks({
      target: home,
      v4Home: V4,
      callerEnv,
      run: answering('/nix/profile/bin/fy', shim),
    });
    expect(badBash.ok).toBe(false);
    expect(badBash.problems.join('\n')).toContain('bash -lc');
    const badZsh = await startChecks({
      target: home,
      v4Home: V4,
      callerEnv,
      run: answering(shim, '/nix/profile/bin/fy'),
    });
    expect(badZsh.ok).toBe(false);
    expect(badZsh.problems.join('\n')).toContain('zsh -lic');
  });

  test('the shell probes run in the guard environment, with the preview bin first', async () => {
    const { home } = await previewHome();
    const seen: Array<Record<string, string>> = [];
    const run: Run = async (argv, e) => {
      if (argv[0] === 'bash' || argv[0] === 'zsh') seen.push({ ...e });
      return argv.includes('show-environment')
        ? { code: 1, stdout: '' }
        : { code: 0, stdout: `${join(home, PREVIEW.xdgRunFolder)}|unset` };
    };
    await startChecks({ target: home, v4Home: V4, callerEnv, run });
    expect(seen.length).toBe(3);
    for (const e of seen) {
      expect(e.__ETC_PROFILE_NIX_SOURCED).toBe('1');
      expect(e.PATH?.startsWith(`${join(home, 'bin')}:`)).toBe(true);
      expect(e.FY_HOME).toBe(home);
    }
  });

  test('the converter writes the guard env into a preview harness settings item', async () => {
    const f = await fixture();
    try {
      await mkdir(join(f.from, 'config'), { recursive: true });
      await writeFile(join(f.from, 'layout-version'), '2\n');
      await writeFile(join(f.from, 'config/machine.yaml'), 'timeZone: UTC\n');
      const done = await prepare({
        v4Home: f.from,
        target: f.to,
        lock: { held: async () => false },
        now: () => new Date('2026-11-09T00:00:00Z'),
        home: join(f.root, 'home'),
      });
      expect(done.report?.complete).toBe(true);
      const item = parseYaml(
        await readFile(join(f.to, `config/claude-code/settings/${PREVIEW_SETTINGS_ITEM}.yaml`), 'utf8'),
      );
      const real = await realpath(f.to);
      expect(item.settings.env).toEqual(previewShellEnv(real, PREVIEW.port));
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});

describe('Minor-1 the gate reads every string and path key in config folders', () => {
  const needles = needlesFor('/home/u/.ferretry', '/home/u');
  const hits = (doc: unknown): string[] => gatedFields(doc, needles, { strict: true });

  test.each([
    ['notify', { notify: ['/home/u/.ferretry/bin/notify.sh'] }, 'notify[0]'],
    ['apiKeyHelper', { apiKeyHelper: '/home/u/.claude/helper.sh' }, 'apiKeyHelper'],
    ['writable_roots', { sandbox: { writable_roots: ['/home/u/.ferretry/state'] } }, 'sandbox.writable_roots[0]'],
    [
      'additionalDirectories',
      { permissions: { additionalDirectories: ['/home/u/.codex'] } },
      'permissions.additionalDirectories[0]',
    ],
    ['an unlisted key', { whatever: { deep: '/home/u/.ferretry/x' } }, 'whatever.deep'],
  ])('%s is gated by file field', (_name, doc, expected) => {
    expect(hits(doc)).toEqual([expected]);
  });

  test('a codex projects."/abs" key is gated by its place, never by its text', () => {
    const found = hits({ projects: { '/home/u/.ferretry/work': { trust_level: 'trusted' } } });
    expect(found).toEqual(['projects.<path key>']);
    expect(found.join('')).not.toContain('work');
  });

  test('free-text keys that mention a path are not gated', () => {
    expect(
      hits({
        description: 'see /home/u/.ferretry/docs',
        label: '/home/u/.ferretry',
        title: '/home/u/.claude',
        name: '/home/u/.ferretry/x',
        notes: '/home/u/.ferretry/y',
      }),
    ).toEqual([]);
  });

  test('a value that is not a v4 or harness path is fine', () => {
    expect(hits({ notify: ['/usr/bin/true'], projects: { '/srv/app': {} } })).toEqual([]);
  });
});

describe('Minor-2 which ferret folders the preview swaps', () => {
  const ctx = (preview = true) =>
    ({
      preview,
      previewV4Home: '/home/u/.ferretry',
      v5: { resolve: (p: string) => join('/home/u/.ferretry-v5', p) },
    }) as never;
  const swapped = join('/home/u/.ferretry-v5', PREVIEW_WORKSPACE);

  test('v4 home, its worktree folder, a ledger worktree and a .worktrees segment are swapped', () => {
    expect(previewFolder(ctx(), '/home/u/.ferretry/fleet/x')).toBe(swapped);
    expect(previewFolder(ctx(), '/home/u/.ferretry-worktrees/job')).toBe(swapped);
    expect(previewFolder(ctx(), '/srv/repo/wt/job', ['/srv/repo/wt/job'])).toBe(swapped);
    expect(previewFolder(ctx(), '/srv/repo/wt/job/sub', ['/srv/repo/wt/job'])).toBe(swapped);
    expect(previewFolder(ctx(), '/srv/repo/.worktrees/feature')).toBe(swapped);
    expect(previewFolder(ctx(), '/srv/repo/.worktrees')).toBe(swapped);
  });

  test('a primary checkout keeps its folder, and so does everything when not previewing', () => {
    expect(previewFolder(ctx(), '/srv/repo', ['/srv/repo/wt/job'])).toBe('/srv/repo');
    expect(previewFolder(ctx(), '/srv/repo/.worktreesish/x')).toBe('/srv/repo/.worktreesish/x');
    expect(previewFolder(ctx(false), '/srv/repo/.worktrees/x')).toBe('/srv/repo/.worktrees/x');
  });
});

describe('Minor-3 the proof lives outside the preview home with content hashes', () => {
  test('prepare keeps the proof under ~/.ferretry-v5-proof (0700), clean removes it', async () => {
    const f = await fixture();
    try {
      await writeFile(join(f.from, 'layout-version'), '2\n');
      await mkdir(join(f.from, 'config'), { recursive: true });
      await writeFile(join(f.from, 'config/machine.yaml'), 'timeZone: UTC\n');
      const home = join(f.root, 'home');
      await mkdir(home);
      const done = await prepare({
        v4Home: f.from,
        target: f.to,
        lock: { held: async () => false },
        now: () => new Date('2026-11-09T00:00:00Z'),
        home,
      });
      expect(done.report?.complete).toBe(true);
      const target = await realpath(f.to);
      const path = proofPathFor(home, target);
      expect(path.startsWith(join(home, PROOF_FOLDER))).toBe(true);
      expect((await stat(join(home, PROOF_FOLDER))).mode & 0o777).toBe(0o700);
      expect((await readdir(target)).some(name => name.includes('proof'))).toBe(false);
      expect((await proofNow(f.from, f.to, home)).unchanged).toBe(true);
      expect(await cleanPreview(f.from, f.to, home)).toContain('proof');
      expect(await stat(path).catch(() => undefined)).toBeUndefined();
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });

  test('a claim file is recorded as a content hash, never as content, and a change shows', async () => {
    const f = await fixture();
    try {
      const home = join(f.root, 'home');
      const runtime = join(f.root, 'run');
      await mkdir(runtime, { recursive: true });
      await chmod(runtime, 0o700);
      const facts = { userHome: home, runtimeDir: runtime, uid: process.getuid?.() };
      const claim = claimPaths(f.from, facts)['claim:unit-target'] as string;
      await writeFile(claim, 'SECRET-LOCK-BODY-1');
      const a = JSON.stringify(await snapshot(f.from, facts));
      expect(a).not.toContain('SECRET-LOCK-BODY');
      await writeFile(claim, 'SECRET-LOCK-BODY-2');
      const b = JSON.stringify(await snapshot(f.from, facts));
      expect(b).not.toContain('SECRET-LOCK-BODY');
      expect(a).not.toBe(b);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});
