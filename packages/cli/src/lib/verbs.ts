/**
 * The verb table: every verb line the registry's manifests declare, plus the shell's own, resolved by the
 * longest run of leading words (`card move` beats `card`). Pure.
 */
import type { VerbArgDecl, VerbDecl, VerbOptionDecl } from '@ferretry/kernel/manifest';
import type { CommandRegistry, RegistryEntry } from './registry.ts';

/** One verb line the shell owns, with what its `--help` lists. */
interface ShellVerbLine {
  readonly verb: string;
  readonly summary: string;
  readonly args: readonly VerbArgDecl[];
  readonly options?: readonly VerbOptionDecl[];
}

const JSON_OPTION = { flag: '--json', help: 'print the answer as JSON' } as const;
const DRY_RUN = { flag: '--dry-run', help: 'show what would change and change nothing' } as const;
const YES = { flag: '-y, --yes', help: 'skip the question and go ahead' } as const;
const PLUGIN_ID: VerbArgDecl = { name: 'id', help: 'the plugin id (see `plugin list`)' };

/** The shell owns exactly these verb lines (§1.4). A plugin may add others under the same first word. */
const SHELL_VERB_LINES: readonly ShellVerbLine[] = [
  { verb: 'plugin list', summary: 'every plugin: on or off, version, what it adds and what needs it', args: [] },
  { verb: 'plugin show', summary: 'one plugin in words: actions, screens, hooks, permissions', args: [PLUGIN_ID] },
  {
    verb: 'plugin on',
    summary: 'turn a plugin on',
    args: [PLUGIN_ID],
    options: [{ flag: '--with-needs', help: 'also turn on the plugins it needs that are off' }],
  },
  {
    verb: 'plugin off',
    summary: 'turn a plugin off (names what depends on it first)',
    args: [PLUGIN_ID],
    options: [{ flag: '--with-dependents', help: 'also turn off the running plugins that need it' }],
  },
  {
    verb: 'plugin add',
    summary: 'install a data plugin from a folder, git address or share link',
    args: [{ name: 'source', help: 'a folder, a git address or a share link' }],
  },
  { verb: 'plugin remove', summary: 'remove a data plugin', args: [PLUGIN_ID] },
  {
    verb: 'plugin check',
    summary: 'run the data-plugin checks on a folder without installing',
    args: [{ name: 'folder', help: 'the plugin folder to check' }],
  },
  {
    verb: 'words',
    summary: 'print a word, its owner and the words it replaced',
    args: [{ name: 'word', help: 'the word to look up; all of them when left out', optional: true }],
  },
  { verb: 'doctor', summary: 'check this fy against the daemon, plugin by plugin', args: [] },
  {
    verb: 'daemon status',
    summary: 'is the daemon up, which build, which plugins agree',
    args: [],
    options: [JSON_OPTION],
  },
  { verb: 'daemon start', summary: 'start the daemon now (any other command starts it by itself)', args: [] },
  { verb: 'daemon stop', summary: 'stop the daemon and wait until it has released its address', args: [] },
  {
    verb: 'daemon restart',
    summary: 'stop the daemon, wait for it to go quiet, then start it again; ferrets keep running',
    args: [],
    options: [{ flag: '--when-idle', help: 'wait until every turn has finished before restarting' }],
  },
  { verb: 'daemon install', summary: 'install the user service definition and start the daemon under it', args: [] },
  { verb: 'daemon uninstall', summary: 'stop the daemon and remove its user service definition', args: [] },
  {
    verb: 'daemon logs',
    summary: 'print the daemon log',
    args: [],
    options: [{ flag: '-f, --follow', help: 'keep printing as the log grows' }],
  },
  {
    verb: 'daemon which',
    summary: 'show the installed and currently running daemon identities',
    args: [],
    options: [JSON_OPTION],
  },
  {
    verb: 'daemon reset',
    summary: 'stop the daemon and remove ALL of its persistent data on this host',
    args: [],
    options: [{ flag: '-y, --yes', help: 'skip the typed word' }],
  },
  {
    verb: 'update',
    summary: 'update this machine, restart its daemon, and roll back if the new version does not serve',
    args: [],
    options: [
      { flag: '--check', help: 'say what an update would do and change nothing' },
      { flag: '--to <version>', help: 'update to this exact version' },
      { flag: '--major', help: 'allow a jump to a new major version' },
      YES,
      { flag: '--when-idle', help: 'wait until every turn has finished before restarting the daemon' },
      { flag: '--switch-to-profile', help: 'move a nix-shell install onto the nix profile' },
      { flag: '--report <file>', help: 'write the result of the update to this file' },
      JSON_OPTION,
    ],
  },
  {
    verb: 'machine',
    summary: 'this machine: its tools, its agent permissions, export and clone',
    args: [],
    options: [JSON_OPTION],
  },
  {
    verb: 'machine set',
    summary: 'change a machine setting',
    args: [
      {
        name: 'setting',
        help: 'agent-permissions, default-runtime, agent-control, auto-resume or agenda-mode',
      },
      {
        name: 'value',
        help: 'auto|skip; <runtime>|automatic; terminals|browsers|files|settings|scripts on|off; on|off',
        variadic: true,
      },
    ],
    options: [DRY_RUN, YES, JSON_OPTION],
  },
  {
    verb: 'machine install',
    summary: 'install Claude Code or Codex on this machine (shows the command first)',
    args: [{ name: 'tool', help: 'claude, codex or both', variadic: true }],
    options: [DRY_RUN, YES, JSON_OPTION],
  },
  {
    verb: 'machine export',
    summary: "print this machine's setup for `machine clone`: no login and no history",
    args: [],
  },
  {
    verb: 'machine clone',
    summary: 'copy a setup exported from another machine; a repeat copy is an update that shows only what differs',
    args: [{ name: 'file', help: 'the exported setup file; leave out with --forget', optional: true }],
    options: [
      DRY_RUN,
      YES,
      JSON_OPTION,
      { flag: '--replace', help: 'make this machine match the export, removing what it does not list' },
      { flag: '--alongside', help: 'add the exported setup next to this machine’s own' },
      { flag: '--skip <item>', help: 'leave one item out; repeat for more' },
      { flag: '--theirs <item>', help: 'on a difference, take the export’s version; repeat for more' },
      { flag: '--mine <item>', help: 'on a difference, keep this machine’s version; repeat for more' },
      { flag: '--remove <item>', help: 'remove one item this machine holds that the export does not; repeat for more' },
      {
        flag: '--login <mapping>',
        help: 'answer where a login of the export goes: <source login>=<login here> uses a login this machine has, <source login>=slot makes a new empty one; repeat for each login',
      },
      { flag: '--forget <name>', help: 'forget a past clone from that source, then stop' },
    ],
  },
  {
    verb: 'ask',
    summary: 'list the asks waiting for an answer, and answer one',
    args: [
      { name: 'action', help: 'list (the default) or answer', optional: true },
      { name: 'ask', help: 'the ask to answer (with answer)', optional: true },
      { name: 'text', help: 'the answer, in words (with answer)', optional: true, variadic: true },
    ],
    options: [
      { flag: '--approve', help: 'approve a permission ask' },
      { flag: '--reject', help: 'reject a permission ask' },
      { flag: '--yes', help: 'answer Yes to a yes/no ask' },
      { flag: '--no', help: 'answer No to a yes/no ask' },
      { flag: '--choice <label>', help: 'pick one listed option by its label' },
      { flag: '--good', help: 'mark an answer review as good' },
      { flag: '--clarify <text>', help: 'mark an answer review as needing clarification, and say what' },
      { flag: '--other <text>', help: 'answer with something that is not a listed option' },
      { flag: '--answer <text>', help: 'answer an open question in words' },
      { flag: '--done', help: 'close the ask without a response' },
    ],
  },
  {
    verb: 'statusline',
    summary: "record a Claude runtime's usage from its status line, then run your own status line command",
    args: [],
    options: [{ flag: '--then <command>', help: 'your own statusLine command, run with the same input' }],
  },
];

/**
 * The spellings today's `fy` had for verbs the 5.0 split renamed, each running the verb that replaced it (v4 parity: a
 * person's habit, a script and an agent's old instructions still work). Thin by design: the alias adds no behaviour, no
 * option and no help of its own, and every word after it is handed to the new verb. The docs/design/rebuild-parity.tsv
 * rows name the old and the new spelling together (V-0232, V-0241, V-0245 … V-0248, V-0250, V-0436).
 */
const SHELL_ALIAS_LINES = [
  { verb: 'daemon tunnel', alias: 'tunnel' },
  { verb: 'daemon update', alias: 'update' },
  { verb: 'daemon setup', alias: 'onboard' },
  { verb: 'daemon import', alias: 'runtime link' },
  { verb: 'setup', alias: 'onboard' },
] as const satisfies readonly { readonly verb: string; readonly alias: string }[];

export interface VerbEntry {
  /** The words a person types, in order. */
  readonly words: readonly string[];
  /** The declared verb line: also the key of the plugin half's `verbs` record. */
  readonly line: string;
  /** The plugin that declares it, or `shell` for the shell's own. */
  readonly owner: string;
  readonly summary?: string;
  /** The arguments its `--help` lists; absent means the placeholders of the verb line, without a sentence. */
  readonly args?: readonly VerbArgDecl[];
  /** The options its `--help` lists. */
  readonly options?: readonly VerbOptionDecl[];
  /** An alias (a data plugin's, or one of the shell's old spellings): the verb line it runs. */
  readonly alias?: string;
  /** Declared the default of its group: the bare group runs it. */
  readonly default?: true;
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
    add({
      words: verbWords(shell.verb),
      line: shell.verb,
      owner: 'shell',
      summary: shell.summary,
      args: shell.args,
      ...(shell.options === undefined ? {} : { options: shell.options }),
    });
  for (const old of SHELL_ALIAS_LINES)
    add({
      words: verbWords(old.verb),
      line: old.verb,
      owner: 'shell',
      summary: `the old spelling of \`${old.alias}\``,
      args: [
        {
          name: 'words',
          help: `whatever \`${old.alias}\` takes: every word is handed to it`,
          optional: true,
          variadic: true,
        },
      ],
      alias: old.alias,
    });
  for (const plugin of registry.plugins)
    for (const decl of declaredVerbs(plugin)) {
      const words = verbWords(decl.verb);
      if (words.length === 0) continue;
      add({
        words,
        line: decl.verb,
        owner: plugin.id,
        ...(decl.summary === undefined ? {} : { summary: decl.summary }),
        ...(decl.args === undefined ? {} : { args: decl.args }),
        ...(decl.options === undefined ? {} : { options: decl.options }),
        ...(decl.alias === undefined ? {} : { alias: decl.alias }),
        ...(decl.default === true ? { default: true as const } : {}),
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

/** The verb a group declares its default (`catalog ls` for `catalog`), when it declares one among its direct children. */
const defaultBelow = (table: VerbTable, words: readonly string[]): VerbEntry | undefined =>
  table.entries.find(
    candidate =>
      candidate.default === true &&
      candidate.words.length === words.length + 1 &&
      words.every((word, at) => candidate.words[at] === word),
  );

/** Whether a default takes words of its own (`account site ls [account]`): declared `args`, or placeholders in its line. */
const defaultTakesWords = (entry: VerbEntry): boolean => (entry.args?.length ?? 0) > 0 || takesArguments(entry);

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
    // Words that are no verb but front a group which declares a default sub-verb are walked like a verb that has sub-verbs.
    if (found === undefined && defaultBelow(table, leading.slice(0, length)) === undefined) continue;
    let current: VerbEntry | undefined = found;
    let words: readonly string[] = found?.words ?? leading.slice(0, length);
    let rest = tokens.slice(length);
    for (;;) {
      if (current?.alias !== undefined) return { kind: 'verb', entry: current, rest };
      const subverbs = subverbsBelow(table, words);
      if (subverbs.length === 0 && current !== undefined) return { kind: 'verb', entry: current, rest };
      const at = firstWord(rest, valuedOptions(current));
      if (at === undefined) {
        if (current !== undefined) return { kind: 'verb', entry: current, rest };
        // A bare group (`fy catalog`) runs the sub-verb it declares its default, with whatever flags were typed.
        const chosen = defaultBelow(table, words);
        if (chosen !== undefined) return { kind: 'verb', entry: chosen, rest };
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
      // A group whose default takes words of its own (v4: `fy account site GITHUB` is `account site ls GITHUB`) hands it a word
      // that names no sub-verb, as the verb that takes words does; a near misspelling of a real sub-verb is still refused,
      // so a mutating child never runs by a typo, and past a bare `--` every word is the default's own.
      const chosen = current === undefined ? defaultBelow(table, words) : undefined;
      if (chosen !== undefined && defaultTakesWords(chosen)) {
        if (rest.slice(0, at).includes('--')) return { kind: 'verb', entry: chosen, rest };
        const likely = subverbs.find(candidate => nearly(word, candidate.words[words.length] as string));
        if (likely === undefined) return { kind: 'verb', entry: chosen, rest };
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
