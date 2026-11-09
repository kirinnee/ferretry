/**
 * The last gate: which fields of the converted home could make the preview EXECUTE something of v4's, or RESOLVE a path
 * into v4's home, v4's worktree folder or the user's harness homes (`~/.claude*`, `~/.codex*`).
 *
 * A ferret's `command`, `agent`, `cwd`, `folder`, `env` and flags are gated by key. In config/runtimes, profiles, mcp,
 * components, endpoints and the harness settings (STRICT_FOLDERS) EVERY string value and every key is gated, except a
 * short allowlist of free-text keys (description, label, title, name, notes ...). Free text (messages, events, prompts, notes, agenda text) is NOT gated and NOT redacted: a path
 * written in a message cannot make the daemon write anywhere. The gate answers file names and field names, never a value.
 */
import { readdir, readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { quietYaml as parseYaml } from '../src/v4/config.ts';
import { type Needles, needlesFor, type Spellings, valueHits } from '../src/v4/homes.ts';

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

/**
 * Folders the gate reads STRICTLY: in these, a runtime, profile, MCP server, component, endpoint or harness setting can
 * name something to EXECUTE or a path to RESOLVE under any key (codex `notify`, Claude `apiKeyHelper`, `writable_roots`,
 * `additionalDirectories`, a `projects."/abs"` key). A key-name list cannot know them all, so EVERY string value and
 * every object key is checked, except the free-text keys below. Both layouts: the converted home and a raw v4 copy.
 */
const STRICT_FOLDERS =
  /^config\/(runtimes|profiles|mcp|components|endpoints|presets|models|model-sets|skills|claude-code|codex)\//u;

/** Keys whose value is prose for a person: never executed, never resolved as a path. The one allowlist of the strict gate. */
const FREE_TEXT_KEYS: ReadonlySet<string> = new Set([
  'description',
  'label',
  'title',
  'name',
  'notes',
  'note',
  'summary',
  'comment',
  'comments',
  'text',
  'message',
  'prompt',
]);

/** Names of the fields (dotted, with array indexes) under a gated key whose string value hits. Never the value. */
export function gatedFields(
  document: unknown,
  needles: Needles,
  options: {
    readonly skipTop?: ReadonlySet<string>;
    readonly harnessOnly?: ReadonlySet<string>;
    /** Check every string value and every key, except under a free-text key (see {@link STRICT_FOLDERS}). */
    readonly strict?: boolean;
  } = {},
): string[] {
  const hits: string[] = [];
  const strict = options.strict === true;
  // `inEnv`: the keys here are environment variable names (`env`), where a variable called NAME or PROMPT is a variable,
  // not free text, so the free-text allowlist does not apply.
  const visit = (value: unknown, path: string, gated: boolean, only: 'both' | 'harness', inEnv: boolean): void => {
    if (typeof value === 'string') {
      if (gated && valueHits(value, needles, only)) hits.push(path);
    } else if (Array.isArray(value))
      value.forEach((item, index) => visit(item, `${path}[${index}]`, gated, only, inEnv));
    else if (value !== null && typeof value === 'object')
      for (const [key, inner] of Object.entries(value)) {
        if (path === '' && options.skipTop?.has(key) === true) continue;
        if (strict && !inEnv && FREE_TEXT_KEYS.has(key.toLowerCase())) continue;
        // A key that is itself a path (codex `projects."/abs"`): named by its place, never by the key's text.
        if (strict && valueHits(key, needles, only)) hits.push(path === '' ? '<path key>' : `${path}.<path key>`);
        const harnessOnly = only === 'harness' || (path === '' && options.harnessOnly?.has(key) === true);
        // Any key that looks like a path is named by its place in every hit below it too.
        const label = key.includes('/') ? '<path key>' : key;
        visit(
          inner,
          path === '' ? label : `${path}.${label}`,
          gated || GATED_LAST_WORDS.has(lastWord(key)),
          harnessOnly ? 'harness' : 'both',
          key.toLowerCase() === 'env' || (key === 'set' && path.split('.').at(-1) === 'shell_environment_policy'),
        );
      }
  };
  visit(document, '', strict, 'both', false);
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
  const fields = gatedFields(parsed.value, needles, {
    ...(mode === 'raw' && relativePath.startsWith('state/') ? { skipTop: RAW_REWRITTEN, harnessOnly: RAW_FOLDER } : {}),
    strict: STRICT_FOLDERS.test(relativePath),
  });
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
