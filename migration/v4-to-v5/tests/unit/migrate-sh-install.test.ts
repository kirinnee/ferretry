import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { advance, makeSandbox, type Sandbox, writeV5Build } from './migrate-harness.ts';

setDefaultTimeout(60_000);

const made: Sandbox[] = [];
const box = async (options?: Parameters<typeof makeSandbox>[0]): Promise<Sandbox> => {
  const sb = await makeSandbox(options);
  made.push(sb);
  return sb;
};
afterEach(async () => {
  await Promise.all(made.splice(0).map(sb => sb.cleanup()));
});

describe('preflight refusals', () => {
  test('a v4 older than 4.291.10 is refused (never a bare update)', async () => {
    const sb = await box();
    await sb.state('fy.version', '4.291.9\n');
    const result = await sb.run('preflight', ['--notes', sb.notes]);
    expect(result.code).toBe(1);
    expect(result.err).toContain('4.291.10');
  });

  test('a checkout that is not exactly a released v5 tag is refused, unless MIGRATE_REHEARSAL=1', async () => {
    const sb = await box({ tag: null });
    const refused = await sb.run('preflight', ['--notes', sb.notes]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('released');
    const allowed = await sb.run('preflight', ['--notes', sb.notes], { MIGRATE_REHEARSAL: '1' });
    expect(allowed.code).toBe(0);
    expect(allowed.out).toContain('rehearsal');
  });

  test('a Homebrew cask that does not offer the tag yet is refused', async () => {
    const sb = await box();
    await sb.fake('brew', [
      { match: 'list --cask', out: 'ferretry@4' },
      { match: 'info --cask --json=v2 *', out: '{"casks":[{"version":"4.291.15"}]}' },
    ]);
    const result = await sb.run('preflight', ['--notes', sb.notes]);
    expect(result.code).toBe(1);
    expect(result.err).toContain('not released through Homebrew');
  });

  test('a home without layout-version (a v5 home) and a re-used notes file are refused', async () => {
    const sb = await box();
    await writeFile(join(sb.v4home, 'layout-version'), '3\n');
    expect((await sb.run('preflight', ['--notes', sb.notes])).code).toBe(1);
    await writeFile(join(sb.v4home, 'layout-version'), '2\n');
    expect((await sb.run('preflight', ['--notes', sb.notes])).code).toBe(0);
    const again = await sb.run('preflight', ['--notes', sb.notes]);
    expect(again.code).toBe(1);
    expect(again.err).toContain('already exists');
  });

  test('an unknown phase is a usage error (64)', async () => {
    const sb = await box();
    expect((await sb.run('frobnicate')).code).toBe(64);
  });
});

describe('install: explicit package states', () => {
  test('Homebrew main cask v4 -> brew upgrade --cask ferretry', async () => {
    const sb = await box({ casks: 'ferretry\n' });
    await advance(sb, 'convert');
    const result = await sb.run('install');
    expect(result.code).toBe(0);
    expect(await sb.notesText()).toContain('PKG_BEFORE=cask:ferretry');
    expect(await sb.calls()).toContain('brew upgrade --cask ferretry');
  });

  test('Homebrew with neither cask: install the v5 cask directly, nothing is uninstalled', async () => {
    const sb = await box({ casks: 'ferretry@4\n' });
    await advance(sb, 'convert');
    await sb.state('brew.casks', '');
    await sb.fake('brew', [
      { match: 'list --cask', run: 'cat "$D/brew.casks"' },
      {
        match: 'install --cask kirinnee/ferretry/ferretry',
        run: 'echo ferretry > "$D/brew.casks"; echo 5.0.0 > "$D/fy.version"; echo 5.0.0 > "$D/fyd.version"',
      },
    ]);
    const result = await sb.run('install');
    expect(result.code).toBe(0);
    expect(await sb.notesText()).toContain('PKG_BEFORE=none');
    expect((await sb.calls()).filter(line => line.startsWith('brew uninstall'))).toEqual([]);
  });

  test('a v5 cask install that fails is exit 1 and leaves `installing-v5` (never `installed-v5`) in the notes', async () => {
    const sb = await box();
    await advance(sb, 'convert');
    await sb.fake('brew', [
      { match: 'list --cask', out: 'ferretry@4' },
      { match: 'uninstall --cask *' },
      { match: 'install --cask *', code: 1 },
    ]);
    const result = await sb.run('install');
    expect(result.code).toBe(1);
    const notes = await sb.notesText();
    expect(notes).toContain('# installing-v5');
    expect(notes).not.toContain('# installed-v5');
  });

  test('nix profile: the element is found by its flake URL (Name: or Index:) and replaced by the tag', async () => {
    for (const [label, element] of [
      ['Name: ferretry', 'ferretry'],
      ['Index: 3', '3'],
    ] as const) {
      const sb = await box({ casks: '' });
      await sb.state('nix.profile', `${label}\nOriginal flake URL: github:kirinnee/ferretry/v4.291.12\n`);
      await sb.fake('brew', [{ match: 'list --cask', code: 1 }]);
      await advance(sb, 'convert');
      expect(await sb.notesText()).toContain('KIND=nix-profile');
      const result = await sb.run('install');
      expect(result.code).toBe(0);
      const calls = await sb.calls();
      expect(calls).toContain(`nix profile remove ${element}`);
      expect(calls).toContain('nix profile add github:kirinnee/ferretry/v5.0.0');
      expect(calls.indexOf(`nix profile remove ${element}`)).toBeLessThan(
        calls.indexOf('nix profile add github:kirinnee/ferretry/v5.0.0'),
      );
    }
  });

  test('nix profile install on an old Nix (no `add`) uses `install`', async () => {
    const sb = await box({ casks: '' });
    await sb.state('nix.profile', 'Index: 3\nFlake URL: github:kirinnee/ferretry/v4.291.12\n');
    await sb.fake('brew', [{ match: 'list --cask', code: 1 }]);
    await sb.fake('nix', [
      { match: 'profile list', run: 'cat "$D/nix.profile"' },
      { match: 'flake metadata *' },
      { match: 'profile add --help', code: 1 },
      { match: 'profile remove 3', run: ': > "$D/nix.profile"' },
      {
        match: 'profile install github:kirinnee/ferretry/v5.0.0',
        run: 'echo 5.0.0 > "$D/fy.version"; echo 5.0.0 > "$D/fyd.version"',
      },
    ]);
    await advance(sb, 'convert');
    const result = await sb.run('install');
    expect(result.code).toBe(0);
    expect(await sb.calls()).toContain('nix profile remove 3');
    expect(await sb.calls()).toContain('nix profile install github:kirinnee/ferretry/v5.0.0');
  });

  test('standalone: the v4 programs are copied aside (with their paths) before fy replaces them', async () => {
    const sb = await box({ casks: '' });
    await sb.fake('brew', [{ match: 'list --cask', code: 1 }]);
    await advance(sb, 'convert');
    const result = await sb.run('install');
    expect(result.code).toBe(0);
    expect(await sb.calls()).toContain('fy daemon update --major --yes --to 5.0.0');
    const aside = `${sb.v4home}-before-2026-11-13-1200-bin`;
    expect(await readFile(join(aside, 'paths.txt'), 'utf8')).toContain('/fakebin/fy');
    expect((await readFile(join(aside, 'fy'), 'utf8')).length).toBeGreaterThan(0);
  });

  test('fy that prints a version other than the tag is refused', async () => {
    const sb = await box();
    await advance(sb, 'convert');
    await sb.fake('brew', [
      { match: 'list --cask', out: 'ferretry@4' },
      { match: 'uninstall --cask *' },
      { match: 'install --cask *', run: 'echo 5.0.1 > "$D/fy.version"; echo 5.0.1 > "$D/fyd.version"' },
    ]);
    const result = await sb.run('install');
    expect(result.code).toBe(1);
    expect(result.err).toContain('must match');
  });
});

describe('macOS: the quarantine attribute', () => {
  test('an absent attribute is expected (no `xattr -d`, no error); a present one is removed', async () => {
    const absent = await box({ tag: null });
    await writeV5Build(absent);
    await advance(absent, 'preflight').catch(() => undefined);
    const env = { MIGRATE_REHEARSAL: '1', MIGRATE_OS: 'Darwin' };
    expect((await absent.run('preflight', ['--notes', absent.notes], env)).code).toBe(0);
    for (const phase of [
      ['baseline', ['--asks-open', '0']],
      ['quiet', ['--owner-confirmed']],
      ['backup', ['--owner-yes']],
      ['convert', []],
    ] as const) {
      expect((await absent.run(phase[0], phase[1], env)).code).toBe(0);
    }
    const ok = await absent.run('install', ['--rehearsal-build', absent.v5bin], env);
    expect(ok.code).toBe(0);
    expect((await absent.calls()).filter(line => line.startsWith('xattr -d'))).toEqual([]);
    expect((await absent.calls()).filter(line => line.startsWith('xattr -p')).length).toBe(2);
  });

  test('present attribute is removed from both programs', async () => {
    const sb = await box({ tag: null });
    await writeV5Build(sb);
    await sb.fake('xattr', [{ match: '-p com.apple.quarantine *' }, { match: '-d com.apple.quarantine *' }]);
    const env = { MIGRATE_REHEARSAL: '1', MIGRATE_OS: 'Darwin' };
    expect((await sb.run('preflight', ['--notes', sb.notes], env)).code).toBe(0);
    for (const phase of [
      ['baseline', ['--asks-open', '0']],
      ['quiet', ['--owner-confirmed']],
      ['backup', ['--owner-yes']],
      ['convert', []],
    ] as const) {
      expect((await sb.run(phase[0], phase[1], env)).code).toBe(0);
    }
    expect((await sb.run('install', ['--rehearsal-build', sb.v5bin], env)).code).toBe(0);
    expect((await sb.calls()).filter(line => line.startsWith('xattr -d'))).toHaveLength(2);
  });
});

describe('install --rehearsal-build (a sandbox proof only)', () => {
  const rehearsalEnv = { MIGRATE_REHEARSAL: '1' };
  const upToConvert = async (sb: Sandbox, env: Record<string, string> = rehearsalEnv): Promise<void> => {
    expect((await sb.run('preflight', ['--notes', sb.notes], env)).code).toBe(0);
    for (const phase of [
      ['baseline', ['--asks-open', '0']],
      ['quiet', ['--owner-confirmed']],
      ['backup', ['--owner-yes']],
      ['convert', []],
    ] as const) {
      const result = await sb.run(phase[0], phase[1], env);
      if (result.code !== 0) throw new Error(result.all);
    }
  };

  test('refuses without MIGRATE_REHEARSAL=1', async () => {
    const sb = await box();
    await writeV5Build(sb);
    await advance(sb, 'convert');
    const result = await sb.run('install', ['--rehearsal-build', sb.v5bin]);
    expect(result.code).toBe(1);
    expect(result.err).toContain('MIGRATE_REHEARSAL=1');
    expect((await sb.calls()).filter(line => line.startsWith('brew'))).not.toContain(
      'brew install --cask kirinnee/ferretry/ferretry',
    );
  });

  test('refuses the default home ($HOME/.ferretry), even with MIGRATE_REHEARSAL=1 (already in preflight: see migrate-sh-fix1 P1-7)', async () => {
    const sb = await box({ homeName: '.ferretry', tag: null });
    await writeV5Build(sb);
    const result = await sb.run('preflight', ['--notes', sb.notes], rehearsalEnv);
    expect(result.code).toBe(1);
    expect(result.err).toContain('never for a real home');
  });

  test('install itself re-checks the default home from the recorded notes (a notes file edited into a rehearsal)', async () => {
    const sb = await box({ homeName: '.ferretry' });
    await writeV5Build(sb);
    await advance(sb, 'convert');
    await writeFile(sb.notes, (await sb.notesText()).replace('REHEARSAL=0', 'REHEARSAL=1'));
    const result = await sb.run('install', ['--rehearsal-build', sb.v5bin], rehearsalEnv);
    expect(result.code).toBe(1);
    expect(result.err).toContain('never for a real home');
    expect(
      (await sb.calls()).filter(line => /^(brew|nix) /.test(line) && /install|uninstall|upgrade|remove/.test(line)),
    ).toEqual([]);
  });

  test('in a sandbox it works, says the app origin is the preview, never touches a package manager, and v5 runs from the build folder', async () => {
    const sb = await box({ tag: null });
    await writeV5Build(sb);
    await upToConvert(sb);
    const result = await sb.run('install', ['--rehearsal-build', sb.v5bin], rehearsalEnv);
    expect(result.code).toBe(0);
    expect(result.out).toContain('ferretry-v5.pages.dev');
    expect(result.out).toContain('never for a real home');
    expect(
      (await sb.calls()).filter(line =>
        /^(brew|nix) (install|uninstall|upgrade|profile (add|remove|install))/.test(line),
      ),
    ).toEqual([]);
    const started = await sb.run('start', [], rehearsalEnv);
    expect(started.code).toBe(0);
    const env = await sb.envLog();
    expect(env.find(line => line.startsWith('v5build-fy|daemon start'))).toBeDefined();
    expect(await sb.notesText()).toContain('PKG_BEFORE=rehearsal');
  });
});
