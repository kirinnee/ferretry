/**
 * The testing host's `project-files` root (K3): the real roots port's rules over the flat test world, with the SAME
 * refusal codes in the SAME order, so a plugin's unit test meets what production does. The real host is the reference
 * (`host/roots.ts`); the rules both read are `manifest/project-files.ts` (the declared set), `lexicalInRoot` (the
 * lexical half: plain, inside the folder, outside the fence by name) and `permittedMode`.
 *
 * Order, as production: (1) the folder is one the handle was scoped to, (2) the path is plain, inside it and outside the
 * fence by name, (3) the declared set reaches it for this use, (3b) the folder is spelled as it resolves below its anchor,
 * (4) a link at any level, (5) a hard-linked file.
 * The flat world keeps files, links, hard links and modes by key; a name is at `/project-files<absolute path>`.
 */
import type { Instant } from '@ferretry/std';
import { relative } from 'node:path';
import type { FencedPath } from '../contract/bound.ts';
import {
  MAX_ROOT_WINDOW_BYTES,
  type RootDurableHeld,
  type RootEntry,
  type RootHandle,
  type RootLstat,
  type RootStat,
} from '../contract/ports.ts';
import { lexicalInRoot, RootError } from '../host/roots.ts';
import { permittedMode, spellingHolds } from '../host/root-rules.ts';
import { refuseShared } from '../host/shared-trees.ts';
import { type ProjectUse, projectPathRefusal } from '../manifest/project-files.ts';

/** How a call treats the LEAF of its name: `follow` (a link there is refused) or `keep` (it is looked at, never followed). */
type Leaf = 'follow' | 'keep';

export interface ProjectFilesTwin {
  readonly plugin: string;
  /** The manifest's `permissions.projectFiles`. */
  readonly patterns: readonly string[] | undefined;
  /** The absolute folder this handle was scoped to, or `undefined` when the scope was refused. */
  readonly folder: string | undefined;
  /** The scope's `within` anchor as the caller spelled it, or `undefined` when none. */
  readonly within: string | undefined;
  /**
   * Folders the test says are links: an absolute folder → the real path it resolves to. The flat world has no links of
   * its own at a folder level, so this is how a unit test says "this project folder (or one above it) is a link", and
   * the spelling rule below the anchor (`spellingHolds`, the one production reads) is judged over it.
   */
  readonly linkedFolders: ReadonlyMap<string, string> | undefined;
  /** The kernel home the fence is judged against. */
  readonly fenceHome: string;
  /** Whether the manifest declared `permissions.setMode`. */
  readonly setModeDeclared: boolean;
  /** A host that cannot reach an entry through a held folder (macOS today): every remove of an owner root, and every write a project folder makes, is refused. */
  readonly noDescriptorReach: boolean;
  readonly files: Map<string, string>;
  readonly links: Map<string, string>;
  readonly hardLinks: Set<string>;
  readonly modes: Map<string, number>;
  readonly inodes: Map<string, bigint>;
  readonly nextInode: () => bigint;
  readonly now: () => Instant;
  /** The test world's record of a handle the host made (its plugin), for a copy SOURCE. */
  readonly known: (
    handle: object,
  ) => { readonly plugin: string; readonly keyOf?: (path: string) => string } | undefined;
}

const KEY_PREFIX = '/project-files';
export const projectFileKey = (path: string): string => `${KEY_PREFIX}${path}`;

/**
 * Every `project-files` handle the twin made, with the check it makes of a folder asked of it AS A COPY SOURCE (the real
 * host's `HANDLES.real`: the declared set for a tree, and no link on the way). The other roots' twins read it, so a copy
 * out of a project folder is gated by the folder's own handle exactly as production gates it.
 */
export const PROJECT_SOURCES = new WeakMap<object, (path: string) => void>();

export function projectFilesHandle(twin: ProjectFilesTwin): RootHandle {
  const { folder, files, links, hardLinks, modes, inodes } = twin;
  const key = projectFileKey;
  /** The real path of `path` in the test world: the longest linked folder at or above it is replaced by where it leads. */
  const realOf = (path: string): string => {
    const linked = twin.linkedFolders;
    if (linked === undefined) return path;
    const hops = [...linked.keys()]
      .filter(from => path === from || path.startsWith(`${from}/`))
      .sort((a, b) => b.length - a.length)[0];
    return hops === undefined ? path : `${linked.get(hops) as string}${path.slice(hops.length)}`;
  };
  const lexical = (path: string): string => {
    if (folder === undefined) throw new RootError('outside');
    const found = lexicalInRoot(twin.fenceHome, folder, true, path);
    if (!found.ok) throw new RootError(found.error);
    return found.value;
  };
  /** The checks every call makes before anything is read or written; answers the lexical path. */
  const reach = (path: string, use: ProjectUse, leaf: Leaf): string => {
    const full = lexical(path);
    const refusal = projectPathRefusal(twin.patterns, relative(folder as string, full), use);
    if (refusal !== undefined) throw new RootError(refusal);
    // The folder resolves to exactly its spelling below the anchor (the anchor itself may be a link), else `link_escape`.
    if (
      !spellingHolds(folder as string, twin.within, realOf(folder as string), realOf(twin.within ?? (folder as string)))
    )
      throw new RootError('link_escape');
    const steps = relative(folder as string, full).split('/');
    const through = leaf === 'follow' ? steps.length : steps.length - 1;
    for (let index = 1; index <= through; index += 1)
      if (links.has(key(`${folder}/${steps.slice(0, index).join('/')}`))) throw new RootError('link_escape');
    return full;
  };
  /**
   * `reach` for a call that MAKES or WRITES something: a host with no way to reach a held folder (macOS whose C calls
   * could not load) refuses it `no_descriptor_reach`, as production does for every project-files write (it never falls
   * back to a path), after the name passed every check.
   */
  const reachForWrite = (path: string, use: ProjectUse, leaf: Leaf): string => {
    const full = reach(path, use, leaf);
    if (twin.noDescriptorReach) throw new RootError('no_descriptor_reach');
    return full;
  };
  const stat = (full: string): RootStat => ({
    kind: 'file',
    size: (files.get(key(full)) ?? '').length,
    modified: twin.now(),
    mode: modes.get(key(full)) ?? 0o600,
    links: hardLinks.has(key(full)) ? 2 : 1,
  });
  const folderExists = (full: string): boolean =>
    [...files.keys(), ...links.keys()].some(name => name.startsWith(`${key(full)}/`));
  const readable = (path: string): { readonly full: string; readonly text: string } => {
    const full = reach(path, 'file', 'follow');
    const text = files.get(key(full));
    if (text === undefined) throw new Error(`no such file ${full}`);
    if (hardLinks.has(key(full))) throw new RootError('hard_link');
    return { full, text };
  };
  const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);
  const window = (offset: number, length: number): boolean =>
    Number.isSafeInteger(offset) &&
    offset >= 0 &&
    Number.isSafeInteger(length) &&
    length >= 0 &&
    length <= MAX_ROOT_WINDOW_BYTES;
  /** A write: the leaf is never followed; a link at it, or a file with a second name, is refused. */
  const writing = (
    path: string,
    text: string,
    options: { readonly mode?: number; readonly exclusive?: boolean; readonly replaceExisting?: boolean } | undefined,
  ): string => {
    const full = reachForWrite(path, 'file', 'follow');
    const name = key(full);
    if (hardLinks.has(name) && files.has(name)) throw new RootError('hard_link');
    if (options?.exclusive === true && (files.has(name) || links.has(name))) throw new Error(`${full} already exists`);
    if (options?.replaceExisting === true && !files.has(name)) throw new RootError('outside');
    const kept = options?.replaceExisting === true ? modes.get(name) : undefined;
    files.set(name, text);
    modes.set(name, options?.mode ?? kept ?? 0o600);
    return full;
  };
  const handle: RootHandle = {
    name: 'project-files',
    internal: false,
    resolve: relativePath => {
      if (folder === undefined || typeof relativePath !== 'string' || relativePath.startsWith('/'))
        return { ok: false, error: 'outside' };
      return lexicalInRoot(twin.fenceHome, folder, true, relativePath);
    },
    readText: async path => readable(path).text,
    readBytes: async (path, limit) => {
      if (typeof limit === 'object' && !window(limit.offset, limit.length)) throw new RootError('outside');
      const bytes = bytesOf(readable(path).text);
      if (typeof limit === 'number') return bytes.slice(0, limit);
      if (limit === undefined) return bytes;
      return bytes.slice(limit.offset, limit.offset + limit.length);
    },
    readTail: async (path, maxBytes) => {
      if (!window(0, maxBytes)) throw new RootError('outside');
      const bytes = bytesOf(readable(path).text);
      return { bytes: bytes.slice(Math.max(0, bytes.length - maxBytes)), size: bytes.length };
    },
    writeText: async (path, text, options) => {
      writing(path, text, options);
    },
    writeBytes: async (path, bytes, options) => {
      writing(path, new TextDecoder().decode(bytes), options);
    },
    publish: async (path, bytes, options) => {
      const full = reachForWrite(path, 'file', 'follow');
      const name = key(full);
      if (hardLinks.has(name) && files.has(name)) throw new RootError('hard_link');
      if (options?.exclusive === true && files.has(name)) return { outcome: 'exists' };
      files.set(name, new TextDecoder().decode(bytes));
      modes.set(name, options?.mode ?? 0o600);
      const inode = twin.nextInode();
      inodes.set(name, inode);
      return { outcome: 'published', identity: { device: 1n, inode } };
    },
    readDurable: async (path, _limit, hold) => {
      const full = reach(path, 'file', 'follow');
      const name = key(full);
      const text = files.get(name);
      if (text === undefined) return undefined;
      if (hardLinks.has(name)) throw new RootError('hard_link');
      const identity = { device: 1n, inode: inodes.get(name) ?? 0n };
      const read = { bytes: bytesOf(text), identity };
      if (hold === undefined) return read as never;
      const held: RootDurableHeld = {
        ...read,
        stillNames: async () => files.has(name) && (inodes.get(name) ?? 0n) === identity.inode,
      };
      return await hold(held);
    },
    syncDirectory: async path => {
      reach(path, 'make', 'follow');
    },
    fileIdentity: async path => {
      const name = key(reach(path, 'file', 'keep'));
      return files.has(name) ? { device: 1n, inode: inodes.get(name) ?? 0n } : undefined;
    },
    copyTree: async (source, from, to, options) => {
      const known = twin.known(source);
      // As production, in its order: the destination's name and links, then the source handle (`not_declared`), then the
      // source's own gate, then the link refusal; only then the host that has no reach to a held folder refuses.
      reach(to, 'tree', 'follow');
      if (known === undefined || known.plugin !== twin.plugin) throw new RootError('not_declared');
      // The source is gated by ITS handle (a project folder: the declared set, no link on the way), as production does.
      PROJECT_SOURCES.get(source)?.(from);
      // No link is made into a project folder (`linkTo`'s refusal): a copy is the only door.
      if (options?.link === true) throw new RootError('read_only');
      if (twin.noDescriptorReach) throw new RootError('no_descriptor_reach');
      const fromKey = known.keyOf?.(from) ?? from;
      const toKey = key(lexical(to));
      for (const [name, text] of [...files])
        if (name.startsWith(`${fromKey}/`)) files.set(`${toKey}${name.slice(fromKey.length)}`, text);
    },
    copyShared: async () => refuseShared('not_internal'),
    ensurePrivateDirectory: async path => {
      reachForWrite(path, 'make', 'keep');
    },
    lstat: async (path): Promise<RootLstat | undefined> => {
      const full = reach(path, 'probe', 'keep');
      if (links.has(key(full))) return { kind: 'symlink', size: 0, modified: twin.now(), mode: 0o777, links: 1 };
      if (files.has(key(full))) return stat(full);
      return folderExists(full)
        ? { kind: 'directory', size: 0, modified: twin.now(), mode: 0o700, links: 1 }
        : undefined;
    },
    makeDirectory: async path => {
      reachForWrite(path, 'make', 'follow');
    },
    realPath: async path => {
      const full = reach(path, 'probe', 'follow');
      if (!files.has(key(full)) && !folderExists(full)) throw new Error(`no such file ${full}`);
      return full as FencedPath;
    },
    list: async path => {
      const full = reach(path, 'folder', 'follow');
      return [...files.keys(), ...links.keys()]
        .filter(name => name.startsWith(`${key(full)}/`))
        .map(name => name.slice(key(full).length + 1));
    },
    entries: async path => {
      const full = reach(path, 'folder', 'follow');
      const below = `${key(full)}/`;
      const out: RootEntry[] = [];
      for (const name of files.keys())
        if (name.startsWith(below))
          out.push({ name: name.slice(below.length), ...stat(name.slice(KEY_PREFIX.length)) });
      for (const name of links.keys())
        if (name.startsWith(below))
          out.push({
            name: name.slice(below.length),
            kind: 'symlink',
            size: 0,
            modified: twin.now(),
            mode: 0o777,
            links: 1,
          });
      return out;
    },
    stat: async path => {
      const full = reach(path, 'probe', 'follow');
      if (files.has(key(full))) return stat(full);
      return folderExists(full)
        ? { kind: 'directory', size: 0, modified: twin.now(), mode: 0o700, links: 1 }
        : undefined;
    },
    remove: async (path, removeOptions) => {
      // The leaf is never followed: a link at the name is unlinked as a link, as production does (a name above it is
      // still judged, so a link at any folder level on the way stays `link_escape`).
      const full = reach(path, 'remove', 'keep');
      // An owner's root removes nothing without descriptor reach (S44): refused after the name passed every check.
      if (twin.noDescriptorReach) throw new RootError('no_descriptor_reach');
      const name = key(full);
      // `onlyIfEmpty` is `rmdir`: a folder that holds anything is refused `not_empty`, and nothing is removed.
      if (removeOptions?.onlyIfEmpty === true && !files.has(name) && !links.has(name) && folderExists(full))
        throw new RootError('not_empty');
      for (const map of [files, links] as const)
        for (const each of [...map.keys()]) if (each === name || each.startsWith(`${name}/`)) map.delete(each);
    },
    // A project folder takes no link, no move and no link removal: the same refusal production gives a root that takes none.
    linkTo: async () => {
      throw new RootError('read_only');
    },
    rename: async () => {
      throw new RootError('read_only');
    },
    unlink: async () => {
      throw new RootError('read_only');
    },
    setMode: async (path, mode) => {
      if (!twin.setModeDeclared) throw new RootError('not_declared');
      const bits = permittedMode(false, mode);
      if (bits === undefined) throw new RootError('outside');
      const full = reach(path, 'file', 'keep');
      const name = key(full);
      if (links.has(name)) throw new RootError('link_escape');
      if (!files.has(name) && !folderExists(full)) throw new RootError('outside');
      if (hardLinks.has(name)) throw new RootError('hard_link');
      modes.set(name, bits);
    },
    pin: async () => {
      throw new RootError('not_declared');
    },
  };
  PROJECT_SOURCES.set(handle, path => {
    reach(path, 'tree', 'follow');
  });
  return handle;
}
