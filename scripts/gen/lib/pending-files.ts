/**
 * Where the pending ledger lives: ONE FILE PER OPEN LINE, so closing a line is `git rm <file>` and two branches that
 * close neighbouring lines never touch the same text (a list in one file conflicts on adjacent deleted lines, on a
 * move-to-done and on a strike-through; one file per item does not). THE RULE (one name, two places):
 *
 * - `packages/core/<id>/ports-pending/` or `packages/plugins/<id>/ports-pending/` holds only plugin `<id>`'s lines:
 *   - `<slug>.txt`: one open gap. The body is the line text (its `[scope]` tag and sentence) and one trailing newline.
 *     Closing the gap is `git rm` of the file; adding one is a new file. No index names it.
 *   - `halves/<half>.txt`: the half (`daemon`, `app`, `cli`) is still a skeleton. The body is ignored (empty is fine).
 *   - `unwired/<slug>.json`: one `unwired` seam `{ seam, card, why }` that names a file inside that package.
 *   - `app-ports/<slug>.json`: one pending app port `{ plugin, path, reason }`.
 * - the root `ports-pending/unwired/<slug>.json` keeps only `unwired` seams that belong to no single package.
 *
 * A plugin is PENDING while it holds at least one gap file: there is no `pending` list to edit, so the last line closed is
 * the plugin leaving. `slug` is lowercase letters, digits and `-`; a gap's slug is its GAP(...) tag plus two or three
 * words of the text, and is the name an `@pending <id>/<slug>` code tag uses.
 *
 * Readers get the document the old single `ports-pending.json` was (`readPendingMerged`), so none of them learns where a
 * line lives. A base ref that still holds the old `ports-pending.json` files is read too (the transition only).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The folder every owner keeps its lines in (and the root keeps its repo-wide seams in). */
export const PENDING_DIR = 'ports-pending';

/** The name the readers say in a message: the ledger as a whole. */
export const PENDING_FILE = `${PENDING_DIR}/`;

/** The retired single-file spelling; a base ref may still hold it, a working tree may not. */
export const LEGACY_FILE = 'ports-pending.json';

/** A package-owned ledger file: `packages/<core|plugins>/<id>/ports-pending/<rest>`. Group 1 is the owner id, 2 the rest. */
export const OWNED_FILE = /^packages\/(?:core|plugins)\/([^/]+)\/ports-pending\/(.+)$/u;

/** A root ledger file: `ports-pending/<rest>`. Group 1 is the rest. */
export const ROOT_FILE = /^ports-pending\/(.+)$/u;

export const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/u;

export type PendingKind = 'gap' | 'half' | 'unwired' | 'app-port';

export interface PendingEntry {
  /** Root-relative path (or `<ref>:<path>` for a base ref). */
  readonly where: string;
  /** The owner id; `undefined` for the root. */
  readonly owner: string | undefined;
  readonly kind: PendingKind;
  /** The file name without its extension (a half's name for a `half`). */
  readonly slug: string;
  /** A gap's line; the JSON text of an `unwired` or `app-port` entry; empty for a half. */
  readonly text: string;
  /** Why the file is not a valid entry, or undefined. */
  readonly problem?: string;
}

/**
 * The only directories the working-tree walk does not enter, each by exact name: `.git` (VCS metadata), `node_modules`
 * (installed dependencies), `.worktrees` (other checkouts of this repo, each with its own copies) and `.direnv` (the
 * nix shell cache). Every other directory, dot directories included, is searched: a pending file the rule does not
 * allow must be found to be rejected, not skipped.
 */
export const NOT_SEARCHED = ['.git', 'node_modules', '.worktrees', '.direnv'] as const;

/**
 * The one folder skipped by its path from the root, not its name: the fixture workspaces `scripts/gen/tests` build (each
 * has a `packages/plugins/alpha/ports-pending/` of its own). It is git-ignored and owned by those tests, which run in
 * the same job as the checks that scan the real tree, so a scan that met a fixture still alive read a pending list that was
 * not the repo's and failed with "listed twice". A fixture's own scan has its folder as root, so it never meets this path.
 */
export const NOT_SEARCHED_PATHS = ['scripts/gen/tests/.tmp'] as const;

const isLedgerFile = (rel: string): boolean =>
  rel.split('/').includes(PENDING_DIR) || rel === LEGACY_FILE || rel.endsWith(`/${LEGACY_FILE}`);

/** Every ledger file under `root` (every file below a `ports-pending/` folder, and any `ports-pending.json`), sorted. */
export function pendingFilePaths(root: string): string[] {
  const found: string[] = [];
  const walk = (rel: string, inside: boolean): void => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      if ((NOT_SEARCHED as readonly string[]).includes(entry.name)) continue;
      const next = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if ((NOT_SEARCHED_PATHS as readonly string[]).includes(next)) continue;
      if (entry.isDirectory()) walk(next, inside || entry.name === PENDING_DIR);
      else if (inside || entry.name === LEGACY_FILE) found.push(next);
    }
  };
  walk('', false);
  return found.sort();
}

/** What one ledger path is: its owner, kind and slug, or why it is not a ledger file at all. */
export function classify(rel: string): Omit<PendingEntry, 'where' | 'text'> {
  const owned = OWNED_FILE.exec(rel);
  const root = owned === null ? ROOT_FILE.exec(rel) : null;
  const owner = owned?.[1];
  const rest = owned?.[2] ?? root?.[1];
  const bad = (problem: string): Omit<PendingEntry, 'where' | 'text'> => ({
    owner,
    kind: 'gap',
    slug: rest ?? rel,
    problem,
  });
  if (rest === undefined)
    return bad(
      'is outside the rule: a ledger file is packages/<core|plugins>/<id>/ports-pending/<slug>.txt (or halves/, unwired/, app-ports/ inside it), or the root ports-pending/unwired/<slug>.json',
    );
  const parts = rest.split('/');
  const file = parts[parts.length - 1] ?? '';
  const base = file.replace(/\.[^.]+$/u, '');
  const ext = file.slice(base.length);
  if (parts.length === 1) {
    if (owner === undefined) return bad('the root ports-pending/ keeps only unwired/<slug>.json seams');
    if (ext !== '.txt') return bad('a gap file is <slug>.txt');
    return SLUG.test(base) ? { owner, kind: 'gap', slug: base } : bad(`"${base}" is not a slug (a-z, 0-9, "-")`);
  }
  const folder = parts[0];
  if (parts.length === 2 && folder === 'halves' && owner !== undefined)
    return ext === '.txt' && ['daemon', 'app', 'cli'].includes(base)
      ? { owner, kind: 'half', slug: base }
      : bad('a half file is halves/daemon.txt, halves/app.txt or halves/cli.txt');
  if (parts.length === 2 && folder === 'unwired')
    return ext === '.json' && SLUG.test(base)
      ? { owner, kind: 'unwired', slug: base }
      : bad('an unwired seam is unwired/<slug>.json');
  if (parts.length === 2 && folder === 'app-ports' && owner !== undefined)
    return ext === '.json' && SLUG.test(base)
      ? { owner, kind: 'app-port', slug: base }
      : bad('a pending app port is app-ports/<slug>.json');
  return bad('is outside the rule: no such folder in a ports-pending/ ledger');
}

/** The line a gap file holds: the body without its one trailing newline. */
export function gapLine(body: string): string {
  return body.endsWith('\n') ? body.slice(0, -1) : body;
}

function entryOf(where: string, rel: string, body: string): PendingEntry {
  if (rel === LEGACY_FILE || rel.endsWith(`/${LEGACY_FILE}`))
    return {
      where,
      owner: undefined,
      kind: 'gap',
      slug: rel,
      text: body,
      problem: `is the retired single ${LEGACY_FILE}: one file per open line under ports-pending/ now`,
    };
  const base = classify(rel);
  if (base.problem !== undefined) return { ...base, where, text: body };
  if (base.kind === 'gap') {
    const line = gapLine(body);
    const problem =
      line.trim() === ''
        ? 'is empty: a gap file holds its line'
        : line.includes('\n')
          ? 'holds more than one line: one gap per file'
          : line !== line.trim()
            ? 'has leading or trailing spaces'
            : undefined;
    return { ...base, where, text: line, ...(problem === undefined ? {} : { problem }) };
  }
  if (base.kind === 'half') return { ...base, where, text: '' };
  try {
    const value: unknown = JSON.parse(body);
    if (value === null || typeof value !== 'object' || Array.isArray(value))
      return { ...base, where, text: body, problem: 'is not a JSON object' };
  } catch (error) {
    return {
      ...base,
      where,
      text: body,
      problem: `is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return { ...base, where, text: body };
}

/** Every entry of a working tree, sorted by path. */
export function readPendingEntries(root: string): PendingEntry[] {
  return pendingFilePaths(root).map(rel => entryOf(rel, rel, readFileSync(join(root, rel), 'utf8')));
}

/**
 * The entries a git ref commits, plus the retired single files as entries of the old kinds (so a base that predates the
 * folder layout still answers). Throws when git cannot list the ref.
 */
export function readPendingEntriesAt(root: string, ref: string): PendingEntry[] {
  const listed = spawnSync('git', ['ls-tree', '-r', '--name-only', ref], { cwd: root, encoding: 'utf8' });
  if (listed.status !== 0) throw new Error(`git cannot list ${ref}`);
  const entries: PendingEntry[] = [];
  const legacy: { where: string; text: string }[] = [];
  for (const rel of listed.stdout.split('\n').filter(p => p !== '' && isLedgerFile(p))) {
    const shown = spawnSync('git', ['show', `${ref}:${rel}`], { cwd: root, encoding: 'utf8' });
    if (shown.status !== 0) throw new Error(`git cannot read ${ref}:${rel}`);
    if (rel === LEGACY_FILE || rel.endsWith(`/${LEGACY_FILE}`))
      legacy.push({ where: `${ref}:${rel}`, text: shown.stdout });
    else entries.push(entryOf(`${ref}:${rel}`, rel, shown.stdout));
  }
  for (const file of legacy) entries.push(...legacyEntries(file.where, file.text));
  return entries;
}

/** An old-layout `ports-pending.json` as entries; its `pending` ids are kept as synthetic `pending` gap-less owners. */
function legacyEntries(where: string, text: string): PendingEntry[] {
  const doc = JSON.parse(text) as Record<string, unknown>;
  const out: PendingEntry[] = [];
  const owned = OWNED_FILE.exec(where.slice(where.indexOf(':') + 1).replace(LEGACY_FILE, `${PENDING_DIR}/x`));
  const fileOwner = owned?.[1];
  const reasons = (doc.pendingReasons ?? {}) as Record<string, string[]>;
  for (const [id, lines] of Object.entries(reasons))
    lines.forEach((line, at) => out.push({ where, owner: id, kind: 'gap', slug: `legacy-${at + 1}`, text: line }));
  const halves = (doc.pendingHalves ?? {}) as Record<string, string[]>;
  for (const [id, list] of Object.entries(halves))
    for (const half of list) out.push({ where, owner: id, kind: 'half', slug: half, text: '' });
  for (const seam of (doc.unwired ?? []) as { seam?: string }[])
    out.push({ where, owner: fileOwner, kind: 'unwired', slug: String(seam.seam ?? ''), text: JSON.stringify(seam) });
  for (const port of (doc.pendingAppPorts ?? []) as { plugin?: string }[])
    out.push({
      where,
      owner: port.plugin,
      kind: 'app-port',
      slug: String(port.plugin ?? ''),
      text: JSON.stringify(port),
    });
  for (const id of (doc.pending ?? []) as string[])
    out.push({ where, owner: id, kind: 'gap', slug: '(pending)', text: '', problem: 'pending-marker' });
  return out;
}

/**
 * The one document the old single file was, from entries: `pending` is every owner with a gap (or, from an old base, its
 * explicit list), `pendingReasons` the gap lines (sorted by slug), `pendingHalves` the skeleton halves.
 */
export function mergeEntries(entries: readonly PendingEntry[]): string {
  const pending = new Set<string>();
  const reasons = new Map<string, string[]>();
  const slugs = new Map<string, string[]>();
  const halves = new Map<string, string[]>();
  const appPorts: unknown[] = [];
  const unwired: unknown[] = [];
  for (const entry of [...entries].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))) {
    if (entry.problem === 'pending-marker') {
      if (entry.owner !== undefined) pending.add(entry.owner);
      continue;
    }
    if (entry.problem !== undefined) throw new Error(`${entry.where}: ${entry.problem}`);
    const owner = entry.owner;
    if (entry.kind === 'gap' && owner !== undefined) {
      pending.add(owner);
      reasons.set(owner, [...(reasons.get(owner) ?? []), entry.text]);
      slugs.set(owner, [...(slugs.get(owner) ?? []), entry.slug]);
    } else if (entry.kind === 'half' && owner !== undefined)
      halves.set(owner, [...(halves.get(owner) ?? []), entry.slug]);
    else if (entry.kind === 'unwired') unwired.push(JSON.parse(entry.text));
    else if (entry.kind === 'app-port') appPorts.push(JSON.parse(entry.text));
  }
  return JSON.stringify({
    format: 1,
    pending: [...pending],
    pendingReasons: Object.fromEntries(reasons),
    pendingSlugs: Object.fromEntries(slugs),
    pendingHalves: Object.fromEntries(halves),
    pendingAppPorts: appPorts,
    unwired,
  });
}

/** The merged document of a working tree: an empty ledger (the end state) is a document with nothing in it. */
export function readPendingMerged(root: string): string {
  return mergeEntries(readPendingEntries(root));
}

/**
 * A base spelling: `file:<path>` (a directory read like a tree, or one old-layout file; `undefined` when the path is
 * not there) or a git ref (throws when git cannot list it; a ref that holds no ledger file is an EMPTY ledger, the end
 * state, so it still compares).
 */
export function readPendingMergedBase(root: string, ref: string): string | undefined {
  if (!ref.startsWith('file:')) return mergeEntries(readPendingEntriesAt(root, ref));
  const target = ref.slice(5);
  if (!existsSync(target)) return undefined;
  // A single file is an old-layout document (a test's, or a release compare's); a directory is read like a tree.
  return statSync(target).isDirectory()
    ? readPendingMerged(target)
    : mergeEntries(legacyEntries(target, readFileSync(target, 'utf8')));
}
