/**
 * `pending-tags`: the ways the dead-code gates (`knip.json`, `knip.production.json`) are told to keep something stay
 * honest.
 *
 * - `@pending <owner>: <gap>` keeps ported code that waits for its wire. `<owner>` is the package's own subsystem id,
 *   that id is still listed in `ports-pending.json` `pending`, and `<gap>` is at least 3 words and 16 characters that
 *   start at a word of one of its `pendingReasons` lines (compared without case or repeated spaces). When the port
 *   lands and the id leaves `pending`, every tag left in the package is a finding, so the marker can never become a
 *   quiet way to keep dead code.
 * - A whole file kept the same way sits in a workspace's `ignore` in a knip config. The workspace key is resolved to
 *   the packages it matches (`packages/plugins/*` is every plugin); each matching subsystem must be pending and one of
 *   its `pendingReasons` lines must name the path as a whole token (6 characters or more). A key that matches no
 *   package is a finding. The CLI, the app shell and std have no port to wait for, so an `ignore` path under a key
 *   that matches only them (or the root) must instead be named on `ALLOWED_KNIP` with its reason (ruling #29: every
 *   ignore carries a GAP line or a reason).
 * - Every other knip key that keeps code alive (`ignoreFiles`, `ignoreIssues`, `ignoreMembers`,
 *   `ignoreExportsUsedInFile`, a top-level `ignore`, `ignoreWorkspaces`, an `entry` that is no test, view or bin file,
 *   any key this check does not know) is a finding unless `ALLOWED_KNIP` names it with a reason. That map only shrinks:
 *   an entry whose config line is gone is a finding too. `project` globs and the `rules` levels are not checked.
 * - `@public <why>` keeps a real use knip cannot see. In a subsystem `<why>` is the id of a kept (or split) row of
 *   `docs/rebuild/guarantees.tsv` whose owner (or `with`) is this package, or `surface <name>` where `<name>` is written
 *   in the package's manifest. The app shell and the CLI own guarantee rows too (`app-shell`, `fy-shell`); with no
 *   manifest their reason may instead be a `§n.n` section ref or a `docs/…` path that exists. std takes the last two.
 *
 * Tags are read from the comments the parser reports (`oxc-parser`, the same lexer as the import checks), at the start
 * of a comment line, in every source file of every workspace package (tests included). A file that does not parse is a
 * finding, not a skip.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { type Check, type Finding, runMain } from '../gen/lib/check.ts';
import { parser } from '../gen/lib/imports.ts';
import { loadWorkspace, sourceFiles } from '../gen/lib/workspace.ts';
import { type GuaranteeRow, readRows } from './guarantees.ts';
import { type PortsPending, readPending } from './ports-pending.ts';

const NAME = 'pending-tags';

/**
 * `@public` tags whose reason is not yet a row id, a surface or (shells) a section ref / docs path, by
 * `file#<the tag's text>`, each with the lead's reason. This list only shrinks; a new entry needs the review lead's
 * sign-off.
 */
export const ALLOWED_PUBLIC: ReadonlyMap<string, string> = new Map([]);

/**
 * Knip settings that keep code alive without a pending-port tie, by `<config>#<where>`, each with the reason it is
 * honest today. This list only shrinks; a new entry needs the review lead's sign-off.
 */
export const ALLOWED_KNIP: ReadonlyMap<string, string> = new Map([
  [
    'knip.production.json#workspaces["packages/plugins/voice"].ignoreDependencies:@huggingface/transformers',
    'only the STT workers ported but unwired (voice GAP line in ports-pending.json naming app/worker/*-worker.ts) import it; the workers leave with the GAP (ruling #26).',
  ],
  [
    'knip.production.json#workspaces["packages/plugins/voice"].ignoreDependencies:@lichess-org/vosk-browser',
    'only the STT workers ported but unwired (voice GAP line in ports-pending.json naming app/worker/*-worker.ts) import it; the workers leave with the GAP (ruling #26).',
  ],
  [
    'knip.production.json#workspaces["packages/plugins/voice"].ignoreDependencies:@sherpaw/asr',
    'only the STT workers ported but unwired (voice GAP line in ports-pending.json naming app/worker/*-worker.ts) import it; the workers leave with the GAP (ruling #26).',
  ],
  [
    'knip.production.json#workspaces["packages/plugins/voice"].ignoreDependencies:onnxruntime-web',
    'only the STT workers ported but unwired (voice GAP line in ports-pending.json naming app/worker/*-worker.ts) import it; the workers leave with the GAP (ruling #26).',
  ],
  [
    'knip.production.json#workspaces["packages/plugins/voice"].ignoreDependencies:parakeet.js',
    'only the STT workers ported but unwired (voice GAP line in ports-pending.json naming app/worker/*-worker.ts) import it; the workers leave with the GAP (ruling #26).',
  ],
  [
    'knip.production.json#workspaces["packages/plugins/mcp"].entry:app/views/surfaces.tsx',
    'loaded lazily by `import(`./views/${"surfaces"}.tsx`)` in app/index.ts, a template import knip cannot follow.',
  ],
  [
    'knip.production.json#workspaces["packages/plugins/skills"].entry:app/views/surfaces.tsx',
    'loaded lazily by `import(`./views/${"surfaces"}.tsx`)` in app/index.ts, a template import knip cannot follow.',
  ],
  [
    'knip.production.json#workspaces["packages/plugins/catalogs"].ignoreDependencies:react-dom',
    'only app/features/catalogs/catalog-add-toast.tsx (createPortal) imports it, and that file waits for its caller (catalogs GAP(conversation) line in ports-pending.json); the dependency leaves with that GAP.',
  ],
  [
    'knip.json#ignoreIssues["packages/plugins/catalogs/contract/wire/shared-catalog-diff.ts"]',
    'Every export of this frozen wire file (`contract/wire`), not one name: the ignore is file-wide. Today the one knip reports is `CatalogChangeFlagSchema`, built into the diff shapes in the same file and a named word of the contract vocabulary a consumer may import. The contract is not edited after day 1 (a per-name `@public` tag would be a contract edit), so its exports stay and knip is told they are intended; a new export here needs the lead anyway. Not a pending-port gap.',
  ],
  [
    'knip.json#ignoreIssues["packages/plugins/catalogs/contract/wire/shared-catalog-owner.ts"]',
    'Every export of this frozen wire file (`contract/wire`), not one name: the ignore is file-wide. Today the one knip reports is `OwnedSharedItemVersionSchema`, built into the owner shapes in the same file and a named word of the contract vocabulary a consumer may import. The contract is not edited after day 1 (a per-name `@public` tag would be a contract edit), so its exports stay and knip is told they are intended; a new export here needs the lead anyway. Not a pending-port gap.',
  ],
  [
    'knip.json#ignoreIssues["packages/plugins/shells/contract/wire.ts"]',
    '`ShellCacheKeySchema` (wire.ts) is a second name for `NarHashSchema`, kept as its own word of the cache vocabulary; knip reports that alias as a duplicate export. Not a pending-port gap.',
  ],
  [
    'knip.json#workspaces["."].entry:scripts/test/*.ts',
    'the repo test tooling (ci-sets, leak-sweep, partition-files, tmux-sweep, …) is run by path from tasks and CI, never imported.',
  ],
  [
    'knip.json#workspaces["packages/app"].entry:src/main.tsx',
    'the browser entry point the app shell build bundles from index.html; nothing imports it.',
  ],
  [
    'knip.json#workspaces["packages/plugins/connections"].entry:worker/src/adapters/worker.ts',
    'the Cloudflare Worker entry named by `main` in wrangler.jsonc; deployed by path, imported by nothing.',
  ],
  [
    'knip.json#workspaces["packages/plugins/catalogs"].entry:worker/src/adapters/link-store-worker.ts',
    'the link-store Cloudflare Worker entry named by `main` in wrangler.link-store.jsonc; deployed by path, imported by nothing.',
  ],
  [
    'knip.json#workspaces["packages/plugins/conversation"].entry:app/surfaces.tsx',
    'loaded lazily by `import(`./${"surfaces"}.tsx`)` in app/index.ts, a template import knip cannot follow.',
  ],
  [
    'knip.production.json#workspaces["packages/app"].entry:src/main.tsx',
    'the browser entry point the app shell build bundles from index.html; nothing imports it.',
  ],
  [
    'knip.production.json#workspaces["packages/plugins/connections"].entry:worker/src/adapters/worker.ts',
    'the Cloudflare Worker entry named by `main` in wrangler.jsonc; deployed by path, imported by nothing.',
  ],
  [
    'knip.production.json#workspaces["packages/plugins/catalogs"].entry:worker/src/adapters/link-store-worker.ts',
    'the link-store Cloudflare Worker entry named by `main` in wrangler.link-store.jsonc; deployed by path, imported by nothing.',
  ],
  [
    'knip.production.json#workspaces["packages/plugins/conversation"].entry:app/surfaces.tsx',
    'loaded lazily by `import(`./${"surfaces"}.tsx`)` in app/index.ts, a template import knip cannot follow.',
  ],
  [
    'knip.json#workspaces["packages/app"].entry:src/worker/service-worker.ts',
    'the service worker is compiled by packages/app/scripts/build-release.ts from this path and registered by URL; nothing imports it.',
  ],
  [
    'knip.json#workspaces["packages/app"].entry:scripts/**/*.ts',
    'the app shell build scripts (build-release, build-fy-render-libs) are run by path from package.json scripts; nothing imports them.',
  ],
  [
    'knip.json#workspaces["packages/app"].ignore:tests/support/dom-leak-guard.ts',
    'a bun test preload named by path in bunfig.unit.toml; nothing imports it.',
  ],
  [
    'knip.production.json#workspaces["packages/app"].ignore:src/worker/service-worker.ts',
    'the service worker is its own bundle: packages/app/scripts/build-release.ts compiles it from this path (sw.verified.js) and the shell registers it by URL.',
  ],
  [
    'knip.production.json#workspaces["packages/app"].ignore:src/worker/notifications.ts',
    'reached only from src/worker/service-worker.ts, the separate worker bundle the production entry never imports.',
  ],
  [
    'knip.production.json#workspaces["packages/app"].ignore:src/release/keeper.ts',
    'reached only from src/worker/service-worker.ts, the separate worker bundle the production entry never imports.',
  ],
  [
    'knip.production.json#workspaces["packages/app"].ignore:src/release/loopback.ts',
    'reached only from src/worker/service-worker.ts, the separate worker bundle the production entry never imports.',
  ],
  [
    'knip.production.json#workspaces["packages/app"].ignore:src/release/storage.ts',
    'reached only from src/worker/service-worker.ts, the separate worker bundle the production entry never imports.',
  ],
  [
    'knip.production.json#workspaces["packages/cli"].ignore:src/lib/tool-client.ts',
    'GAP(mcp): the agent-tool client behind `fy mcp serve`; reached when the MCP cli half lands (ports-pending.json pendingHalves.mcp ["cli"]); only its tests reach it until then (nelly).',
  ],
  [
    'knip.production.json#workspaces["packages/cli"].ignore:src/lib/update/status.ts',
    'GAP(cli): the update line of `fy daemon status` (today rebuild-ref packages/cli/bin/program.ts:656 builds DaemonUpdateStatusReader, read at src/lib/daemon/controller.ts:630); no 5.0 verb renders it yet (nelly).',
  ],
]);

export const KNIP_CONFIGS = ['knip.json', 'knip.production.json'] as const;

/** One source file as the rules read it. */
export interface TaggedFile {
  /** Repo-relative, `/`-separated; the extension picks the parser's language (`.tsx` reads JSX). */
  readonly where: string;
  readonly text: string;
  /** The package's subsystem id; undefined for `std`, the app shell and the CLI. */
  readonly owner: string | undefined;
  /** Whose guarantee rows a `@public` row id may name: the subsystem id, `app-shell`, `fy-shell`; undefined for std. */
  readonly rowOwner: string | undefined;
  /** The package's manifest source, where `@public surface <name>` must find `<name>`. */
  readonly manifest: string;
}

/** One workspace's `ignore` list in one knip config. */
export interface KnipIgnore {
  readonly config: string;
  /** The workspace key as written (`packages/plugins/vault`, `packages/plugins/*`). */
  readonly workspace: string;
  /** The subsystem id of every package the key matches; `undefined` for one with no id (and for the root `.`). */
  readonly owners: readonly (string | undefined)[];
  readonly paths: readonly string[];
}

export interface TagInput {
  readonly files: readonly TaggedFile[];
  readonly ignores: readonly KnipIgnore[];
  readonly pending: PortsPending;
  /** The kept and split guarantee rows, by id. */
  readonly keptRows: ReadonlyMap<string, Pick<GuaranteeRow, 'owner' | 'with'>>;
  /** Whether a repo-relative path exists (a `@public docs/…` reason). */
  readonly docExists: (path: string) => boolean;
}

export const MIN_GAP_WORDS = 3;
export const MIN_GAP_CHARS = 16;
export const MIN_IGNORE_CHARS = 6;

const normal = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ').trim();
const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isWordChar = (char: string | undefined): boolean => char !== undefined && /[\p{L}\p{N}]/u.test(char);

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

export interface Tag {
  readonly kind: 'pending' | 'public';
  readonly rest: string;
  readonly line: number;
}

/**
 * Each `@pending` / `@public` tag in a comment of one source: its kind, the rest of its line, and its line number. The
 * comments come from the parser, so a quote, a regex literal or JSX text can neither hide a real comment nor make a
 * phantom one. A tag counts only at the start of a comment line (after the comment's `*` margin). `error` is the
 * parser's complaint when the source does not parse; no tag is read from it then.
 */
export function tagsOf(where: string, text: string): { readonly tags: readonly Tag[]; readonly error?: string } {
  let parsed: ReturnType<ReturnType<typeof parser>>;
  try {
    parsed = parser()(where, text, { sourceType: 'module' });
  } catch (error) {
    return { tags: [], error: error instanceof Error ? error.message : String(error) };
  }
  if (parsed.errors.length > 0) return { tags: [], error: parsed.errors.map(error => error.message).join('; ') };
  const tags: Tag[] = [];
  for (const comment of parsed.comments) {
    if (!comment.value.includes('@')) continue;
    const first = lineAt(text, comment.start);
    comment.value.split('\n').forEach((line, offset) => {
      const match = /^[\s*]*@(pending|public)\b(.*)$/.exec(line);
      if (match === null) return;
      tags.push({ kind: match[1] as 'pending' | 'public', rest: (match[2] ?? '').trim(), line: first + offset });
    });
  }
  return { tags };
}

const reasonsOf = (pending: PortsPending, owner: string): readonly string[] => pending.reasons[owner] ?? [];

/** Whether `gap` appears in `reason` (case and spacing aside), starting at a word of it. */
function gapIn(reason: string, gap: string): boolean {
  const hay = normal(reason);
  const needle = normal(gap);
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1))
    if (at === 0 || !isWordChar(hay[at - 1])) return true;
  return false;
}

/** Why a gap is too thin to tie a tag to a reason, or undefined. */
function thinGap(gap: string): string | undefined {
  const text = normal(gap);
  const words = text.split(' ').filter(word => /[\p{L}\p{N}]/u.test(word)).length;
  return words >= MIN_GAP_WORDS && text.length >= MIN_GAP_CHARS
    ? undefined
    : `@pending gap "${gap}" is too thin: write at least ${MIN_GAP_WORDS} words and ${MIN_GAP_CHARS} characters of a pendingReasons line`;
}

/** Whether `reason` names `path` as a whole path token (delimited by space, quote, backtick, comma or a bracket). */
function namesPath(reason: string, path: string): boolean {
  return new RegExp(`(^|[\\s\`'",;(\\[])${escape(path)}(?=$|[\\s\`'",;)\\]]|[.:](?:\\s|$))`).test(reason);
}

const SECTION = /§\d+(?:\.\d+)*/;

/** Why a `@public` reason does not hold, or undefined. */
function publicProblem(file: TaggedFile, rest: string, input: TagInput): string | undefined {
  const shell = file.owner === undefined;
  const need = shell
    ? '@public needs a reason: a kept guarantee row id of this package, a § section ref, or a docs/… path that exists'
    : '@public needs a reason: a kept guarantee row id of this package, or "surface <name>" from the manifest';
  if (rest === '') return need;
  const surface = /^surface\s+([^\s,;]+)/.exec(rest);
  if (surface !== null) {
    const name = surface[1] ?? '';
    return new RegExp(`(^|[^A-Za-z0-9_$-])${escape(name)}($|[^A-Za-z0-9_$-])`).test(file.manifest)
      ? undefined
      : `@public surface "${name}" is not written in this package's manifest`;
  }
  const ids = [...rest.matchAll(/\b[A-Z]{1,3}[0-9]+[a-z]?\b/g)].map(m => m[0]);
  const kept = ids.filter(id => input.keptRows.has(id));
  const mine = kept.filter(id => {
    const row = input.keptRows.get(id);
    return (
      row !== undefined &&
      file.rowOwner !== undefined &&
      (row.owner === file.rowOwner || row.with.includes(file.rowOwner))
    );
  });
  if (mine.length > 0) return undefined;
  if (shell) {
    if (SECTION.test(rest)) return undefined;
    const docs = [...rest.matchAll(/\bdocs\/[^\s`'",;()]+/g)].map(m => m[0].replace(/[.:]+$/, ''));
    if (docs.some(path => input.docExists(path))) return undefined;
    if (docs.length > 0) return `@public names ${docs.join(', ')}, which does not exist`;
  }
  if (kept.length > 0)
    return `@public names ${kept.join(', ')}, a row of another package; name a row ${file.rowOwner ?? 'this package'} owns`;
  return ids.length === 0
    ? need
    : `@public names ${ids.join(', ')}, none of them a kept row of docs/rebuild/guarantees.tsv`;
}

export function tagFindings(input: TagInput): Finding[] {
  const findings: Finding[] = [];
  const listed = new Set(input.pending.pending);
  const add = (where: string, message: string): void => {
    findings.push({ check: NAME, where, message });
  };
  for (const file of input.files) {
    const read = tagsOf(file.where, file.text);
    if (read.error !== undefined) {
      add(file.where, `does not parse, so its @pending / @public tags cannot be read: ${read.error}`);
      continue;
    }
    for (const tag of read.tags) {
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
        const thin = thinGap(gap);
        if (thin !== undefined) {
          add(where, thin);
          continue;
        }
        if (!reasonsOf(input.pending, owner).some(reason => gapIn(reason, gap)))
          add(where, `@pending gap "${gap}" is in none of pendingReasons.${owner} in ports-pending.json`);
        continue;
      }
      if (ALLOWED_PUBLIC.has(`${file.where}#${tag.rest}`)) continue;
      const problem = publicProblem(file, tag.rest, input);
      if (problem !== undefined) add(where, problem);
    }
  }
  for (const ignore of input.ignores) {
    const where = `${ignore.config} workspaces["${ignore.workspace}"].ignore`;
    for (const owner of new Set(ignore.owners)) {
      if (owner === undefined) continue; // no port to wait for; knip judges these alone
      for (const path of ignore.paths) {
        if (!listed.has(owner)) {
          add(where, `"${path}" is ignored, but ${owner} has left ports-pending.json; wire or delete it`);
          continue;
        }
        if (path.length < MIN_IGNORE_CHARS) {
          add(
            where,
            `"${path}" is ignored for ${owner}, but is too short to be named (${MIN_IGNORE_CHARS} characters or more)`,
          );
          continue;
        }
        if (!reasonsOf(input.pending, owner).some(reason => namesPath(reason, path)))
          add(where, `"${path}" is ignored, but no pendingReasons.${owner} line in ports-pending.json names it`);
      }
    }
  }
  return findings;
}

// ─── knip ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** One knip config as parsed. */
export interface KnipConfig {
  readonly config: string;
  readonly json: unknown;
}

/** A workspace package as a knip key sees it. */
export interface PackageRef {
  readonly rel: string;
  readonly id: string | undefined;
}

const isRoot = (key: string): boolean => key === '.' || key === '';
const keyPattern = (key: string): string => key.replace(/^\.\//, '').replace(/\/+$/, '');
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The packages a workspace key matches (a glob over their folders; `./` and a trailing `/` are dropped). */
function matching(key: string, packages: readonly PackageRef[]): PackageRef[] {
  const glob = new Bun.Glob(keyPattern(key));
  return packages.filter(pkg => glob.match(pkg.rel));
}

const workspacesOf = (json: unknown): [string, Record<string, unknown>][] => {
  const workspaces = isRecord(json) ? json.workspaces : undefined;
  return isRecord(workspaces)
    ? Object.entries(workspaces).flatMap(([key, value]): [string, Record<string, unknown>][] =>
        isRecord(value) ? [[key, value]] : [],
      )
    : [];
};

const listOf = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value]).filter((item): item is string => typeof item === 'string');

/** Every workspace `ignore` list of the configs, each key resolved to the subsystems it matches. */
export function knipIgnores(configs: readonly KnipConfig[], packages: readonly PackageRef[]): KnipIgnore[] {
  const ignores: KnipIgnore[] = [];
  for (const { config, json } of configs)
    for (const [workspace, settings] of workspacesOf(json)) {
      if (settings.ignore === undefined) continue;
      const owners = isRoot(workspace) ? [undefined] : matching(workspace, packages).map(pkg => pkg.id);
      ignores.push({ config, workspace, owners, paths: listOf(settings.ignore) });
    }
  return ignores;
}

const TOP_KEYS = new Set(['$schema', 'workspaces', 'rules', 'tags']);
const WORKSPACE_KEYS = new Set(['entry', 'project', 'ignore']);
/** Entry patterns that need no tie: the tests, the views a layout mounts, and the bins. */
const isPlainEntry = (pattern: string): boolean =>
  pattern.startsWith('tests/') || pattern === 'app/views/*.tsx' || pattern === 'bin/*.ts';

/** The parts of a setting that each need a name on `ALLOWED_KNIP`: object keys, array items, or the setting itself. */
function parts(value: unknown): string[] {
  if (isRecord(value)) return Object.keys(value).map(key => `[${JSON.stringify(key)}]`);
  if (Array.isArray(value)) return value.map(item => `:${String(item)}`);
  return [''];
}

/**
 * The shape of the knip configs: only the keys this check reads, plus the test, view and bin `entry` patterns. Anything
 * else that keeps code alive must be on `allowed` with a reason, and an `allowed` entry nothing uses is a finding
 * (the map only shrinks). A workspace key that matches no package is a finding.
 */
export function knipShapeFindings(
  configs: readonly KnipConfig[],
  packages: readonly PackageRef[],
  allowed: ReadonlyMap<string, string> = ALLOWED_KNIP,
): Finding[] {
  const findings: Finding[] = [];
  const used = new Set<string>();
  const refuse = (id: string, where: string, what: string): void => {
    used.add(id);
    if (allowed.has(id)) return;
    findings.push({
      check: NAME,
      where,
      message: `${what} keeps code alive without a pending-port tie; remove it, or name "${id}" on ALLOWED_KNIP with a reason`,
    });
  };
  for (const { config, json } of configs) {
    if (!isRecord(json)) {
      findings.push({ check: NAME, where: config, message: 'is not a JSON object' });
      continue;
    }
    for (const [key, value] of Object.entries(json)) {
      if (TOP_KEYS.has(key) || value === false) continue; // `false` switches a knip plugin off
      for (const part of parts(value)) refuse(`${config}#${key}${part}`, config, `"${key}"${part}`);
    }
    for (const [workspace, settings] of workspacesOf(json)) {
      const where = `${config} workspaces["${workspace}"]`;
      if (!isRoot(workspace) && matching(workspace, packages).length === 0)
        findings.push({
          check: NAME,
          where,
          message: 'matches no workspace package (a typo, or a key left behind); fix or delete it',
        });
      for (const [key, value] of Object.entries(settings)) {
        if (key === 'entry') {
          for (const pattern of listOf(value))
            if (!isPlainEntry(pattern))
              refuse(
                `${config}#workspaces[${JSON.stringify(workspace)}].entry:${pattern}`,
                where,
                `entry "${pattern}"`,
              );
          continue;
        }
        if (key === 'ignore') {
          // A subsystem's ignore is tied to its GAP line (tagFindings); one with no subsystem needs a named reason.
          const owners = isRoot(workspace) ? [undefined] : matching(workspace, packages).map(pkg => pkg.id);
          if (owners.length > 0 && owners.every(owner => owner === undefined))
            for (const path of listOf(value))
              refuse(`${config}#workspaces[${JSON.stringify(workspace)}].ignore:${path}`, where, `ignore "${path}"`);
          continue;
        }
        if (WORKSPACE_KEYS.has(key)) continue;
        for (const part of parts(value))
          refuse(`${config}#workspaces[${JSON.stringify(workspace)}].${key}${part}`, where, `"${key}"${part}`);
      }
    }
  }
  for (const id of allowed.keys())
    if (!used.has(id))
      findings.push({
        check: NAME,
        where: 'scripts/validate/pending-tags.ts',
        message: `ALLOWED_KNIP "${id}" matches no knip setting any more; delete the entry`,
      });
  return findings;
}

function readKnipConfigs(root: string): KnipConfig[] | Finding {
  const configs: KnipConfig[] = [];
  for (const config of KNIP_CONFIGS) {
    try {
      configs.push({ config, json: JSON.parse(readFileSync(join(root, config), 'utf8')) as unknown });
    } catch (error) {
      return { check: NAME, where: config, message: error instanceof Error ? error.message : String(error) };
    }
  }
  return configs;
}

// ─── the check ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Whose guarantee rows a package may name: its subsystem id, or the shell owner names of the guarantees table. */
const rowOwnerOf = (id: string | undefined, name: string): string | undefined =>
  id ?? (name === '@ferretry/app' ? 'app-shell' : name === 'fy' ? 'fy-shell' : undefined);

export const checkWith = (allowedKnip: ReadonlyMap<string, string>): Check => ({
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
    const keptRows = new Map(rows.filter(row => row.status !== 'removed').map(row => [row.id, row] as const));
    const files: TaggedFile[] = [];
    for (const pkg of ws.packages) {
      if (ctx.packageId !== undefined && pkg.id !== ctx.packageId) continue;
      const manifest = pkg.manifestPath === undefined ? '' : readFileSync(pkg.manifestPath, 'utf8');
      for (const file of sourceFiles(pkg)) {
        const text = readFileSync(file, 'utf8');
        if (!text.includes('@pending') && !text.includes('@public')) continue;
        files.push({
          where: relative(ws.root, file).split(sep).join('/'),
          text,
          owner: pkg.id,
          rowOwner: rowOwnerOf(pkg.id, pkg.name),
          manifest,
        });
      }
    }
    const configs = readKnipConfigs(ctx.root);
    if (!Array.isArray(configs)) return [configs];
    const packages = ws.packages.map(pkg => ({ rel: pkg.rel, id: pkg.id }));
    return [
      ...tagFindings({
        files,
        ignores: knipIgnores(configs, packages),
        pending,
        keptRows,
        docExists: path => existsSync(join(ctx.root, path)),
      }),
      ...knipShapeFindings(configs, packages, allowedKnip),
    ];
  },
});

export const check: Check = checkWith(ALLOWED_KNIP);

if (import.meta.main) await runMain(check, process.argv.slice(2));
