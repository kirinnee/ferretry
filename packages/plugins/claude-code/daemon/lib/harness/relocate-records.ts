/**
 * Moving one Claude Code conversation to another folder (and another machine) is a rewrite of its records, which this
 * file does. Pure: no disk, no clock.
 *
 * Every record is in one of four kinds:
 *   - a **worktree binding** (`worktree-state`) is DROPPED: it names the checkout a `claude --worktree` session was entered
 *     from, and that checkout is not on the machine moved to. Pointing it at the new folder itself is no answer: the real
 *     Claude Code 2.1.327 refuses to resume into a worktree that is the checkout it launched from, and pointing it at a
 *     guess leaves a binding to a folder nobody checked. Without it the conversation continues as an ordinary one in the
 *     new folder, which Claude resumes (measured);
 *   - **turn** records hold what was said (`user`, `assistant`, the prompt queue): only the keys that name a folder
 *     (`cwd` and the worktree's own) and the conversation's own id move, so a path a person typed or a tool printed is left
 *     as it was written;
 *   - **context** records are Claude's own account of where it ran (`worktree-state`, `attachment`, `system`, and the
 *     `api-request*` records that hold the system prompt it sent): a folder of the source in them moves wherever it is
 *     written, as a key, as a path inside a sentence, and as Claude's dashed spelling of it in a project folder name;
 *   - **any other record type** is not understood, so it must carry no folder of the source at all: one that does makes the
 *     whole move refuse rather than leave the source's paths behind.
 */

export type Json = Record<string, unknown>;

/** The keys a record uses for a folder of the work tree, at any depth. */
const FOLDER_KEYS = new Set(['cwd', 'originalCwd', 'preEnterOriginalCwd', 'worktreePath', 'workingDirectory']);
/** The keys that name the checkout a worktree was entered from, besides the worktree itself. */
const SOURCE_KEYS = new Set(['originalCwd', 'preEnterOriginalCwd', 'worktreePath']);
/** The keys a record uses for the conversation's own id, at any depth. A `forkedFrom` id names ANOTHER conversation and is kept. */
const SELF_ID_KEYS = new Set(['sessionId', 'session_id']);
const TURN_TYPES = new Set(['user', 'assistant', 'queue-operation', 'last-prompt']);
const CONTEXT_TYPES = new Set(['attachment', 'system', 'api-request-shape', 'api-request-blob', 'api-request']);

const asObject = (value: unknown): Json | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
const escaped = (text: string): string => text.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
/** Claude's dashed spelling of a folder (`/a/b.c` is `-a-b-c`), shortened with a hash when long. */
type Spell = (folder: string) => string;

export interface MovePlan {
  /** Every folder of the source the conversation worked in or was entered from, longest first. */
  readonly from: readonly string[];
  /** The folder the conversation moves into. */
  readonly to: string;
  /** The ferret's home on this machine, where its `projects` folder is. */
  readonly home: string;
  readonly oldId: string;
  readonly newId: string;
  readonly spell: Spell;
}

/** `value` moved out of the source folders into `to`, or `undefined` when it is inside none of them (a folder elsewhere is kept). */
function movedFolder(value: string, plan: MovePlan): string | undefined {
  for (const root of plan.from) {
    if (value === root) return plan.to;
    if (value.startsWith(`${root}/`)) return `${plan.to}${value.slice(root.length)}`;
  }
  return undefined;
}

/** The patterns that find a source folder inside a sentence, built once per plan. */
function finders(plan: MovePlan): {
  readonly path: RegExp;
  readonly dashed: RegExp;
  readonly home: RegExp;
  readonly any: RegExp;
} {
  const spellings = [...new Set(plan.from.map(plan.spell))].sort((a, b) => b.length - a.length);
  // No folder of the source known: nothing is a folder of it.
  const never = '(?!)';
  const paths = plan.from.length === 0 ? never : plan.from.map(escaped).join('|');
  const dashes = spellings.length === 0 ? never : spellings.map(escaped).join('|');
  return {
    // A folder is found where it is a whole path (not the head of `app-two` when the source was `app`).
    path: new RegExp(`(?<![A-Za-z0-9_.-])(?:${paths})(?![A-Za-z0-9_.-])`, 'gu'),
    dashed: new RegExp(`(?<![A-Za-z0-9-])(?:${dashes})(?![A-Za-z0-9-])`, 'gu'),
    any: new RegExp(
      `(?<![A-Za-z0-9_.-])(?:${paths})(?![A-Za-z0-9_.-])|(?<![A-Za-z0-9-])(?:${dashes})(?![A-Za-z0-9-])`,
      'u',
    ),
    // The source machine's own config folder, as Claude names its memory folder: `<config>/projects/<dashed folder>`.
    home: new RegExp(`(?:/[A-Za-z0-9._@+~-]+)+/projects/(?=(?:${dashes})(?![A-Za-z0-9-]))`, 'gu'),
  };
}

type Finders = ReturnType<typeof finders>;

function movedText(text: string, plan: MovePlan, find: Finders): string {
  return text
    .replaceAll(find.home, `${plan.home}/projects/`)
    .replaceAll(find.path, plan.to)
    .replaceAll(find.dashed, plan.spell(plan.to));
}

/** Rewrites in place, at any depth; true when something changed. `text` also moves a folder written inside a sentence. */
function rewrite(value: unknown, plan: MovePlan, find: Finders, text: boolean): boolean {
  let changed = false;
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      if (typeof item === 'string') {
        const next = text ? movedText(item, plan, find) : item;
        if (next !== item) {
          value[index] = next;
          changed = true;
        }
      } else changed = rewrite(item, plan, find, text) || changed;
    });
    return changed;
  }
  const object = asObject(value);
  if (object === undefined) return false;
  for (const [key, inner] of Object.entries(object)) {
    if (typeof inner !== 'string') {
      changed = rewrite(inner, plan, find, text) || changed;
      continue;
    }
    let next: string | undefined;
    if (FOLDER_KEYS.has(key)) next = movedFolder(inner, plan) ?? (text ? movedText(inner, plan, find) : undefined);
    else if (SELF_ID_KEYS.has(key) && inner === plan.oldId && plan.newId !== plan.oldId) next = plan.newId;
    else if (text) next = movedText(inner, plan, find);
    if (next !== undefined && next !== inner) {
      object[key] = next;
      changed = true;
    }
  }
  return changed;
}

/** The folders of the source: the one the transcript was filed under, and every checkout a worktree record says it was entered from. */
export function sourceFolders(records: readonly Json[], primary: string | undefined): readonly string[] {
  const found = new Set<string>(primary === undefined ? [] : [primary]);
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) return void value.forEach(walk);
    const object = asObject(value);
    if (object === undefined) return;
    for (const [key, inner] of Object.entries(object)) {
      if (typeof inner === 'string' && SOURCE_KEYS.has(key)) found.add(inner);
      else walk(inner);
    }
  };
  for (const record of records) walk(record);
  return [...found]
    .map(folder => folder.replace(/\/+$/u, ''))
    .filter(folder => folder.startsWith('/') && folder.length > 1)
    .sort((a, b) => b.length - a.length);
}

/**
 * Whether Claude could resume this: at least one real user or assistant turn. A file of metadata alone (a worktree
 * record, a queued prompt that never ran) is found by `--resume` and then refused ("No conversation found").
 */
export function hasRealTurn(records: readonly Json[]): boolean {
  return records.some(
    record =>
      (record.type === 'user' || record.type === 'assistant') &&
      asObject(record.message) !== undefined &&
      record.isMeta !== true,
  );
}

export type Moved =
  | { readonly record: Json; readonly changed: boolean }
  | { readonly drop: true }
  | { readonly refusal: string };

/** Moves one record at a time (a copy each; the argument is untouched), or says in one plain sentence why a record cannot be moved. */
export function recordMover(plan: MovePlan): (record: Json) => Moved {
  const find = finders(plan);
  return record => {
    if (record.type === 'worktree-state') return { drop: true };
    const copy = JSON.parse(JSON.stringify(record)) as Json;
    const type = typeof copy.type === 'string' ? copy.type : '';
    const changed = rewrite(copy, plan, find, CONTEXT_TYPES.has(type));
    if (!TURN_TYPES.has(type) && find.any.test(JSON.stringify(copy)))
      return {
        refusal: `a "${type || 'typeless'}" record of this conversation carries a folder of the machine it came from, and this move does not know where else that folder is written`,
      };
    return { record: copy, changed };
  };
}
