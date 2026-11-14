/**
 * The verb table: every verb line the registry's manifests declare, plus the shell's own, resolved by the
 * longest run of leading words (`card move` beats `card`). Pure.
 */
import type { VerbDecl, VerbOptionDecl } from '@ferretry/kernel/manifest';
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
  { verb: 'machine', summary: 'this machine: its tools, its agent permissions, export and clone (--json)' },
  {
    verb: 'machine set',
    summary:
      'change a machine setting: agent-permissions auto|skip, default-runtime <name>|automatic, agent-control terminals|browsers|files|settings|scripts on|off, auto-resume on|off, agenda-mode on|off',
  },
  { verb: 'machine install', summary: 'install Claude Code or Codex on this machine (shows the command first)' },
  { verb: 'machine export', summary: "print this machine's setup for `machine clone`: no login and no history" },
  {
    verb: 'machine clone',
    summary:
      'copy a setup exported from another machine; a repeat copy is an update that shows only what differs (--dry-run to look first)',
  },
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
  /** The options its `--help` lists. */
  readonly options?: readonly VerbOptionDecl[];
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
        ...(decl.options === undefined ? {} : { options: decl.options }),
        ...(decl.alias === undefined ? {} : { alias: decl.alias }),
      });
    }
  return { entries: [...held.values()], conflicts };
}

const declaredVerbs = (plugin: RegistryEntry): readonly VerbDecl[] => plugin.manifest.actions?.cli ?? [];

export type Resolution =
  | { readonly kind: 'verb'; readonly entry: VerbEntry; readonly rest: readonly string[] }
  | { readonly kind: 'unknown'; readonly typed: readonly string[]; readonly nearby: readonly VerbEntry[] }
  /**
   * A known verb that has sub-verbs, and a word where its sub-verb belongs that is none of them (or no word at all, for a
   * run of words that only leads to sub-verbs: `board lanes`). `word` is absent when nothing was typed after `parent`.
   */
  | {
      readonly kind: 'subverb';
      readonly parent: { readonly words: readonly string[] };
      readonly word?: string;
      readonly subverbs: readonly VerbEntry[];
      /** A sub-verb the word is probably a misspelling of, for a verb that takes words of its own (`voice enhnace`). */
      readonly didYouMean?: VerbEntry;
    };

/** Whether a declared verb line names arguments of its own (`voice [text...]`, `show <id>`). */
const takesArguments = (entry: VerbEntry): boolean => /[<[]/u.test(entry.line);

/** The verbs below these words, at any depth (`agenda open` and `agenda add` under `agenda`). */
const subverbsBelow = (table: VerbTable, words: readonly string[]): readonly VerbEntry[] =>
  table.entries.filter(
    candidate => candidate.words.length > words.length && words.every((word, at) => candidate.words[at] === word),
  );

/**
 * The options of a verb that take a value, by name, as its manifest declares them (`-w, --why <line>` names `w` and
 * `why`; `--good | --clarify <text>` names `clarify` only). Every other option is a switch: the word after it is not its
 * value, so a switch before a sub-verb (`agenda --json add`) does not hide the sub-verb.
 */
function valuedOptions(entry: VerbEntry | undefined): ReadonlySet<string> {
  const valued = new Set<string>();
  for (const option of entry?.options ?? [])
    for (const alternative of option.flag.split('|')) {
      if (!alternative.includes('<')) continue;
      for (const part of alternative.split(','))
        valued.add(
          part
            .trim()
            .split(/\s+/u)[0]
            ?.replace(/^-{1,2}/u, '') ?? '',
        );
    }
  return valued;
}

/**
 * Where, in the words after a verb, its sub-verb is: the first word that is neither an option nor the value of one the
 * verb declares takes a value, or the first word after a bare `--`. Undefined when there is none.
 */
function firstWord(rest: readonly string[], valued: ReadonlySet<string>): number | undefined {
  for (let at = 0; at < rest.length; at += 1) {
    const token = rest[at] as string;
    if (token === '--') return at + 1 < rest.length ? at + 1 : undefined;
    if (token.startsWith('-') && token !== '-') {
      if (!token.includes('=') && valued.has(token.replace(/^-{1,2}/u, ''))) at += 1;
      continue;
    }
    return at;
  }
  return undefined;
}

/** Whether two words are within two edits (a swap counts as two): a typo of a sub-verb, not another word. */
function nearly(typed: string, word: string): boolean {
  if (typed === word || typed.length < 4 || Math.abs(typed.length - word.length) > 2) return false;
  let previous = Array.from({ length: word.length + 1 }, (_, at) => at);
  for (let row = 1; row <= typed.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= word.length; column += 1)
      current.push(
        Math.min(
          (previous[column] as number) + 1,
          (current[column - 1] as number) + 1,
          (previous[column - 1] as number) + (typed[row - 1] === word[column - 1] ? 0 : 1),
        ),
      );
    previous = current;
  }
  return (previous[word.length] as number) <= 2;
}

/**
 * Matches the longest run of leading words that names a verb, then keeps going down its sub-verbs: the word where a
 * sub-verb belongs is found past any options (`agenda --json add x` is `agenda add --json x`, `daemon config --json --
 * frobnicate` is a sub-verb that does not exist). A verb with sub-verbs and no arguments of its own never reads that word
 * as an argument: running the parent with it would exit 0 having done nothing it was asked. The shell cannot see which of
 * a parent's options take a value except through the manifest's declared options, so a parent declares the valued ones.
 *
 * A verb that takes words of its own (`voice [text...]`, `queue <ferret>`) keeps a word that is not a sub-verb as its
 * argument, unless it is a near misspelling of one (`voice enhnace`): the verb's own handler owns what its words mean.
 */
export function resolveVerb(table: VerbTable, tokens: readonly string[]): Resolution {
  const leading: string[] = [];
  for (const token of tokens) {
    if (token.startsWith('-')) break;
    leading.push(token);
  }
  for (let length = leading.length; length > 0; length -= 1) {
    const key = keyOf(leading.slice(0, length));
    const found = table.entries.find(candidate => keyOf(candidate.words) === key);
    if (found === undefined) continue;
    let current: VerbEntry | undefined = found;
    let words: readonly string[] = found.words;
    let rest = tokens.slice(length);
    for (;;) {
      if (current?.alias !== undefined) return { kind: 'verb', entry: current, rest };
      const subverbs = subverbsBelow(table, words);
      if (subverbs.length === 0 && current !== undefined) return { kind: 'verb', entry: current, rest };
      const at = firstWord(rest, valuedOptions(current));
      if (at === undefined) {
        if (current !== undefined) return { kind: 'verb', entry: current, rest };
        return { kind: 'subverb', parent: { words }, subverbs };
      }
      const word = rest[at] as string;
      const next = [...words, word];
      const child = table.entries.find(candidate => keyOf(candidate.words) === keyOf(next));
      if (child !== undefined || subverbsBelow(table, next).length > 0) {
        current = child;
        words = next;
        rest = rest.filter((_, index) => index !== at);
        continue;
      }
      if (current !== undefined && takesArguments(current)) {
        // Past a bare `--` every word is the verb's own.
        if (rest.slice(0, at).includes('--')) return { kind: 'verb', entry: current, rest };
        const likely = subverbs.find(candidate => nearly(word, candidate.words[words.length] as string));
        if (likely === undefined) return { kind: 'verb', entry: current, rest };
        return { kind: 'subverb', parent: { words }, word, subverbs, didYouMean: likely };
      }
      return { kind: 'subverb', parent: { words }, word, subverbs };
    }
  }
  const around = resolveAroundOptions(table, tokens);
  if (around !== undefined) return around;
  const first = leading[0];
  const nearby = first === undefined ? [] : table.entries.filter(entry => entry.words[0] === first);
  return { kind: 'unknown', typed: leading, nearby };
}

/** How an option is written in a declared flag (`-s, --session, --ferret <id>`): its names, and whether it takes a value. */
function declaredFlag(flag: string): { readonly names: readonly string[]; readonly takesValue: boolean } {
  const names = [...flag.matchAll(/(?:^|[ ,])-{1,2}([a-z][a-z0-9-]*)/gu)].map(match => match[1] as string);
  return { names, takesValue: flag.includes('<') };
}

const optionName = (token: string): string => token.replace(/^-{1,2}/u, '').split('=')[0] as string;
const isOptionToken = (token: string): boolean => token.startsWith('-') && token !== '-' && !/^-\d/u.test(token);

/**
 * A group's own options written BEFORE its verb (`browser --session f1 page click app`, `browser page --session f1
 * click app`): the verb line is the leading words with those options set aside, and the options keep their place in
 * front of the verb's arguments. Only options the group's verbs DECLARE as taking a value (`<id>`) swallow the word
 * after them here; any other word is read as part of the verb line, so a mistyped line still stops as an unknown verb.
 * Used only when the plain longest-run match found nothing, so no line that resolved before resolves differently.
 */
function resolveAroundOptions(table: VerbTable, tokens: readonly string[]): Resolution | undefined {
  const first = tokens[0];
  if (first === undefined || isOptionToken(first)) return undefined;
  const group = table.entries.filter(entry => entry.words[0] === first);
  const declared = group.flatMap(entry => (entry.options ?? []).map(option => declaredFlag(option.flag)));
  const takesValue = (token: string): boolean =>
    !token.includes('=') && declared.some(flag => flag.takesValue && flag.names.includes(optionName(token)));
  const words: { readonly at: number; readonly text: string }[] = [];
  let moved = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    if (token === '--') break;
    if (isOptionToken(token)) {
      // An option that is not declared ends the verb line, as it always did.
      if (!declared.some(flag => flag.names.includes(optionName(token.replace(/^--no-/u, '--'))))) break;
      moved = true;
      if (takesValue(token) && index + 1 < tokens.length) index += 1;
      continue;
    }
    words.push({ at: index, text: token });
  }
  if (!moved) return undefined;
  for (let length = words.length; length > 0; length -= 1) {
    const key = keyOf(words.slice(0, length).map(word => word.text));
    const entry = table.entries.find(candidate => keyOf(candidate.words) === key);
    if (entry === undefined) continue;
    const used = new Set(words.slice(0, length).map(word => word.at));
    return { kind: 'verb', entry, rest: tokens.filter((_, index) => !used.has(index)) };
  }
  return undefined;
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
