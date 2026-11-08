/**
 * The pure rules of `RootHandle.linkTo`, `RootHandle.setMode`, `RootHandle.rename` and `RootsPort.harnessFile` (§7.7): one fact, read by
 * the real roots port (`./roots.ts`, which adds the descriptor checks) and by the testing host, so a plugin's unit test
 * meets exactly the refusals production makes.
 */
import { posix } from 'node:path';
import { insideFence } from '../contract/home.ts';
import type { RootName } from '../contract/ports.ts';

/**
 * The roots a link may be WRITTEN into: internal, writable, made by the kernel, and holding a harness's home (a runtime
 * home in `fleet`, an agent home in `agent-homes`). Never an owner's root, never `sessions` or `credentials` (their
 * owners write files, not pointers), never `downloads` or `worktrees`.
 */
const LINK_ROOTS: ReadonlySet<RootName> = new Set(['fleet', 'agent-homes']);

/** Whether `linkTo` may write a link into this root. */
export function takesLinks(name: RootName): boolean {
  return LINK_ROOTS.has(name);
}

/**
 * The roots an entry may be MOVED inside (`RootHandle.rename`): the same internal, writable, kernel-made roots a link
 * may be written into, and no other. Never an owner's root, never a read-only one.
 */
const RENAME_ROOTS: ReadonlySet<RootName> = new Set(['fleet', 'agent-homes']);

/** Whether `rename` may move an entry inside this root. */
export function takesRenames(name: RootName): boolean {
  return RENAME_ROOTS.has(name);
}

/**
 * The refusal `rename` gives before any disk is asked, from the two names alone: `undefined` when both are sane. A
 * name is a string without NUL whose segments (after the one leading `/` of an absolute path) are all plain: no
 * `..`, no `.` and none empty (`a//b`, a trailing `/`), so both hosts read the same name the same way. The same name
 * at both ends moves nothing and is refused (`outside`) rather than reported as done.
 */
export function renameNamesRefusal(from: string, to: string): 'outside' | undefined {
  for (const name of [from, to]) {
    if (typeof name !== 'string' || name === '' || name.includes('\0')) return 'outside';
    const segments = name.split('/');
    if (name.startsWith('/')) segments.shift();
    if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return 'outside';
  }
  return from === to ? 'outside' : undefined;
}

/**
 * The bits `setMode` sets, or `undefined` for a mode that is refused (not an integer in `0..0o7777`). An internal root
 * keeps `mode & 0o700`: no group or other bit, ever. Any other writable root keeps `mode & 0o777`. Neither ever sets
 * setuid, setgid or sticky. Whether the root is writable at all is the caller's question (refused before this).
 */
export function permittedMode(internal: boolean, mode: number): number | undefined {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) return undefined;
  return mode & (internal ? 0o700 : 0o777);
}

/** One plain file name: never `.` or `..`, never a pattern, a path or NUL. `'*'` is not one, so it matches nothing. */
const PLAIN_FILE_NAME = /^(?!\.{1,2}$)[A-Za-z0-9._+-]{1,255}$/u;

/** Why `harnessFile` refused, before any disk is asked. */
export type HarnessFileRefusal = 'not_declared' | 'outside' | 'fenced';

export interface HarnessFileAsk {
  readonly plugin: string;
  /** Whether this plugin may hold `harness-home` at all (`mayHoldRoot`: Runtimes alone). */
  readonly mayHold: boolean;
  /** The manifest's `permissions.roots`. */
  readonly roots: readonly RootName[];
  /** The manifest's `permissions.harnessFiles`. */
  readonly names: readonly string[] | undefined;
  /** The kernel's home: the fence the file must be outside of. */
  readonly home: string;
  readonly absolutePath: string;
}

/**
 * The lexical half of `harnessFile`: the plugin may hold `harness-home` and declared it; the basename is one the
 * manifest lists, exactly, as a plain name; the path is absolute, normalized (no `.`/`..` segment, no doubled or
 * trailing slash), has a folder, carries no NUL, and is outside the fence by name. The real host then judges the folder
 * by identity and the file by descriptor.
 */
export function harnessFileRefusal(ask: HarnessFileAsk): HarnessFileRefusal | undefined {
  if (!ask.mayHold || !ask.roots.includes('harness-home')) return 'not_declared';
  const path = ask.absolutePath;
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0')) return 'outside';
  if (posix.normalize(path) !== path || path.endsWith('/')) return 'outside';
  const leaf = posix.basename(path);
  if (posix.dirname(path) === path || !PLAIN_FILE_NAME.test(leaf)) return 'outside';
  const declared = (ask.names ?? []).filter(name => PLAIN_FILE_NAME.test(name));
  if (!declared.includes(leaf)) return 'not_declared';
  if (insideFence(ask.home, path)) return 'fenced';
  return undefined;
}
