/**
 * Where the pending lists live. Each owner keeps its own `ports-pending.json`, so parallel units stop colliding on one
 * root file. THE RULE (one name, two places):
 *
 * - `packages/core/<id>/ports-pending.json` or `packages/plugins/<id>/ports-pending.json` holds only plugin `<id>`'s
 *   lines: its `pending` entry, `pendingReasons.<id>`, `pendingHalves.<id>`, `pendingAppPorts` of `<id>`, and the
 *   `unwired` seams that name a file inside that package (`code:packages/.../<id>/...`).
 * - the root `ports-pending.json` keeps only `unwired` seams that belong to no single package (hooks, ports).
 *
 * Readers merge every file into the one document the old root file was, so a reader never learns where a line lives.
 * A line named twice, in one file or across two, is an error; the `ports-pending` check also enforces the rule.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PENDING_FILE = 'ports-pending.json';

/** A package-owned file: `packages/<core|plugins>/<id>/ports-pending.json`. Group 1 is the owner id. */
export const OWNED_FILE = /^packages\/(?:core|plugins)\/([^/]+)\/ports-pending\.json$/u;

export interface PendingText {
  readonly where: string;
  readonly text: string;
}

const KEYS = ['pending', 'pendingReasons', 'pendingHalves', 'pendingAppPorts', 'unwired'] as const;

/** Every `ports-pending.json` under `root`, root-relative, sorted; skips dot directories and `node_modules`. */
export function pendingFilePaths(root: string): string[] {
  const found: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const next = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(next);
      else if (entry.name === PENDING_FILE) found.push(next);
    }
  };
  walk('');
  return found.sort();
}

export function readPendingTexts(root: string): PendingText[] {
  return pendingFilePaths(root).map(where => ({ where, text: readFileSync(join(root, where), 'utf8') }));
}

/** A ref's committed pending files. Throws when git cannot list the ref; `[]` when the ref holds none. */
export function readPendingTextsAt(root: string, ref: string): PendingText[] {
  const listed = spawnSync('git', ['ls-tree', '-r', '--name-only', ref], { cwd: root, encoding: 'utf8' });
  if (listed.status !== 0) throw new Error(`git cannot list ${ref}`);
  const paths = listed.stdout.split('\n').filter(p => p === PENDING_FILE || OWNED_FILE.test(p));
  return paths.map(where => {
    const shown = spawnSync('git', ['show', `${ref}:${where}`], { cwd: root, encoding: 'utf8' });
    if (shown.status !== 0) throw new Error(`git cannot read ${ref}:${where}`);
    return { where: `${ref}:${where}`, text: shown.stdout };
  });
}

/** The old single-file document, from every file. `undefined` when there is no file at all. */
export function mergePendingTexts(files: readonly PendingText[]): string | undefined {
  if (files.length === 0) return undefined;
  const pending: unknown[] = [];
  const reasons: Record<string, unknown> = {};
  const halves: Record<string, unknown> = {};
  const appPorts: unknown[] = [];
  const unwired: unknown[] = [];
  const seen = new Set<string>();
  let hasUnwired = false;
  const formats = new Set<unknown>();
  const once = (key: string, where: string): void => {
    if (seen.has(key))
      throw new Error(`${where}: ${key} is listed twice (in this file or in another ports-pending.json)`);
    seen.add(key);
  };
  for (const { where, text } of files) {
    const doc = JSON.parse(text) as Record<string, unknown>;
    formats.add(doc.format); // the readers name a format that is not 1; files must only agree
    for (const key of Object.keys(doc))
      if (key !== 'format' && !(KEYS as readonly string[]).includes(key))
        throw new Error(`${where}: unknown key "${key}"`);
    if (Array.isArray(doc.pending))
      for (const id of doc.pending) {
        if (typeof id === 'string') once(`pending ${id}`, where);
        pending.push(id);
      }
    else if (doc.pending !== undefined) throw new Error(`${where}: "pending" is not a list of ids`);
    for (const [target, name] of [
      [reasons, 'pendingReasons'],
      [halves, 'pendingHalves'],
    ] as const) {
      const given = doc[name];
      if (given === undefined) continue;
      if (typeof given !== 'object' || given === null || Array.isArray(given))
        throw new Error(`${where}: "${name}" is not an object of plugin id to lists`);
      for (const [id, list] of Object.entries(given)) {
        once(`${name}.${id}`, where);
        target[id] = list;
      }
    }
    if (Array.isArray(doc.pendingAppPorts)) appPorts.push(...doc.pendingAppPorts);
    else if (doc.pendingAppPorts !== undefined) throw new Error(`${where}: "pendingAppPorts" must be a list`);
    if (Array.isArray(doc.unwired)) {
      hasUnwired = true;
      unwired.push(...doc.unwired);
    } else if (doc.unwired !== undefined) throw new Error(`${where}: "unwired" is not a list`);
  }
  if (formats.size > 1) throw new Error('the ports-pending.json files disagree on "format"');
  return JSON.stringify({
    format: [...formats][0],
    pending,
    pendingReasons: reasons,
    pendingHalves: halves,
    pendingAppPorts: appPorts,
    ...(hasUnwired ? { unwired } : {}),
  });
}

/** The merged document of a working tree, or `undefined` when it has no pending file. */
export function readPendingMerged(root: string): string | undefined {
  return mergePendingTexts(readPendingTexts(root));
}

/** A base spelling: `file:<path>` (one file, or a directory read like a tree) or a git ref. */
export function readPendingMergedBase(root: string, ref: string): string | undefined {
  if (!ref.startsWith('file:')) return mergePendingTexts(readPendingTextsAt(root, ref));
  const target = ref.slice(5);
  if (!existsSync(target)) return undefined;
  if (readdirSafe(target)) return readPendingMerged(target);
  return mergePendingTexts([{ where: target, text: readFileSync(target, 'utf8') }]);
}

function readdirSafe(path: string): boolean {
  try {
    readdirSync(path);
    return true;
  } catch {
    return false;
  }
}
