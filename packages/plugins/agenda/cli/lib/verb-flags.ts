import type { VerbInvocation } from '@ferretry/kernel/manifest';
import type {
  AgendaAddOptions,
  AgendaEditOptions,
  AgendaLogOptions,
  AgendaPatchOptions,
  AgendaResolveOptions,
  AgendaRestOptions,
  AgendaSnoozeOptions,
  AgendaSplitOptions,
  AgendaStepOptions,
  AgendaSurfaceOptions,
} from './controller.ts';

/** Every flag any item verb reads, as the controller's options name them: a verb reads only the ones it knows. */
export type Flags = AgendaAddOptions &
  AgendaEditOptions &
  AgendaSplitOptions &
  AgendaResolveOptions &
  AgendaSnoozeOptions &
  AgendaSurfaceOptions &
  AgendaLogOptions &
  AgendaRestOptions &
  AgendaPatchOptions &
  AgendaStepOptions;

/**
 * Every flag any `fy agenda` item verb takes, once: the camelCase name the controller's options use, the long flag, the
 * short one v4 spelled, and whether it is a word, a repeated word, or a switch. One table, so a flag means the same on
 * every verb that takes it (`--why` on add, rest and surface; `--now` on edit, patch and surface).
 *
 * The shell's own reading of a verb's words (`--name word` is a value) cannot know which flag is a switch, so this reads the
 * words as typed (`invocation.raw`) and each verb's table below says what it takes.
 */
type Kind = 'text' | 'list' | 'switch';
interface Flag {
  readonly name: string;
  readonly long: string;
  readonly short?: string;
  readonly kind: Kind;
}

const text = (name: string, long: string, short?: string): Flag => ({
  name,
  long,
  kind: 'text',
  ...(short === undefined ? {} : { short }),
});
const list = (name: string, long: string, short?: string): Flag => ({
  name,
  long,
  kind: 'list',
  ...(short === undefined ? {} : { short }),
});
const on = (name: string, long: string): Flag => ({ name, long, kind: 'switch' });

const FLAGS: readonly Flag[] = [
  text('title', 'title', 't'),
  text('ask', 'ask'),
  text('summary', 'summary'),
  text('kind', 'kind', 'k'),
  text('up', 'up'),
  text('upWhy', 'up-why'),
  text('task', 'task'),
  text('related', 'related'),
  text('new', 'new'),
  text('why', 'why', 'w'),
  text('resolve', 'resolve', 'r'),
  text('recommend', 'recommend'),
  text('recommendWhy', 'recommend-why'),
  text('urgency', 'urgency'),
  text('willBlock', 'will-block'),
  text('by', 'by'),
  text('confirms', 'confirms'),
  text('stage', 'stage'),
  text('detail', 'detail'),
  text('bodyFile', 'body-file'),
  text('whereFile', 'where-file'),
  text('jsonFile', 'json-file'),
  text('questionAnswer', 'question-answer'),
  text('moveCards', 'move-cards'),
  text('reply', 'reply'),
  text('rest', 'rest'),
  text('message', 'message'),
  text('note', 'note', 'n'),
  text('reason', 'reason'),
  text('choice', 'choice'),
  text('clarify', 'clarify'),
  text('answer', 'answer'),
  text('other', 'other'),
  text('for', 'for'),
  text('until', 'until'),
  text('file', 'file', 'f'),
  text('tab', 'tab'),
  list('option', 'option', 'o'),
  list('optionDetail', 'option-detail'),
  list('field', 'field'),
  list('premise', 'premise'),
  list('context', 'context', 'c'),
  list('decided', 'decided'),
  list('stillOpen', 'still-open'),
  list('term', 'term'),
  list('question', 'question', 'q'),
  list('impact', 'impact'),
  list('link', 'link', 'l'),
  list('step', 'step'),
  list('where', 'where'),
  list('tabFile', 'tab-file'),
  list('renameTab', 'rename-tab'),
  list('moveTab', 'move-tab'),
  list('removeTab', 'remove-tab'),
  on('json', 'json'),
  on('offerClose', 'offer-close'),
  on('todo', 'todo'),
  on('blocking', 'blocking'),
  on('notBlocking', 'not-blocking'),
  on('clearWillBlock', 'clear-will-block'),
  on('clearBy', 'clear-by'),
  on('clearQuestionAnswer', 'clear-question-answer'),
  on('now', 'now'),
  on('undo', 'undo'),
  on('yaml', 'yaml'),
  on('approve', 'approve'),
  on('reject', 'reject'),
  on('yes', 'yes'),
  on('no', 'no'),
  on('good', 'good'),
];

// The flags of the verbs that are not item verbs, and the target of one: they live in the same table so one word means one thing.
const EXTRA: readonly Flag[] = [
  text('session', 'session', 's'),
  text('ferret', 'ferret'),
  text('limit', 'limit'),
  text('after', 'after'),
  on('agents', 'agents'),
  on('dryRun', 'dry-run'),
];

const BY_LONG = new Map<string, Flag>([...FLAGS, ...EXTRA].map(flag => [flag.long, flag]));
const BY_SHORT = new Map<string, Flag>(
  [...FLAGS, ...EXTRA].flatMap(flag => (flag.short === undefined ? [] : [[flag.short, flag] as const])),
);

/** What one verb takes: the flags it knows (besides `--json` and the target), and how many words it wants. */
interface Grammar {
  /** The long names of its flags. */
  readonly flags: readonly string[];
  readonly min: number;
  /** Undefined: any number of words (`add`'s ask, `answer`'s text). */
  readonly max?: number;
  /** What `fy agenda <usage>` says when the words are wrong. */
  readonly usage: string;
}

const DONE = ['note', 'reason', 'approve', 'reject', 'choice', 'yes', 'no', 'good', 'clarify', 'answer', 'other'];
const WRITING = [
  'title',
  'premise',
  'context',
  'decided',
  'still-open',
  'term',
  'question',
  'kind',
  'option',
  'option-detail',
  'field',
  'recommend',
  'recommend-why',
  'impact',
  'urgency',
  'link',
  'step',
  'body-file',
  'where-file',
  'tab-file',
  'blocking',
  'will-block',
  'by',
  'stage',
  'where',
  'detail',
];

/** v4's registration, verb by verb: the flags each took, and the words each wanted. */
const GRAMMARS = {
  add: {
    flags: [
      ...WRITING,
      'ask',
      'summary',
      'up',
      'up-why',
      'task',
      'offer-close',
      'todo',
      'related',
      'new',
      'why',
      'resolve',
      'confirms',
      'json-file',
    ],
    min: 0,
    usage: 'add --title "<what>" "<the ask>" …',
  },
  edit: {
    flags: [
      ...WRITING,
      'summary',
      'rename-tab',
      'move-tab',
      'remove-tab',
      'question-answer',
      'clear-question-answer',
      'not-blocking',
      'clear-will-block',
      'clear-by',
      'now',
    ],
    min: 1,
    max: 1,
    usage: 'edit <id> [flags]',
  },
  answer: { flags: [], min: 2, usage: 'answer <id> "<text>"' },
  rest: { flags: ['why'], min: 1, max: 1, usage: 'rest <id> --why "<what you are doing>"' },
  log: { flags: ['reply', 'rest', 'message'], min: 1, max: 1, usage: 'log <id> --reply "<text>" | --rest "<text>"' },
  merge: { flags: [], min: 2, max: 2, usage: 'merge <into> <from>' },
  split: {
    flags: [
      'title',
      'premise',
      'context',
      'decided',
      'still-open',
      'kind',
      'stage',
      'move-cards',
      'body-file',
      'json-file',
    ],
    min: 2,
    usage: 'split <id> --title "<what>" "<the new ask>" …',
  },
  step: { flags: ['undo'], min: 2, max: 2, usage: 'step <id> <n> [--undo]' },
  show: { flags: ['tab', 'yaml'], min: 1, max: 1, usage: 'show <id> [--tab <name>] [--yaml]' },
  patch: { flags: ['file', 'now'], min: 1, max: 1, usage: 'patch <id> [--file <path>]' },
  ls: { flags: [], min: 0, max: 0, usage: 'ls' },
  history: { flags: [], min: 0, max: 0, usage: 'history' },
  'needs-info': { flags: ['note'], min: 1, max: 1, usage: 'needs-info <id> [--note <text>]' },
  discuss: { flags: ['note'], min: 1, max: 1, usage: 'discuss <id> [--note <text>]' },
  surface: { flags: ['why', 'now'], min: 1, max: 1, usage: 'surface <id> [--why <line>] [--now]' },
  snooze: { flags: ['for', 'until'], min: 1, max: 1, usage: 'snooze <id> --for <time> | --until <time>' },
  unsnooze: { flags: [], min: 1, max: 1, usage: 'unsnooze <id>' },
  'send-now': { flags: [], min: 0, max: 0, usage: 'send-now' },
  done: { flags: DONE, min: 1, max: 1, usage: 'done <id> [answer flags]' },
  dismiss: { flags: ['note'], min: 1, max: 1, usage: 'dismiss <id> [--note <text>]' },
  open: { flags: ['limit', 'after'], min: 0, max: 0, usage: 'open [--limit <n>] [--after <cursor>]' },
  roll: { flags: ['limit', 'after'], min: 0, max: 0, usage: '[--limit <n>] [--after <cursor>]' },
  mode: { flags: ['ferret'], min: 0, max: 1, usage: 'mode [on|off] --ferret <id>' },
  clear: { flags: ['agents', 'yes', 'dry-run'], min: 0, max: 0, usage: 'clear --agents [--dry-run] [--yes]' },
} as const satisfies Record<string, Grammar>;

export type GrammarName = keyof typeof GRAMMARS;

const NOT_ITEM_VERBS: readonly GrammarName[] = ['open', 'roll', 'mode', 'clear'];

const optionTokens = (name: string): string => (name.length === 1 ? `-${name}` : `--${name}`);

/** The words after a verb in the order they were typed: the shell's `raw`, or rebuilt from its reading when a caller has only that. */
function rawOf(invocation: VerbInvocation): readonly string[] {
  if (invocation.raw !== undefined) return invocation.raw;
  const tokens: string[] = [];
  for (const [name, value] of Object.entries(invocation.options)) {
    if (value === false) continue;
    if (value === true) tokens.push(optionTokens(name));
    else for (const each of typeof value === 'string' ? [value] : value) tokens.push(optionTokens(name), each);
  }
  return invocation.args.length === 0 ? tokens : [...tokens, '--', ...invocation.args];
}

const display = (flag: Flag): string => `--${flag.long}${flag.kind === 'switch' ? '' : ' <value>'}`;

export type Read =
  | { readonly ok: true; readonly flags: Flags; readonly args: readonly string[]; readonly ferret?: string }
  | { readonly ok: false; readonly message: string };

/**
 * One verb's flags and words, read in the order typed. A flag the verb does not know, a word where a flag wants its value
 * and a different number of words than the verb takes are each refused with a sentence: nothing is ignored. A switch
 * never takes the word after it, so `answer A1 --json A2` is the answer "A2" on A1.
 */
export function readVerb(verb: GrammarName, invocation: VerbInvocation): Read {
  const grammar: Grammar = GRAMMARS[verb];
  // An item verb acts on a board, so it also takes `--session` / `-s` / `--ferret`; the others have no board to name.
  const onBoard = !NOT_ITEM_VERBS.includes(verb);
  const allowed = new Set<string>(['json', ...(onBoard ? ['session', 'ferret'] : []), ...grammar.flags]);
  const said = verb === 'roll' ? 'fy agenda' : `fy agenda ${verb}`;
  const refuse = (reason: string): Read => ({
    ok: false,
    message: `${said}: ${reason}\nusage: fy agenda ${grammar.usage}`,
  });
  const tokens = rawOf(invocation);
  const given = new Map<string, string | boolean | string[]>();
  const args: string[] = [];
  for (let at = 0; at < tokens.length; at += 1) {
    const token = tokens[at] as string;
    if (token === '--') {
      args.push(...tokens.slice(at + 1));
      break;
    }
    if (!token.startsWith('-') || token === '-') {
      args.push(token);
      continue;
    }
    const body = token.replace(/^-{1,2}/u, '');
    const equals = body.indexOf('=');
    const name = equals < 0 ? body : body.slice(0, equals);
    let flag = token.startsWith('--') ? BY_LONG.get(name) : BY_SHORT.get(name);
    let off = false;
    if (flag === undefined && token.startsWith('--no-')) {
      const positive = BY_LONG.get(name.slice(3));
      if (positive?.kind === 'switch') {
        flag = positive;
        off = true;
      }
    }
    if (flag === undefined || !allowed.has(flag.long))
      return refuse(
        `unknown option ${token.split('=')[0]}; it takes ${[...allowed].map(each => `--${each}`).join(', ')}`,
      );
    if (flag.kind === 'switch') {
      const value = equals < 0 ? undefined : body.slice(equals + 1);
      if (value !== undefined && value !== 'true' && value !== 'false')
        return refuse(`${display(flag)} is a switch and takes no value, not "${value}"`);
      if (off || value === 'false') given.delete(flag.name);
      else given.set(flag.name, true);
      continue;
    }
    let value: string | undefined;
    if (equals >= 0) value = body.slice(equals + 1);
    else {
      value = tokens[at + 1];
      at += 1;
    }
    if (value === undefined) return refuse(`${display(flag)} needs a value`);
    const kept = given.get(flag.name);
    if (flag.kind === 'list') given.set(flag.name, [...(Array.isArray(kept) ? kept : []), value]);
    else given.set(flag.name, value);
  }
  if (args.length < grammar.min) return refuse(`it needs ${describeWords(grammar.min)}, not ${args.length}`);
  if (grammar.max !== undefined && args.length > grammar.max)
    return refuse(`it takes ${describeWords(grammar.max)}, not ${args.length} (${args.join(' ')})`);
  const flags: Record<string, string | boolean | readonly string[]> = Object.fromEntries(given);
  // `--session`, `-s` and `--ferret` all name the board to act on; `mode` alone reads `--ferret` as the ferret to switch.
  const board = [given.get('session'), verb === 'mode' ? undefined : given.get('ferret')].find(
    (value): value is string => typeof value === 'string' && value.trim() !== '',
  );
  if (board !== undefined) flags.session = board;
  const ferret = given.get('ferret');
  return { ok: true, flags: flags as unknown as Flags, args, ...(typeof ferret === 'string' ? { ferret } : {}) };
}

const describeWords = (count: number): string => (count === 1 ? 'one word' : `${count} words`);
