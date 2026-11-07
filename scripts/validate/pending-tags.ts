/**
 * `pending-tags`: the two ways the dead-code gates (`knip.json`, `knip.production.json`) are told to keep something
 * stay honest.
 *
 * - `@pending <owner>: <gap>` keeps ported code that waits for its wire. `<owner>` is the package's own subsystem id,
 *   that id is still listed in `ports-pending.json` `pending`, and `<gap>` is text of one of its `pendingReasons`
 *   lines (compared without case or repeated spaces). When the port lands and the id leaves `pending`, every tag left
 *   in the package is a finding, so the marker can never become a quiet way to keep dead code.
 * - A whole file kept the same way sits in its workspace's `ignore` in a knip config: the workspace's subsystem must be
 *   pending and one of its `pendingReasons` lines must name the path.
 * - `@public <why>` keeps a real use knip cannot see. `<why>` names a kept (or split) row of
 *   `docs/rebuild/guarantees.tsv` by id, or `surface <name>` where `<name>` is written in the package's manifest.
 *
 * Tags are read from comments only, in every source file of every workspace package (tests included). The app shell,
 * the CLI and std have no subsystem id: their `@public` reasons and knip ignores are left to review.
 */
import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { type Check, type Finding, runMain } from '../gen/lib/check.ts';
import { loadWorkspace, sourceFiles } from '../gen/lib/workspace.ts';
import { readRows } from './guarantees.ts';
import { type PortsPending, readPending } from './ports-pending.ts';

const NAME = 'pending-tags';

/**
 * `@public` tags whose reason is not yet a row id or a surface, by `file#<the tag's text>`, each with the lead's reason. This list
 * only shrinks; a new entry needs the review lead's sign-off.
 */
export const ALLOWED_PUBLIC: ReadonlyMap<string, string> = new Map([]);
export const KNIP_CONFIGS = ['knip.json', 'knip.production.json'] as const;

/** One source file as the rules read it. */
export interface TaggedFile {
  /** Repo-relative, `/`-separated. */
  readonly where: string;
  readonly text: string;
  /** The package's subsystem id; undefined for `std`, the shells and the CLI. */
  readonly owner: string | undefined;
  /** The package's manifest source, where `@public surface <name>` must find `<name>`. */
  readonly manifest: string;
}

/** One workspace's `ignore` list in one knip config. */
export interface KnipIgnore {
  readonly config: string;
  /** The workspace key as written (`packages/plugins/vault`). */
  readonly workspace: string;
  readonly owner: string | undefined;
  readonly paths: readonly string[];
}

export interface TagInput {
  readonly files: readonly TaggedFile[];
  readonly ignores: readonly KnipIgnore[];
  readonly pending: PortsPending;
  /** Ids of the kept and split guarantee rows. */
  readonly keptRows: ReadonlySet<string>;
}

const normal = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ').trim();
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The text of every comment in a TypeScript source, with the line each one starts on. */
export function commentsOf(text: string): { readonly line: number; readonly text: string }[] {
  const found: { line: number; text: string }[] = [];
  const pattern = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|(['"`])(?:\\[\s\S]|(?!\1)[^\\])*\1/g;
  for (const match of text.matchAll(pattern)) {
    const body = match[0];
    if (!body.startsWith('/')) continue; // a string literal, skipped so a quoted "//" or "/*" is not read as a comment
    found.push({ line: text.slice(0, match.index).split('\n').length, text: body });
  }
  return found;
}

/** Each `@pending` / `@public` tag in a comment: its kind, the rest of its line, and its line number. */
export function tagsOf(
  text: string,
): { readonly kind: 'pending' | 'public'; readonly rest: string; readonly line: number }[] {
  const tags: { kind: 'pending' | 'public'; rest: string; line: number }[] = [];
  for (const comment of commentsOf(text)) {
    const lines = comment.text.split('\n');
    lines.forEach((line, offset) => {
      for (const match of line.matchAll(/@(pending|public)\b([^\n]*)/g)) {
        const rest = (match[2] ?? '')
          .replace(/\*\/\s*$/, '')
          .replace(/\*\//g, '')
          .trim();
        tags.push({ kind: match[1] as 'pending' | 'public', rest, line: comment.line + offset });
      }
    });
  }
  return tags;
}

const reasonsOf = (pending: PortsPending, owner: string): readonly string[] => pending.reasons[owner] ?? [];

export function tagFindings(input: TagInput): Finding[] {
  const findings: Finding[] = [];
  const listed = new Set(input.pending.pending);
  const add = (where: string, message: string): void => {
    findings.push({ check: NAME, where, message });
  };
  for (const file of input.files) {
    for (const tag of tagsOf(file.text)) {
      const where = `${file.where}:${tag.line}`;
      if (tag.kind === 'pending') {
        const match = /^([a-z][a-z0-9-]*):\s*(\S.*)$/.exec(tag.rest);
        if (match === null) {
          add(where, '@pending must read "@pending <owner>: <the gap it waits for>"');
          continue;
        }
        const [, owner = '', gap = ''] = match;
        if (file.owner === undefined) {
          add(where, `@pending in a package that is no subsystem; only a pending port may keep code this way`);
          continue;
        }
        if (owner !== file.owner) {
          add(where, `@pending names "${owner}", but this file belongs to "${file.owner}"`);
          continue;
        }
        if (!listed.has(owner)) {
          add(where, `${owner} has left ports-pending.json; wire or delete what this @pending kept`);
          continue;
        }
        if (!reasonsOf(input.pending, owner).some(reason => normal(reason).includes(normal(gap))))
          add(where, `@pending gap "${gap}" is in none of pendingReasons.${owner} in ports-pending.json`);
        continue;
      }
      // The app shell, the CLI and std have no manifest or guarantee rows of their own: review judges their reasons.
      if (file.owner === undefined || ALLOWED_PUBLIC.has(`${file.where}#${tag.rest}`)) continue;
      if (tag.rest === '') {
        add(where, '@public needs a reason: a kept guarantee row id, or "surface <name>" from the manifest');
        continue;
      }
      const surface = /^surface\s+([^\s,;]+)/.exec(tag.rest);
      if (surface !== null) {
        const name = surface[1] ?? '';
        if (!new RegExp(`(^|[^A-Za-z0-9_$-])${escape(name)}($|[^A-Za-z0-9_$-])`).test(file.manifest))
          add(where, `@public surface "${name}" is not written in this package's manifest`);
        continue;
      }
      const ids = [...tag.rest.matchAll(/\b[A-Z]{1,3}[0-9]+[a-z]?\b/g)].map(m => m[0]);
      if (!ids.some(id => input.keptRows.has(id)))
        add(
          where,
          ids.length === 0
            ? '@public needs a reason: a kept guarantee row id, or "surface <name>" from the manifest'
            : `@public names ${ids.join(', ')}, none of them a kept row of docs/rebuild/guarantees.tsv`,
        );
    }
  }
  for (const ignore of input.ignores) {
    if (ignore.owner === undefined) continue; // the CLI and the shells: no port to wait for; knip judges these alone
    for (const path of ignore.paths) {
      const where = `${ignore.config} workspaces["${ignore.workspace}"].ignore`;
      if (!listed.has(ignore.owner)) {
        add(where, `"${path}" is ignored, but ${ignore.owner} has left ports-pending.json; wire or delete it`);
        continue;
      }
      if (!reasonsOf(input.pending, ignore.owner).some(reason => reason.includes(path)))
        add(where, `"${path}" is ignored, but no pendingReasons.${ignore.owner} line in ports-pending.json names it`);
    }
  }
  return findings;
}

function readIgnores(root: string, owners: ReadonlyMap<string, string | undefined>): KnipIgnore[] | Finding {
  const ignores: KnipIgnore[] = [];
  for (const config of KNIP_CONFIGS) {
    let parsed: { workspaces?: Record<string, { ignore?: unknown }> };
    try {
      parsed = JSON.parse(readFileSync(join(root, config), 'utf8')) as typeof parsed;
    } catch (error) {
      return { check: NAME, where: config, message: error instanceof Error ? error.message : String(error) };
    }
    for (const [workspace, settings] of Object.entries(parsed.workspaces ?? {})) {
      const list = settings.ignore;
      if (list === undefined) continue;
      const paths = (Array.isArray(list) ? list : [list]).filter((p): p is string => typeof p === 'string');
      ignores.push({ config, workspace, owner: owners.get(workspace), paths });
    }
  }
  return ignores;
}

export const check: Check = {
  name: NAME,
  summary: '@pending names an open gap of a pending port; @public names a kept row or a declared surface',
  async run(ctx) {
    const ws = loadWorkspace(ctx.root);
    let pending: PortsPending;
    try {
      pending = readPending(ctx.root);
    } catch (error) {
      return [
        { check: NAME, where: 'ports-pending.json', message: error instanceof Error ? error.message : String(error) },
      ];
    }
    const rows = readRows(ctx.root);
    if (!Array.isArray(rows)) return [rows];
    const keptRows = new Set(rows.filter(row => row.status !== 'removed').map(row => row.id));
    const files: TaggedFile[] = [];
    const owners = new Map<string, string | undefined>();
    for (const pkg of ws.packages) {
      owners.set(pkg.rel, pkg.id);
      if (ctx.packageId !== undefined && pkg.id !== ctx.packageId) continue;
      const manifest = pkg.manifestPath === undefined ? '' : readFileSync(pkg.manifestPath, 'utf8');
      for (const file of sourceFiles(pkg)) {
        const text = readFileSync(file, 'utf8');
        if (!text.includes('@pending') && !text.includes('@public')) continue;
        files.push({ where: relative(ws.root, file).split(sep).join('/'), text, owner: pkg.id, manifest });
      }
    }
    const ignores = readIgnores(ctx.root, owners);
    if (!Array.isArray(ignores)) return [ignores];
    return tagFindings({ files, ignores, pending, keptRows });
  },
};

if (import.meta.main) await runMain(check, process.argv.slice(2));
