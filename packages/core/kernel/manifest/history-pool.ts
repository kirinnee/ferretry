/**
 * The pure rules of the history-pool door (`RootHandle.linkHistory`): what a manifest's `permissions.historyPool` may
 * declare, and which entry names a harness home may ever be linked to the pool under. One fact, read by the real roots
 * port (`../host/roots.ts`), the testing host and the build/boot reach check (`./reach.ts`), so a plugin's unit test
 * meets exactly the refusals production makes.
 *
 * A pooled entry is a HISTORY entry (a transcript folder, a todo folder, `history.jsonl`) and nothing else. The deny
 * list below is fixed in the kernel and holds whatever a manifest declares: a sign-in, a settings file, an instruction
 * file, a skill or plugin folder and every hidden name can never be pooled, so no manifest can use this door to share a
 * credential or to reach another ferret's configuration.
 */
import type { StateFileDef } from '../contract/define.ts';
import { isInternalRootFolder } from '../contract/internal-roots.ts';
import type { HistoryPoolEntryDecl, HistoryPoolPermission } from './types.ts';

/** The longest entry name the door accepts (a file name on every supported filesystem). */
const MAX_ENTRY_NAME = 255;

/** One plain entry name: a letter, digit or `_` first (never `.`: no hidden name), then letters, digits and `._-`. */
const ENTRY_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/u;

/**
 * Names that are never pooled, compared case-insensitively (macOS folds case, so `Skills` and `AUTH.JSON` must not slip
 * past): the sign-in and settings files of the two harnesses, their instruction files, and the folders that carry code
 * or configuration. A name that STARTS with `.` is refused by shape, so `.credentials.json` and `.claude.json` are on
 * this list for the reader as much as for the check.
 */
export const HISTORY_POOL_DENIED_NAMES: readonly string[] = [
  '.credentials.json',
  '.claude.json',
  'auth.json',
  'config.toml',
  'claude.md',
  'agents.md',
  'skills',
  'plugins',
];

/** `settings.json`, `settings.local.json`, `settings-anything.json`: any settings file, in any case. */
const SETTINGS_FILE = /^settings.*\.json$/iu;

/** A name that says it is a credential, whatever else it is: refused as defence in depth beside the fixed list. */
const SECRET_LOOKING = /credential|secret|token|oauth|passw/iu;

/** Why `name` can never be a pooled entry, or `undefined` when it may be declared. One sentence, no path in it. */
export function historyPoolNameRefusal(name: unknown): string | undefined {
  if (typeof name !== 'string' || name === '') return 'an entry is a non-empty string';
  if (name.includes('\0')) return 'an entry name has no NUL';
  if (name.includes('/') || name.includes('\\')) return 'an entry name is one segment, never a path';
  if (name === '.' || name === '..') return 'an entry name is never "." or ".."';
  if (name.startsWith('.')) return 'an entry name never starts with "." (no hidden name)';
  if (name.length > MAX_ENTRY_NAME || !ENTRY_NAME.test(name)) return 'an entry name is plain letters, digits and "._-"';
  const folded = name.toLowerCase();
  if (HISTORY_POOL_DENIED_NAMES.includes(folded) || SETTINGS_FILE.test(name))
    return 'an entry name is never a sign-in, settings or instruction file, a skill or a plugin folder';
  if (SECRET_LOOKING.test(name)) return 'an entry name never looks like a credential';
  return undefined;
}

/** Why `permission` is not a legal declaration against the plugin's own state files, or `undefined` when it is. */
export function historyPoolFault(
  permission: HistoryPoolPermission | undefined,
  states: readonly StateFileDef[],
): string | undefined {
  if (permission === undefined) return undefined;
  if (typeof permission !== 'object' || permission === null) return 'permissions.historyPool is an object';
  const named =
    typeof permission.state === 'string' ? states.find(state => state.name === permission.state) : undefined;
  const top = named?.path.split('/')[0] ?? '';
  if (named !== undefined && isInternalRootFolder(top))
    return `permissions.historyPool.state '${permission.state}' lives in '${top}', a root the kernel makes (never a pool)`;
  if (poolStateFolder(permission, states) === undefined)
    return `permissions.historyPool.state names no opaque "<folder>/*" state tree of its own (found '${String(permission.state)}')`;
  if (!Array.isArray(permission.entries) || permission.entries.length === 0)
    return 'permissions.historyPool.entries lists at least one entry';
  const seen = new Set<string>();
  for (const decl of permission.entries as readonly HistoryPoolEntryDecl[]) {
    if (typeof decl !== 'object' || decl === null) return 'a historyPool entry is { name, kind }';
    const refusal = historyPoolNameRefusal(decl.name);
    if (refusal !== undefined) return `historyPool entry '${String(decl.name)}': ${refusal}`;
    if (decl.kind !== 'folder' && decl.kind !== 'file')
      return `historyPool entry '${decl.name}': kind is 'folder' or 'file'`;
    const folded = decl.name.toLowerCase();
    if (seen.has(folded)) return `historyPool entry '${decl.name}' is listed twice`;
    seen.add(folded);
  }
  return undefined;
}

/**
 * The state folder the pool lives in, relative to the plugin's state folder (`history-pool`), or `undefined` when
 * `permission.state` is not the name of one of the plugin's OWN opaque `<one plain folder>/*` trees. One segment, plain,
 * never hidden: the pool is `state/<plugin>/<that folder>` and nothing deeper or shallower.
 */
export function poolStateFolder(
  permission: HistoryPoolPermission,
  states: readonly StateFileDef[],
): string | undefined {
  const def = typeof permission.state === 'string' ? states.find(state => state.name === permission.state) : undefined;
  if (def === undefined || def.store !== 'opaque' || !def.path.endsWith('/*')) return undefined;
  const folder = def.path.slice(0, -2);
  // A kernel-made root's folder (`agent-homes`, `credentials`, `sessions`, `downloads`, any case) is never a pool.
  return ENTRY_NAME.test(folder) && !folder.startsWith('.') && !isInternalRootFolder(folder) ? folder : undefined;
}

/**
 * The declared entry called `name`, exactly (case-sensitive), when the manifest lists it AND the fixed rules allow it; a
 * listed name the rules refuse is treated as not listed, so a bad declaration never widens what the door will link.
 */
export function declaredHistoryEntry(
  permission: HistoryPoolPermission | undefined,
  name: string,
): HistoryPoolEntryDecl | undefined {
  if (permission === undefined || !Array.isArray(permission.entries)) return undefined;
  if (historyPoolNameRefusal(name) !== undefined) return undefined;
  return permission.entries.find(decl => decl.name === name && (decl.kind === 'folder' || decl.kind === 'file'));
}
