import { describe, expect, test } from 'bun:test';
import { rootRunFolder } from '../../daemon/adapters/run-folder.ts';

type Calls = string[];
function root(
  options: { exists?: boolean; problem?: boolean; throws?: boolean; refusePath?: boolean; entries?: string[] } = {},
) {
  const calls: Calls = [];
  const port = {
    resolve: () =>
      options.refusePath === true
        ? ({ ok: false, error: 'outside' } as const)
        : ({ ok: true, value: '/home/o/.ferretry/state/git-accounts/downloads/.' } as const),
    checkPrivateChain: async (path: string) => {
      calls.push(`chain ${path}`);
      if (options.throws === true) throw new Error('refused');
      return options.problem === true ? { ok: false as const, error: {} } : { ok: true as const, value: undefined };
    },
    lstat: async (path: string) => {
      calls.push(`lstat ${path}`);
      return options.exists === true ? { kind: 'other' } : undefined;
    },
    remove: async (path: string) => void calls.push(`remove ${path}`),
    makeDirectory: async (path: string, made?: { mode?: number }) =>
      void calls.push(`mkdir ${path} ${made?.mode?.toString(8) ?? ''}`),
    setMode: async (path: string, mode: number) => void calls.push(`chmod ${path} ${mode.toString(8)}`),
    list: async (path: string) => {
      calls.push(`list ${path}`);
      return options.entries ?? [];
    },
    publish: async (path: string, bytes: Uint8Array, publish?: { mode?: number }) => {
      calls.push(`publish ${path} ${new TextDecoder().decode(bytes)} ${publish?.mode?.toString(8) ?? ''}`);
      return { outcome: 'published' as const, identity: { device: 1n, inode: 1n } };
    },
  };
  return { calls, folder: rootRunFolder(port as never) };
}

describe('the agent folder over the plugin’s own downloads root', () => {
  test('its path is the root’s folder, the same each time', () => {
    expect(root().folder.path).toBe('/home/o/.ferretry/state/git-accounts/downloads');
    expect(root().folder.path).toBe(root().folder.path);
  });

  test('private only when the whole chain is; a refusal or a problem is "not private", never a throw', async () => {
    expect(await root().folder.isPrivate()).toBe(true);
    expect(await root({ problem: true }).folder.isPrivate()).toBe(false);
    expect(await root({ throws: true }).folder.isPrivate()).toBe(false);
  });

  test('a stale socket is removed only when something is there; a file is published with exactly its mode', async () => {
    const gone = root();
    await gone.folder.remove('gha_1.sock');
    expect(gone.calls).toEqual(['lstat /home/o/.ferretry/state/git-accounts/downloads/gha_1.sock']);
    const there = root({ exists: true });
    await there.folder.remove('gha_1.sock');
    expect(there.calls.at(-1)).toBe('remove /home/o/.ferretry/state/git-accounts/downloads/gha_1.sock');
    await there.folder.publish('known_hosts', 'github.com x\n', 0o600);
    expect(there.calls.at(-1)).toBe(
      'publish /home/o/.ferretry/state/git-accounts/downloads/known_hosts github.com x\n 600',
    );
  });

  test('an emptied folder is made when it is not there, opened, cleared, then narrowed to exactly its mode', async () => {
    const base = '/home/o/.ferretry/state/git-accounts/downloads';
    const fresh = root();
    await fresh.folder.emptyDirectory('pane-gh-config', 0o500);
    expect(fresh.calls).toEqual([
      `lstat ${base}/pane-gh-config`,
      `mkdir ${base}/pane-gh-config 700`,
      `chmod ${base}/pane-gh-config 700`,
      `list ${base}/pane-gh-config`,
      `chmod ${base}/pane-gh-config 500`,
    ]);
    const stale = root({ exists: true, entries: ['README', 'hosts.yml'] });
    await stale.folder.emptyDirectory('pane-gh-config', 0o500);
    expect(stale.calls).toEqual([
      `lstat ${base}/pane-gh-config`,
      `chmod ${base}/pane-gh-config 700`,
      `list ${base}/pane-gh-config`,
      `remove ${base}/pane-gh-config/README`,
      `remove ${base}/pane-gh-config/hosts.yml`,
      `chmod ${base}/pane-gh-config 500`,
    ]);
  });

  test('a root that cannot be located is a boot error, in words', () => {
    expect(() => root({ refusePath: true })).toThrow('the agent folder could not be located');
  });
});
