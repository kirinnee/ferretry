import { describe, expect, test } from 'bun:test';
import { ApiError } from '@ferretry/kernel/contract';
import { ghLocator } from '../../daemon/lib/gh-locator.ts';
import { testClient } from './run-folder.ts';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';

const HOME = '/h/.fy';

/** Ports over a made-up machine: `found` maps a directory list to nothing, the first folder holding a `gh` wins. */
function locator(
  path: string | undefined,
  hasGh: readonly string[],
  fenced: (path: string) => string | undefined = () => undefined,
) {
  const asked: { directories: readonly string[] }[] = [];
  const checked: string[] = [];
  const run = ghLocator({
    home: () => '/home/synthetic',
    bindProgram: async program => testClient(program),
    daemonPath: () => path,
    which: async (name, options) => {
      asked.push(options);
      const dirs = [...options.directories, ...(path ?? '').split(':')];
      const folder = dirs.find(dir => hasGh.includes(dir));
      return folder === undefined ? undefined : `${folder}/${name}`;
    },
    stateHomeHolding: async candidate => {
      checked.push(candidate);
      return fenced(candidate);
    },
  });
  return { run, asked, checked };
}
const inHome = (path: string) => (path === HOME || path.startsWith(`${HOME}/`) ? HOME : undefined);

describe('which gh runs with a token', () => {
  test('S3: an arbitrary Nix-store client on daemon PATH is refused', async () => {
    const { run, asked } = locator('/nix/store/agent-selected/bin', ['/nix/store/agent-selected/bin']);
    await expect(run()).rejects.toThrow('not in a trusted installation');
    expect(asked[0]?.directories).not.toContain('/nix/store/agent-selected/bin');
  });

  test('S3: only fixed Nix profile roots may select store clients', async () => {
    for (const directory of [
      '/home/synthetic/.nix-profile/bin',
      `/etc/profiles/per-user/${userInfo().username}/bin`,
      '/run/current-system/sw/bin',
      '/nix/var/nix/profiles/default/bin',
    ]) {
      const run = ghLocator({
        home: () => '/home/synthetic',
        daemonPath: () => '/nix/store/agent-selected/bin',
        which: async (name, options) => (options.directories.includes(directory) ? `${directory}/${name}` : undefined),
        stateHomeHolding: async () => undefined,
        bindProgram: async named => testClient(`/nix/store/fixed-profile/bin/${named.split('/').at(-1)}`),
      });
      expect((await run()).program).toBe('/nix/store/fixed-profile/bin/gh');
    }
  });
  test('S3: a Nix profile must resolve into the Nix store', async () => {
    const run = ghLocator({
      home: () => '/home/synthetic',
      daemonPath: () => '/usr/bin',
      which: async name => `/home/synthetic/.nix-profile/bin/${name}`,
      stateHomeHolding: async () => undefined,
      bindProgram: async () => testClient('/usr/bin/gh'),
    });
    await expect(run()).rejects.toThrow('not in a trusted installation');
  });

  test('R2 portability: fixed package-prefix order ignores a planted earlier PATH client', async () => {
    const asked: string[][] = [];
    const bound: string[] = [];
    const run = ghLocator({
      home: () => '/home/synthetic',
      daemonPath: () => '/tmp/planted:/usr/local/bin:/opt/homebrew/bin',
      which: async (name, options) => {
        asked.push([...options.directories]);
        const found = options.directories.find(dir =>
          ['/tmp/planted', '/usr/local/bin', '/opt/homebrew/bin'].includes(dir),
        );
        return found === undefined ? undefined : `${found}/${name}`;
      },
      stateHomeHolding: async () => undefined,
      bindProgram: async program => {
        bound.push(program);
        return testClient(program);
      },
    });
    expect((await run()).program).toBe('/opt/homebrew/bin/gh');
    expect(bound).toEqual(['/opt/homebrew/bin/gh', '/opt/homebrew/bin/git']);
    expect(asked[0]).not.toContain('/tmp/planted');
  });
  test('R2: gh can start identity-bound git when fixed profiles resolve to separate Nix-store directories', async () => {
    const home = mkdtempSync(join(tmpdir(), 'g21-nix-'));
    try {
      const ghBin = join(home, 'nix/store/gh/bin');
      const gitBin = join(home, 'nix/store/git/bin');
      mkdirSync(ghBin, { recursive: true });
      mkdirSync(gitBin, { recursive: true });
      const git = `${gitBin}/git`;
      const gh = `${ghBin}/gh`;
      writeFileSync(git, '#!/bin/sh\nprintf "synthetic-git\\n"\n', { mode: 0o755 });
      // Do not execute any real system git even on red: check its resolved name before calling it.
      writeFileSync(gh, `#!/bin/sh\n[ "$(command -v git)" = '${git}' ] || exit 42\nexec git\n`, { mode: 0o755 });
      const bound: string[] = [];
      const namedGh = '/nix/store/synthetic-gh/bin/gh';
      const namedGit = '/nix/store/synthetic-git/bin/git';
      const launch = await ghLocator({
        home: () => '/home/synthetic',
        daemonPath: () => '/pane-untrusted:/nix/store/synthetic-gh/bin:/nix/store/synthetic-git/bin',
        which: async name => `/home/synthetic/.nix-profile/bin/${name}`,
        stateHomeHolding: async () => undefined,
        bindProgram: async program => {
          bound.push(program);
          const isGh = program.endsWith('/gh');
          return { ...testClient(isGh ? gh : git), program: isGh ? namedGh : namedGit };
        },
      })();
      // Map the synthetic kernel's canonical store names onto this test's temporary filesystem.
      const childPath = launch.path
        .replace('/nix/store/synthetic-gh/bin', ghBin)
        .replace('/nix/store/synthetic-git/bin', gitBin);
      const result = Bun.spawnSync([gh], { env: { HOME: home, PATH: childPath } });
      expect(result.exitCode).toBe(0);
      expect(new TextDecoder().decode(result.stdout)).toBe('synthetic-git\n');
      expect(launch.program).toBe(namedGh);
      expect(launch.path).toBe('/nix/store/synthetic-git/bin:/nix/store/synthetic-gh/bin:/usr/bin:/bin');
      expect(bound).toEqual(['/home/synthetic/.nix-profile/bin/gh', '/home/synthetic/.nix-profile/bin/git']);
      expect(await launch.verify()).toBe(true);
      writeFileSync(git, '#!/bin/sh\nexit 99\n', { mode: 0o755 });
      expect(await launch.verify()).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('R2 portability: a fixed prefix resolving into an arbitrary project is refused', async () => {
    const run = ghLocator({
      home: () => '/home/synthetic',
      daemonPath: () => '/tmp/planted',
      which: async name => `/opt/homebrew/bin/${name}`,
      stateHomeHolding: async () => undefined,
      bindProgram: async () => testClient('/synthetic-project/gh'),
    });
    await expect(run()).rejects.toThrow('not in a trusted installation');
  });

  test('the first gh outside the state home, as an absolute path; state-home, relative, empty and repeated entries are never offered', async () => {
    const { run, asked } = locator(
      `${HOME}/shims:rel/bin::/opt/bin:/opt/bin:/usr/bin`,
      [`${HOME}/shims`, '/usr/bin'],
      inHome,
    );
    // Raw daemon folders are never offered; only fixed install locations enter discovery.
    expect(await run()).toMatchObject({ program: '/usr/bin/gh', path: '/usr/bin:/bin' });
    expect(asked[0]?.directories.slice(0, 3)).toEqual([
      '/opt/homebrew/bin',
      '/usr/local/bin',
      '/home/linuxbrew/.linuxbrew/bin',
    ]);
    expect(asked[0]?.directories).not.toContain('/opt/bin');
  });

  test('only the canonical bound package directories enter the child PATH', async () => {
    const run = ghLocator({
      home: () => '/home/synthetic',
      bindProgram: async program =>
        testClient(
          `/opt/homebrew/Cellar/${program.endsWith('/gh') ? 'gh' : 'git'}/1/bin/${program.endsWith('/gh') ? 'gh' : 'git'}`,
        ),
      daemonPath: () => `${HOME}/shims`,
      which: async name => `/opt/homebrew/bin/${name}`,
      stateHomeHolding: async candidate => inHome(candidate),
    });
    expect(await run()).toMatchObject({
      program: '/opt/homebrew/Cellar/gh/1/bin/gh',
      path: '/opt/homebrew/Cellar/git/1/bin:/opt/homebrew/Cellar/gh/1/bin:/usr/bin:/bin',
    });
  });

  test('a PATH the daemon does not have still searches (the kernel falls back to its own list)', async () => {
    const { run, asked } = locator(undefined, []);
    await expect(run()).rejects.toMatchObject({ status: 403, code: 'invalid_request' });
    expect(asked[0]?.directories).toContain('/usr/bin');
  });

  test('no gh anywhere refuses in a sentence', async () => {
    await expect(locator('/usr/bin', []).run()).rejects.toThrow('no gh program was found outside');
  });

  test('a gh the kernel found inside the state home (by the fallback to the whole PATH) is refused', async () => {
    const { run, checked } = locator(`${HOME}/shims:/usr/bin`, [`${HOME}/shims`], inHome);
    await expect(run()).rejects.toThrow("inside Ferretry's own folders");
    expect(checked.at(-1)).toBe(`${HOME}/shims/gh`);
  });

  test('a fence that cannot be built is a refusal, not a guess, and the error is always an ApiError', async () => {
    const run = ghLocator({
      home: () => '/home/synthetic',
      bindProgram: async program => testClient(program),
      daemonPath: () => '/usr/bin',
      which: async () => '/usr/bin/gh',
      stateHomeHolding: async () => {
        throw new Error('fence');
      },
    });
    const error = await run().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toContain('could not check where the gh program is');
  });
});
