import { describe, it } from 'bun:test';
import should from 'should';
import { type ReplaceableDisk, replaceableBy } from '../../../src/adapters/system/replaceable-file.ts';

const ME = 1000;
const ROOT = 0;

type Node =
  | { readonly kind: 'dir' | 'file'; readonly uid: number; readonly mode: number }
  | { readonly kind: 'link'; readonly uid: number; readonly to: string };

/** A disk of absolute paths. Every parent a test names must be listed too, as it would be on a real disk. */
function disk(nodes: Record<string, Node>): ReplaceableDisk {
  return {
    lstat: async path => {
      const node = nodes[path];
      if (node === undefined) throw new Error(`ENOENT ${path}`);
      return {
        uid: node.uid,
        mode: node.kind === 'link' ? 0o777 : node.mode,
        isSymbolicLink: () => node.kind === 'link',
      };
    },
    readlink: async path => {
      const node = nodes[path];
      if (node?.kind !== 'link') throw new Error(`EINVAL ${path}`);
      return node.to;
    },
  };
}

const dir = (uid = ROOT, mode = 0o755): Node => ({ kind: 'dir', uid, mode });
const file = (uid = ROOT, mode = 0o755): Node => ({ kind: 'file', uid, mode });
const link = (to: string, uid = ROOT): Node => ({ kind: 'link', uid, to });

/** A system with a root `/usr/bin`, the Nix store, a system profile and this account's home. */
const SYSTEM: Record<string, Node> = {
  '/': dir(),
  '/usr': dir(),
  '/usr/bin': dir(),
  '/usr/bin/env': file(),
  '/home': dir(),
  '/home/me': dir(ME, 0o700),
  '/nix': dir(),
  '/nix/store': dir(ROOT, 0o1775),
  '/nix/store/aaa-gh': dir(),
  '/nix/store/aaa-gh/bin': dir(),
  '/nix/store/aaa-gh/bin/gh': file(ROOT, 0o555),
  // `nix-store --add` of a bash copy named gh: root-owned like every store path, but this account put it there.
  '/nix/store/zzz-gh': dir(),
  '/nix/store/zzz-gh/bin': dir(),
  '/nix/store/zzz-gh/bin/gh': file(ROOT, 0o555),
  '/run': dir(),
  '/run/current-system': link('/nix/store/sys'),
  '/nix/store/sys': dir(),
  '/nix/store/sys/sw': dir(),
  '/nix/store/sys/sw/bin': dir(),
  '/nix/store/sys/sw/bin/gh': link('/nix/store/aaa-gh/bin/gh'),
};

const FOLDERS = ['/usr/bin', '/run/current-system/sw/bin'];
const replaceable = async (path: string, extra: Record<string, Node> = {}): Promise<boolean> =>
  await replaceableBy(ME, path, disk({ ...SYSTEM, ...extra }), FOLDERS);

describe('whether this account could replace a program', () => {
  it('should not call a root file in a root folder replaceable', async () => {
    should(await replaceable('/usr/bin/env')).be.false();
  });

  it('should call a file in its own home, a missing one, or a relative path replaceable', async () => {
    should(await replaceable('/home/me/gh', { '/home/me/gh': file(ROOT) })).be.true();
    should(await replaceable('/usr/bin/nope')).be.true();
    should(await replaceable('usr/bin/env')).be.true();
  });

  it('should call a folder anyone may write replaceable, unless it is sticky', async () => {
    should(await replaceable('/tmp/x', { '/tmp': dir(ROOT, 0o777), '/tmp/x': file() })).be.true();
    should(await replaceable('/tmp/x', { '/tmp': dir(ROOT, 0o1777), '/tmp/x': file() })).be.false();
  });
});

describe('every hop of a link chain is checked (H2)', () => {
  it('should call a root link replaceable when it points through a link this account owns', async () => {
    // /usr/bin/ssh (root) → /home/me/link (mine: I can repoint it) → /usr/bin/env (root).
    const chain = {
      '/usr/bin/ssh': link('/home/me/link'),
      '/home/me/link': link('/usr/bin/env', ME),
    };
    should(await replaceable('/usr/bin/ssh', chain)).be.true();
  });

  it('should call a path replaceable when a FOLDER on the way is a link through this account', async () => {
    // /opt (root link) → /home/me/opt (mine) → /usr; /opt/bin/env therefore resolves into /usr/bin/env.
    const chain = { '/opt': link('/home/me/opt'), '/home/me/opt': link('/usr', ME) };
    should(await replaceable('/opt/bin/env', chain)).be.true();
  });

  it('should follow a relative link, and a `..` after a link from where the link LED, as the kernel does', async () => {
    // /usr/bin/a → x/../env where x is a link into the home folder: the kernel goes /home/me/sub/.. = /home/me/env.
    const chain = {
      '/usr/bin/a': link('x/../env'),
      '/usr/bin/x': link('/home/me/sub'),
      '/home/me/sub': dir(ME),
      '/home/me/env': file(ME),
    };
    should(await replaceable('/usr/bin/a', chain)).be.true();
    // A relative link through root parts only is fine.
    should(await replaceable('/usr/bin/b', { '/usr/bin/b': link('../bin/env') })).be.false();
  });

  it('should give up on a link loop as replaceable', async () => {
    should(await replaceable('/usr/bin/loop', { '/usr/bin/loop': link('/usr/bin/loop') })).be.true();
  });
});

describe('a Nix store path is trusted only when a root-controlled folder leads to it', () => {
  it('should trust the store file a root folder entry of the same name walks to', async () => {
    should(await replaceable('/run/current-system/sw/bin/gh')).be.false();
    should(await replaceable('/nix/store/aaa-gh/bin/gh')).be.false();
  });

  it('should call a store path no root folder leads to replaceable, though root owns it (nix-store --add)', async () => {
    should(await replaceable('/nix/store/zzz-gh/bin/gh')).be.true();
  });

  it('should call a store path reached only through a profile this account owns replaceable (~/.nix-profile)', async () => {
    const profile = {
      '/home/me/.nix-profile': link('/nix/store/zzz-gh', ME),
    };
    should(await replaceable('/home/me/.nix-profile/bin/gh', profile)).be.true();
  });

  it('should not trust a store file when the root folder entry walks there through a link this account owns', async () => {
    const hijacked = {
      '/nix/store/sys/sw/bin/gh': link('/home/me/gh'),
      '/home/me/gh': link('/nix/store/zzz-gh/bin/gh', ME),
    };
    should(await replaceable('/nix/store/zzz-gh/bin/gh', hijacked)).be.true();
    should(await replaceable('/run/current-system/sw/bin/gh', hijacked)).be.true();
  });
});

describe('the real disk', () => {
  it('should call a root system program not replaceable, and the running bun replaceable when it is a raw store path', async () => {
    if (process.platform !== 'linux' && process.platform !== 'darwin') return;
    should(await replaceableBy(process.getuid?.(), '/bin/sh')).be.false();
    if (process.execPath.startsWith('/nix/store/'))
      should(await replaceableBy(process.getuid?.(), process.execPath)).be.true();
  });
});
