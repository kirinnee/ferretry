/**
 * Which provider a set of environment variables is for (docs/provider-presets.md § Detect): the
 * variables a person pastes, passes as `--env`, or has in their shell, read against the `detect` clues
 * each preset file declares. One table, and the preset files own it.
 *
 * THREE CLUES, strongest first:
 *
 * - a base URL on a host the provider documents (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, a Codex
 *   `model_providers.<id>.base_url`) — the provider is where the requests go;
 * - a variable only that provider's setup uses (`CLAUDE_CODE_USE_BEDROCK`, `ZAI_API_KEY`);
 * - a key that starts the way the provider documents its keys (`sk-or-`).
 *
 * NO VALUE LEAVES THIS MODULE. What it reports is variable NAMES, the clue kind, and — for a host —
 * the host as the PRESET wrote it, never the URL as the person wrote it (a URL can carry a user and a
 * password). A key is only compared with a prefix the preset declares; it is never returned, logged or
 * put in a sentence. Nothing is found means "a custom gateway", with what was recognised said.
 *
 * Pure and total, and dependency-free so a browser can run it on a paste without sending anything.
 */

/** A preset's clues, as a preset file declares them under `detect:`. */
export interface DetectClues {
  readonly hosts: readonly string[];
  readonly variables: readonly string[];
  readonly keyPrefixes: readonly string[];
}

/** One row of the table: a preset and its clues, in the catalogue's order. */
export interface DetectablePreset {
  readonly id: string;
  readonly detect: DetectClues;
}

/** Which CLI a variable speaks to. */
export type DetectedHarness = 'claude' | 'codex';

/** One thing that pointed at the provider: a variable by its NAME, and how. */
export type DetectionClue =
  | { readonly kind: 'host'; readonly variable: string; readonly host: string }
  | { readonly kind: 'variable'; readonly variable: string }
  | { readonly kind: 'key-prefix'; readonly variable: string };

export interface ProviderDetection {
  /** The preset the clues point at, or `undefined`: a custom gateway. */
  readonly preset?: string;
  /** What pointed there. Empty for a custom gateway. */
  readonly clues: readonly DetectionClue[];
  /** Other presets that scored as high, in catalogue order: the person should check the pick. */
  readonly alsoMatched: readonly string[];
  /** Every variable read as meaningful — a base URL, a key, a switch — by NAME, in the order given. */
  readonly recognised: readonly string[];
  /** The CLIs the variables were written for, from their names. Claude Code first. */
  readonly harnesses: readonly DetectedHarness[];
}

/** How much each clue weighs: where the requests go outranks what a variable is called. */
const WEIGHT: Readonly<Record<DetectionClue['kind'], number>> = { host: 10, variable: 4, 'key-prefix': 3 };

/** A variable whose value is an address, by its name. */
const URL_NAME = /(?:^|[_.])BASE_URL$|(?:^|\.)base_url$|_ENDPOINT$|_API_BASE$/iu;

/** A variable that holds a key, by its name. */
const KEY_NAME = /(?:KEY|TOKEN|SECRET)$/iu;

/** A variable that turns a CLI's provider on (`CLAUDE_CODE_USE_BEDROCK=1`). */
const SWITCH_NAME = /^CLAUDE_CODE_USE_[A-Z]+$/u;

/** The host of an `http(s)://` value, lower case, or `undefined`. Never the user, password or path. */
function hostOf(value: string): string | undefined {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined;
    return url.hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Whether a declared name (or `PREFIX_*` family) covers `name`. */
const namesVariable = (pattern: string, name: string): boolean =>
  pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : pattern === name;

/** Whether `host` is `declared` or below it. */
const onHost = (host: string, declared: string): boolean => host === declared || host.endsWith(`.${declared}`);

/** The CLI a variable's name speaks to, when it says. */
function harnessOfName(name: string): DetectedHarness | undefined {
  if (/^(?:ANTHROPIC_|CLAUDE_CODE_|CLAUDE_)/u.test(name)) return 'claude';
  if (/^(?:OPENAI_|CODEX_|AZURE_OPENAI_)/u.test(name) || name.startsWith('model_providers.')) return 'codex';
  return undefined;
}

/** The clues one preset finds in the variables. */
function cluesFor(preset: DetectablePreset, env: Readonly<Record<string, string>>): readonly DetectionClue[] {
  const clues: DetectionClue[] = [];
  for (const [name, value] of Object.entries(env)) {
    const host = URL_NAME.test(name) ? hostOf(value) : undefined;
    const declared = host === undefined ? undefined : preset.detect.hosts.find(entry => onHost(host, entry));
    if (declared !== undefined) clues.push({ kind: 'host', variable: name, host: declared });
    if (preset.detect.variables.some(pattern => namesVariable(pattern, name)))
      clues.push({ kind: 'variable', variable: name });
    if (KEY_NAME.test(name) && preset.detect.keyPrefixes.some(prefix => value.startsWith(prefix))) {
      clues.push({ kind: 'key-prefix', variable: name });
    }
  }
  return clues;
}

const score = (clues: readonly DetectionClue[]): number => clues.reduce((sum, clue) => sum + WEIGHT[clue.kind], 0);

/**
 * The provider `env` is for, by the table's clues. `env` is NAME → value as written; a value is read
 * only to compare it with the table and is never part of the answer.
 */
export function detectProvider(
  table: readonly DetectablePreset[],
  env: Readonly<Record<string, string>>,
): ProviderDetection {
  const names = Object.keys(env);
  const patterns = table.flatMap(row => row.detect.variables);
  const recognised = names.filter(
    name =>
      URL_NAME.test(name) ||
      KEY_NAME.test(name) ||
      SWITCH_NAME.test(name) ||
      patterns.some(pattern => namesVariable(pattern, name)),
  );
  const said = new Set(names.flatMap(name => harnessOfName(name) ?? []));
  const harnesses = (['claude', 'codex'] as const).filter(harness => said.has(harness));
  const scored = table
    .map(row => ({ id: row.id, clues: cluesFor(row, env) }))
    .map(row => ({ ...row, score: score(row.clues) }))
    .filter(row => row.score > 0);
  const best = Math.max(0, ...scored.map(row => row.score));
  const top = scored.filter(row => row.score === best);
  const winner = top[0];
  if (winner === undefined) return { clues: [], alsoMatched: [], recognised, harnesses };
  return {
    preset: winner.id,
    clues: winner.clues,
    alsoMatched: top.slice(1).map(row => row.id),
    recognised,
    harnesses,
  };
}

/** A shell or config line's value without its quotes and trailing comment. */
function unquote(raw: string): string {
  const value = raw.trim();
  const quote = value[0];
  if ((quote === '"' || quote === "'") && value.lastIndexOf(quote) > 0) return value.slice(1, value.lastIndexOf(quote));
  const hash = value.search(/\s#/u);
  return hash < 0 ? value : value.slice(0, hash).trimEnd();
}

/**
 * The variables in a pasted block, NAME → value: `NAME=value`, `export NAME=value`, `NAME: value` (YAML), and a Codex TOML table's `base_url = "…"` / `env_key = "…"` as
 * `model_providers.<id>.base_url`. Comments and blank lines are skipped; a later line wins. Nothing
 * else is guessed at.
 */
export function parseVariableBlock(text: string): Readonly<Record<string, string>> {
  const found: Record<string, string> = {};
  let table: string | undefined;
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const header = /^\[([A-Za-z0-9_.-]+)\]$/u.exec(trimmed);
    if (header !== null) {
      table = (header[1] as string).startsWith('model_providers.') ? header[1] : undefined;
      continue;
    }
    const toml = /^([a-z_]+)\s*=\s*(.+)$/u.exec(trimmed);
    if (table !== undefined && toml !== null) {
      found[`${table}.${toml[1] as string}`] = unquote(toml[2] as string);
      continue;
    }
    const assignment = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|:\s)\s*(.*)$/u.exec(trimmed);
    if (assignment !== null) found[assignment[1] as string] = unquote(assignment[2] as string);
  }
  return found;
}
