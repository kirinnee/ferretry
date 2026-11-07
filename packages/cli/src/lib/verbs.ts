/**
 * The verb table: every verb line the registry's manifests declare, plus the shell's own, resolved by the
 * longest run of leading words (`card move` beats `card`). Pure.
 */
import type { VerbDecl } from '@ferretry/kernel/manifest';
import type { CommandRegistry, RegistryEntry } from './registry.ts';

/** The shell owns exactly these verb lines (§1.4). A plugin may add others under the same first word. */
const SHELL_VERB_LINES = [
  { verb: 'plugin list', summary: 'every plugin: on or off, version, what it adds and what needs it' },
  { verb: 'plugin show', summary: 'one plugin in words: actions, screens, hooks, permissions' },
  { verb: 'plugin on', summary: 'turn a plugin on' },
  { verb: 'plugin off', summary: 'turn a plugin off (names what depends on it first)' },
  { verb: 'plugin add', summary: 'install a data plugin from a folder, git address or share link' },
  { verb: 'plugin remove', summary: 'remove a data plugin' },
  { verb: 'plugin check', summary: 'run the data-plugin checks on a folder without installing' },
  { verb: 'words', summary: 'print a word, its owner and the words it replaced' },
  { verb: 'doctor', summary: 'check this fy against the daemon, plugin by plugin' },
  { verb: 'daemon status', summary: 'is the daemon up, which build, which plugins agree' },
  { verb: 'daemon start', summary: 'start the daemon now (any other command starts it by itself)' },
  { verb: 'daemon stop', summary: 'stop the daemon and wait until it has released its address' },
  {
    verb: 'daemon restart',
    summary:
      'stop the daemon, wait for it to go quiet, then start it again; ferrets keep running (--when-idle waits for every turn)',
  },
  { verb: 'daemon install', summary: 'install the user service definition and start the daemon under it' },
  { verb: 'daemon uninstall', summary: 'stop the daemon and remove its user service definition' },
  { verb: 'daemon logs', summary: 'print the daemon log (-f follows it)' },
  { verb: 'daemon which', summary: 'show the installed and currently running daemon identities' },
  {
    verb: 'daemon reset',
    summary: 'stop the daemon and remove ALL of its persistent data on this host (--yes skips the typed word)',
  },
  {
    verb: 'update',
    summary: 'update this machine, restart its daemon, and roll back if the new version does not serve',
  },
  {
    verb: 'snapshot',
    summary: "snapshot <id>: capture the ferret's live screen (a dead pane is refused, never served as blank)",
  },
  {
    verb: 'events',
    summary: 'events <id>: read the durable events the daemon recorded for a ferret (--after, --limit, --json)',
  },
  { verb: 'view', summary: 'view <id>: the same as events' },
  { verb: 'ask', summary: 'list the asks waiting for an answer, and answer one' },
] as const satisfies readonly { readonly verb: string; readonly summary: string }[];

export interface VerbEntry {
  /** The words a person types, in order. */
  readonly words: readonly string[];
  /** The declared verb line: also the key of the plugin half's `verbs` record. */
  readonly line: string;
  /** The plugin that declares it, or `shell` for the shell's own. */
  readonly owner: string;
  readonly summary?: string;
  /** Data plugins only: the verb line this alias runs. */
  readonly alias?: string;
}

export interface VerbConflict {
  readonly line: string;
  readonly owner: string;
  readonly keptFrom: string;
}

export interface VerbTable {
  readonly entries: readonly VerbEntry[];
  /** Verb lines a plugin declared that another owner already holds; they are left out and `fy doctor` says so. */
  readonly conflicts: readonly VerbConflict[];
}

const WORD = /^[a-z][a-z0-9-]*$/u;

/** The typed words of a declared verb line; placeholders such as `<id>` or `[name]` are not words. */
export function verbWords(line: string): readonly string[] {
  return line
    .trim()
    .split(/\s+/u)
    .filter(word => WORD.test(word));
}

const keyOf = (words: readonly string[]): string => words.join(' ');

export function buildVerbTable(registry: CommandRegistry): VerbTable {
  const held = new Map<string, VerbEntry>();
  const conflicts: VerbConflict[] = [];
  const add = (entry: VerbEntry): void => {
    const key = keyOf(entry.words);
    const known = held.get(key);
    if (known !== undefined) conflicts.push({ line: entry.line, owner: entry.owner, keptFrom: known.owner });
    else held.set(key, entry);
  };
  for (const shell of SHELL_VERB_LINES)
    add({ words: verbWords(shell.verb), line: shell.verb, owner: 'shell', summary: shell.summary });
  for (const plugin of registry.plugins)
    for (const decl of declaredVerbs(plugin)) {
      const words = verbWords(decl.verb);
      if (words.length === 0) continue;
      add({
        words,
        line: decl.verb,
        owner: plugin.id,
        ...(decl.summary === undefined ? {} : { summary: decl.summary }),
        ...(decl.alias === undefined ? {} : { alias: decl.alias }),
      });
    }
  return { entries: [...held.values()], conflicts };
}

const declaredVerbs = (plugin: RegistryEntry): readonly VerbDecl[] => plugin.manifest.actions?.cli ?? [];

export type Resolution =
  | { readonly kind: 'verb'; readonly entry: VerbEntry; readonly rest: readonly string[] }
  | { readonly kind: 'unknown'; readonly typed: readonly string[]; readonly nearby: readonly VerbEntry[] };

/** Matches the longest run of leading words that names a verb. Words after the run are the verb's arguments. */
export function resolveVerb(table: VerbTable, tokens: readonly string[]): Resolution {
  const leading: string[] = [];
  for (const token of tokens) {
    if (token.startsWith('-')) break;
    leading.push(token);
  }
  for (let length = leading.length; length > 0; length -= 1) {
    const key = keyOf(leading.slice(0, length));
    const entry = table.entries.find(candidate => keyOf(candidate.words) === key);
    if (entry !== undefined) return { kind: 'verb', entry, rest: tokens.slice(length) };
  }
  const first = leading[0];
  const nearby = first === undefined ? [] : table.entries.filter(entry => entry.words[0] === first);
  return { kind: 'unknown', typed: leading, nearby };
}

/** Expands a data plugin's alias into the verb line it runs, once. Returns the tokens to resolve again. */
export function expandAlias(entry: VerbEntry, rest: readonly string[]): readonly string[] | undefined {
  if (entry.alias === undefined) return undefined;
  return [...entry.alias.trim().split(/\s+/u), ...rest];
}

/** `fy --help`: the shell's verbs, then each plugin's, one line each. */
export function renderHelp(binary: string, table: VerbTable, titles: Readonly<Record<string, string>>): string {
  const lines = [`Usage: ${binary} <verb> [arguments] [--option value]`, ''];
  const owners = [...new Set(table.entries.map(entry => entry.owner))];
  for (const owner of owners) {
    lines.push(owner === 'shell' ? 'The shell' : (titles[owner] ?? owner));
    for (const entry of table.entries.filter(candidate => candidate.owner === owner)) {
      const verb = entry.words.join(' ').padEnd(24);
      lines.push(`  ${verb}${entry.summary ?? ''}`.trimEnd());
    }
    lines.push('');
  }
  lines.push(`  --version        print the version`, `  --help           print this list`);
  return lines.join('\n');
}
