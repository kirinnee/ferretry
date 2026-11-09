/**
 * The last gate: which fields of the converted home could make the preview EXECUTE something of v4's, or RESOLVE a path
 * into v4's home, v4's worktree folder or the user's harness homes (`~/.claude*`, `~/.codex*`).
 *
 * Only fields that are executed or resolved as paths are gated: a ferret's `command`, `agent`, `cwd`, `folder`, `env`
 * and flags, and every command, argument, environment value, home, path and file of a runtime, profile, component,
 * preset or MCP server. Free text (messages, events, prompts, notes, agenda text) is NOT gated and NOT redacted: a path
 * written in a message cannot make the daemon write anywhere. The gate answers file names and field names, never a value.
 */
import { readdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { resolveReal } from './paths.ts';

/** The last word of a key (split on case and punctuation) that makes the whole subtree under it executed or a path. */
const GATED_LAST_WORDS: ReadonlySet<string> = new Set([
  'command',
  'cmd',
  'args',
  'arg',
  'argv',
  'arguments',
  'env',
  'environment',
  'cwd',
  'folder',
  'folders',
  'home',
  'homes',
  'path',
  'paths',
  'file',
  'files',
  'dir',
  'dirs',
  'directory',
  'bin',
  'exec',
  'executable',
  'script',
  'entrypoint',
  'agent',
  'wrapper',
  'root',
  'workdir',
  'worktree',
  'mount',
  'mounts',
  'flags',
  'link',
]);

const lastWord = (key: string): string =>
  key
    .split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/u)
    .filter(Boolean)
    .at(-1)
    ?.toLowerCase() ?? '';

/** Everything the gate looks for, built once from every spelling of the homes involved. */
export interface Needles {
  /** Matched whole (what follows must end a path component): v4's home, its worktree folder, in every spelling. */
  readonly v4: readonly string[];
  /** Matched as a prefix: `<home>/.claude*` and `<home>/.codex*`. */
  readonly harness: readonly string[];
}

export interface Spellings {
  /** The v4 home as the caller named it, when that differs from the resolved one. */
  readonly v4Given?: string | undefined;
  /** The user's home as given (`$HOME`, the `home` input), beside the resolved one. */
  readonly homeGiven?: readonly string[] | undefined;
}

const HOME_FORMS = ['~', '$HOME', '${HOME}'] as const;

/** Every spelling of v4's home and of the harness homes: resolved, as given, `~/`, `$HOME`, `${HOME}`, the worktree sibling. */
export function needlesFor(v4Home: string, home: string, given: Spellings = {}): Needles {
  const userHomes = new Set<string>([home, resolveReal(home), resolveReal(homedir()), homedir()]);
  for (const spelling of given.homeGiven ?? []) if (spelling !== '') userHomes.add(spelling);
  const envHome = process.env.HOME;
  if (envHome !== undefined && envHome !== '') userHomes.add(envHome);
  const v4Spellings = new Set<string>([v4Home, resolveReal(v4Home)]);
  if (given.v4Given !== undefined && given.v4Given !== '') v4Spellings.add(given.v4Given);
  // v4's home lives at `~/.ferretry` by default: protected in every home-relative spelling whatever `--v4` said.
  const relatives = new Set<string>(['.ferretry']);
  for (const spelling of v4Spellings)
    for (const base of userHomes) {
      const rel = relative(base, spelling);
      if (rel !== '' && !rel.startsWith('..') && !rel.startsWith('/')) relatives.add(rel);
    }
  const v4 = new Set<string>();
  for (const spelling of v4Spellings) {
    v4.add(spelling);
    v4.add(`${spelling}-worktrees`);
  }
  for (const rel of relatives)
    for (const form of HOME_FORMS) {
      v4.add(`${form}/${rel}`);
      v4.add(`${form}/${rel}-worktrees`);
    }
  for (const base of userHomes) {
    v4.add(join(base, '.ferretry'));
    v4.add(join(base, '.ferretry-worktrees'));
  }
  const harness = new Set<string>();
  for (const base of [...userHomes, ...HOME_FORMS])
    for (const name of ['.claude', '.codex']) harness.add(`${base.replace(/\/+$/u, '')}/${name}`);
  return { v4: [...v4].filter(item => item !== ''), harness: [...harness] };
}

/** `needle` followed by anything that ends a path component: `<v4 home>-v5` and `<v4 home>.staging` are other folders. */
function namesWhole(text: string, needle: string): boolean {
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
    const next = text[at + needle.length];
    if (next === undefined || !/[\w.-]/u.test(next)) return true;
  }
  return false;
}

const decoded = (text: string): string => {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
};

/** Whether a gated value names v4 (whole) or a harness home (prefix), as written or URL-decoded. */
export function valueHits(value: string, needles: Needles, only: 'both' | 'harness' = 'both'): boolean {
  const forms = value === decoded(value) ? [value] : [value, decoded(value)];
  for (const form of forms) {
    if (needles.harness.some(needle => form.includes(needle))) return true;
    if (only === 'both' && needles.v4.some(needle => namesWhole(form, needle))) return true;
  }
  return false;
}

/** Names of the fields (dotted, with array indexes) under a gated key whose string value hits. Never the value. */
export function gatedFields(
  document: unknown,
  needles: Needles,
  options: { readonly skipTop?: ReadonlySet<string>; readonly harnessOnly?: ReadonlySet<string> } = {},
): string[] {
  const hits: string[] = [];
  const visit = (value: unknown, path: string, gated: boolean, only: 'both' | 'harness'): void => {
    if (typeof value === 'string') {
      if (gated && valueHits(value, needles, only)) hits.push(path);
    } else if (Array.isArray(value)) value.forEach((item, index) => visit(item, `${path}[${index}]`, gated, only));
    else if (value !== null && typeof value === 'object')
      for (const [key, inner] of Object.entries(value)) {
        if (path === '' && options.skipTop?.has(key) === true) continue;
        const harnessOnly = only === 'harness' || (path === '' && options.harnessOnly?.has(key) === true);
        visit(
          inner,
          path === '' ? key : `${path}.${key}`,
          gated || GATED_LAST_WORDS.has(lastWord(key)),
          harnessOnly ? 'harness' : 'both',
        );
      }
  };
  visit(document, '', false, 'both');
  return hits;
}

/** Which carried files the gate reads, and which top-level fields are not judged (see the two layouts below). */
const CONVERTED_SCOPE = [/^config\/.+\.(ya?ml|json)$/u, /^state\/ferrets\/[^/]+\/(ferret|config|details)\.json$/u];
const RAW_SCOPE = [/^config\/.+\.(ya?ml|json)$/u, /^state\/sessions\/[^/]+\/(config|details)\.json$/u];
/** A v4 ferret's fields the preview's converter removes or rewrites, so the dry run does not call them hits. */
const RAW_REWRITTEN = new Set([
  'command',
  'agent',
  'tmuxSession',
  'transcript',
  'conversion',
  'migration',
  'migrations',
]);
const RAW_FOLDER = new Set(['cwd', 'folder']);

function parseDocument(
  path: string,
  text: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    return { ok: true, value: path.endsWith('.json') ? JSON.parse(text) : parseYaml(text) };
  } catch {
    return { ok: false };
  }
}

/** The gated fields of one carried file; `mode` says whether the file is from the converted home or a raw v4 copy. */
export function gateOneFile(relativePath: string, text: string, needles: Needles, mode: 'converted' | 'raw'): string[] {
  const scope = mode === 'converted' ? CONVERTED_SCOPE : RAW_SCOPE;
  if (!scope.some(pattern => pattern.test(relativePath))) return [];
  const parsed = parseDocument(relativePath, text);
  if (!parsed.ok) return mode === 'converted' ? [`${relativePath}: unreadable, so it cannot be proven clean`] : [];
  const fields = gatedFields(
    parsed.value,
    needles,
    mode === 'raw' && relativePath.startsWith('state/') ? { skipTop: RAW_REWRITTEN, harnessOnly: RAW_FOLDER } : {},
  );
  return fields.map(field => `${relativePath}: ${field}`);
}

/** Every regular file under a finished (converted) home, as relative paths; links are never followed. */
async function everyFile(root: string, relative = ''): Promise<string[]> {
  const entries = await readdir(join(root, relative), { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    const path = relative === '' ? entry.name : `${relative}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await everyFile(root, path)));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

/** The gate over a finished home: `<file>: <field>` lines, sorted, never a value. */
export async function gateFiles(
  target: string,
  v4Home: string,
  home: string,
  given: Spellings = {},
): Promise<string[]> {
  const needles = needlesFor(v4Home, home, given);
  const hits: string[] = [];
  for (const file of await everyFile(target)) {
    if (!CONVERTED_SCOPE.some(pattern => pattern.test(file))) continue;
    const text = await readFile(join(target, file), 'utf8');
    hits.push(...gateOneFile(file, text, needles, 'converted'));
  }
  return hits.sort();
}

/**
 * What the gate WOULD hit, read from the v4 files a preview would copy: names only. The converter rewrites a ferret's
 * `command`, `agent`, transcript and a folder inside v4's home, so those are not counted here; the answer is therefore
 * a lower bound, and `prepare` is what proves the finished home.
 */
export async function gateForecast(
  v4Home: string,
  home: string,
  files: readonly { readonly path: string }[],
  given: Spellings = {},
): Promise<string[]> {
  const needles = needlesFor(v4Home, home, given);
  const hits: string[] = [];
  for (const file of files) {
    if (!RAW_SCOPE.some(pattern => pattern.test(file.path))) continue;
    const real = await realpath(join(v4Home, file.path)).catch(() => undefined);
    if (real === undefined) continue;
    const text = await readFile(real, 'utf8').catch(() => undefined);
    if (text !== undefined) hits.push(...gateOneFile(file.path, text, needles, 'raw'));
  }
  return hits.sort();
}
