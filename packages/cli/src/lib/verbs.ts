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
];

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
    add({
      words: verbWords(shell.verb),
      line: shell.verb,
      owner: 'shell',
      summary: shell.summary,
      args: shell.args,
      ...(shell.options === undefined ? {} : { options: shell.options }),
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
