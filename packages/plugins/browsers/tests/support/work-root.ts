import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';
import type { FencedPath, FolderRefusal, RootHandle, RootStat, RootsPort } from '@ferretry/kernel/contract';
import { err, instantFromEpochMs, ok } from '@ferretry/std';

/** A refusal shaped as the kernel root's own (`RootError`): a word, never the path. */
class RootRefusal extends Error {
  constructor(readonly refusal: FolderRefusal) {
    super(`root refused: ${refusal}`);
  }
}

/** A root operation the browser tools never use through this stand-in. */
const unused = (operation: string) => async (): Promise<never> => {
  throw new Error(`the browser tools use no ${operation} through the root`);
};

const inside = (base: string, path: string): boolean => {
  const rel = relative(base, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
};

/**
 * The kernel's `work` root for one folder, as a test stand-in for the host's `rootsPortFor` over Ferrets'
 * `WorkFolders`: a path is resolved lexically inside the folder, and READ through its real path, refusing a link that
 * leaves the folder (`link_escape`) and anything in the daemon's state home (`fenced`).
 */
export function workRoots(folder: string, stateHome: string): RootsPort {
  const real = async (path: FencedPath): Promise<string> => {
    const base = await realpath(folder);
    const fence = await realpath(stateHome).catch(() => stateHome);
    const resolved = await realpath(path).catch(() => undefined);
    if (resolved === undefined) return path;
    if (inside(fence, resolved)) throw new RootRefusal('fenced');
    if (!inside(base, resolved)) throw new RootRefusal('link_escape');
    return resolved;
  };
  const handle: RootHandle = {
    name: 'work' as RootHandle['name'],
    internal: false,
    resolve: requested => {
      const path = normalize(join(folder, requested));
      if (!inside(folder, path)) return err('outside');
      if (inside(stateHome, path)) return err('fenced');
      return ok(path as FencedPath);
    },
    readText: async path => await readFile(await real(path), 'utf8'),
    readBytes: async (path, limit) => {
      const bytes = new Uint8Array(await readFile(await real(path)));
      if (typeof limit === 'object') return bytes.slice(limit.offset, limit.offset + limit.length);
      return limit === undefined ? bytes : bytes.slice(0, limit);
    },
    writeText: async () => {
      throw new Error('the browser tools write no text through the root');
    },
    list: async () => [],
    stat: async (path): Promise<RootStat | undefined> => {
      const info = await lstat(await real(path)).catch(() => undefined);
      if (info === undefined || (!info.isFile() && !info.isDirectory())) return undefined;
      return {
        kind: info.isFile() ? 'file' : 'directory',
        size: info.size,
        modified: instantFromEpochMs(info.mtimeMs),
        mode: info.mode & 0o7777,
        links: info.nlink,
      };
    },
    remove: async () => {
      throw new Error('the browser tools remove nothing through the root');
    },
    readTail: unused('readTail'),
    writeBytes: unused('writeBytes'),
    copyTree: unused('copyTree'),
    copyShared: unused('copyShared'),
    linkCredential: unused('linkCredential'),
    ensurePrivateDirectory: unused('ensurePrivateDirectory'),
    entries: unused('entries'),
    lstat: unused('lstat'),
    makeDirectory: unused('makeDirectory'),
    realPath: unused('realPath'),
    pin: unused('pin'),
    publish: unused('publish'),
    readDurable: unused('readDurable'),
    syncDirectory: unused('syncDirectory'),
    fileIdentity: unused('fileIdentity'),
    linkTo: unused('linkTo'),
    setMode: unused('setMode'),
    rename: unused('rename'),
    unlink: unused('unlink'),
    checkPrivateChain: unused('checkPrivateChain'),
  };
  return {
    root: () => handle,
    share: unused('share'),
    shareCredential: unused('shareCredential'),
    harnessFile: () => {
      throw new Error('the work-root fixture has no harness file');
    },
  };
}
