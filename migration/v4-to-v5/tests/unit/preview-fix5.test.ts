import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { prepare, shimText } from '../../preview/driver.ts';
import { gatedFields, needlesFor } from '../../preview/gate.ts';
import { PREVIEW } from '../../preview/plan.ts';
import { copySqlite } from '../../preview/stage.ts';
import { previewPath } from '../../preview/start-checks.ts';
import {
  CODEX_HELD_SENTENCE,
  PREVIEW_CODEX_RUNTIMES,
  PREVIEW_SETTINGS_ITEM,
  previewShellEnv,
} from '../../src/v5/preview-env.ts';
import { fixture } from './ferret-fixture.ts';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fy-fix5-'));
});
afterEach(() => rm(root, { recursive: true, force: true }));

const write = async (base: string, path: string, text: string) => {
  await mkdir(join(base, path, '..'), { recursive: true });
  await writeFile(join(base, path), text);
};

/** A v4 home with one Claude runtime and one Codex runtime (each with its own login and profile), prepared. */
async function convertedHome() {
  const f = await fixture();
  await write(f.from, 'layout-version', '2\n');
  await write(f.from, 'config/machine.yaml', 'defaultRuntime: codex-work\n');
  // The preview leaves v4's logins out, so only a runtime that says its own harness can be told from a Codex one.
  await write(f.from, 'config/runtimes/claude-work.yaml', 'credential: claude-login\nprofile: main\nharness: claude\n');
  await write(f.from, 'config/runtimes/codex-work.yaml', 'credential: codex-login\nprofile: codexp\nharness: codex\n');
  await write(f.from, 'config/runtimes/silent.yaml', 'credential: some-login\nprofile: main\n');
  await write(f.from, 'config/profiles/main.yaml', 'contents: []\n');
  await write(f.from, 'config/profiles/codexp.yaml', 'contents: []\n');
  const done = await prepare({
    v4Home: f.from,
    target: f.to,
    lock: { held: async () => false },
    now: () => new Date('2026-11-09T00:00:00Z'),
    home: join(f.root, 'home'),
  });
  return { f, done };
}

describe('MAJOR-1 Codex runtimes are held out of the preview', () => {
  test('the switch is off', () => {
    expect(PREVIEW_CODEX_RUNTIMES).toBe(false);
  });

  test('a v4 home with one Claude and one Codex runtime converts the Claude one and holds the Codex one by name', async () => {
    const { f, done } = await convertedHome();
    try {
      expect(done.report?.complete).toBe(true);
      expect(existsSync(join(f.to, 'config/runtimes/silent.yaml'))).toBe(false);
      expect(existsSync(join(f.to, 'config/runtimes/claude-work.yaml'))).toBe(true);
      expect(existsSync(join(f.to, 'config/profiles/main.yaml'))).toBe(true);
      expect(existsSync(join(f.to, 'config/runtimes/codex-work.yaml'))).toBe(false);
      // The profile only the Codex runtime used is held with it; no Codex settings item is written either.
      expect(existsSync(join(f.to, 'config/profiles/codexp.yaml'))).toBe(false);
      expect(existsSync(join(f.to, `config/codex/settings/${PREVIEW_SETTINGS_ITEM}.yaml`))).toBe(false);
      // The default runtime named the held one: it is dropped, not left dangling.
      expect(await readFile(join(f.to, 'config/runtimes.yaml'), 'utf8').catch(() => '')).not.toContain('codex-work');
      const report = JSON.stringify(done.report);
      expect(report).toContain('runtime codex-work (Codex)');
      expect(report).toContain('profile codexp');
      expect(report).toContain('runtime silent');
      expect(report).not.toContain('runtime claude-work');
      expect(report).toContain(CODEX_HELD_SENTENCE.slice(0, 60));
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});

describe('the Claude path: a converted Claude ferret login shell reaches the preview fy, not v4 fy (a real bash -lc)', () => {
  test('bash -lc under the daemon env plus the converted settings.env, with a temp HOME', async () => {
    const { f, done } = await convertedHome();
    try {
      expect(done.report?.complete).toBe(true);
      const target = await realpath(f.to);
      const claude = parseYaml(
        await readFile(join(target, `config/claude-code/settings/${PREVIEW_SETTINGS_ITEM}.yaml`), 'utf8'),
      );
      const settingsEnv = claude.settings.env as Record<string, string>;
      expect(settingsEnv).toEqual(previewShellEnv(target, PREVIEW.port));

      // The preview's own `fy` (the shim) and, in the temp HOME's nix profile, a stand-in for v4's `fy`.
      await mkdir(join(target, 'bin'), { recursive: true });
      await writeFile(join(target, 'bin/fy'), shimText(target, 'fy'), { mode: 0o755 });
      const home = join(root, 'home');
      const v4Fy = join(home, '.nix-profile/bin/fy');
      await mkdir(join(v4Fy, '..'), { recursive: true });
      await writeFile(v4Fy, '#!/bin/sh\necho v4\n');
      await chmod(v4Fy, 0o755);

      // The daemon's environment as fy5 builds it (its bin first), then what Claude's settings.env adds.
      const base = {
        HOME: home,
        USER: 'probe',
        PATH: previewPath(target, '/nonexistent-v4/.ferretry', '/usr/bin:/bin'),
      };
      const probe = (env: Record<string, string>) =>
        Bun.spawnSync(['bash', '-lc', 'command -v fy; printf %s "$FY_HOME"'], { env });
      const guarded = probe({ ...base, ...settingsEnv });
      const lines = guarded.stdout.toString().split('\n');
      console.log(`probe fy=${lines[0]} FY_HOME=${lines[1]}`);
      expect(guarded.exitCode).toBe(0);
      expect(lines[0]).toBe(join(target, 'bin/fy'));
      expect(lines[1]).toBe(target);

      // The probe can tell: without the guard this box's nix profile script puts the nix profile first.
      if (existsSync('/etc/profile.d/nix.sh')) {
        const { __ETC_PROFILE_NIX_SOURCED: _guard, ...unguarded } = settingsEnv;
        const control = probe({ ...base, ...unguarded })
          .stdout.toString()
          .split('\n')[0];
        expect(control).toBe(v4Fy);
      }
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
});

describe('Nit 2 shell_environment_policy.set is an env map in the gate', () => {
  const needles = needlesFor('/home/u/.ferretry', '/home/u');
  test('a variable called NAME under set is judged like one under env', () => {
    const hits = (doc: unknown) => gatedFields(doc, needles, { strict: true });
    expect(hits({ shell_environment_policy: { set: { NAME: '/home/u/.ferretry/bin' } } })).toEqual([
      'shell_environment_policy.set.NAME',
    ]);
    expect(hits({ other: { set: { NAME: '/home/u/.ferretry/bin' } } })).toEqual([]);
  });
});

describe('Nit 3 a failed VACUUM INTO is reported with its own reason', () => {
  test('an unwritable target names VACUUM INTO, not integrity_check', async () => {
    const { Database } = await import('bun:sqlite');
    const from = join(root, 'a.sqlite');
    const db = new Database(from);
    db.run('create table t (x)');
    db.close();
    const message = await copySqlite(from, join(root, 'no-such-folder/out.sqlite')).then(
      () => '',
      error => (error as Error).message,
    );
    expect(message).toContain('VACUUM INTO failed');
    expect(message).not.toContain('integrity_check');
  });
});
