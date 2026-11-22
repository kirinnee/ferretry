import type { VerbInvocation } from '@ferretry/kernel/manifest';

/**
 * The flags of Agenda's own verbs (`open`, the bare roll-up, `mode`, `clear`), read in the order typed. The shell's own
 * reading of a verb's words (`--name word` is a value) cannot know which flag is a switch, so this reads the words as typed
 * (`invocation.raw`): a flag the verb does not know, a word where a flag wants its value and a different number of words
 * than the verb takes are each refused with a sentence, and a switch never takes the word after it.
 */
interface Flag {
  readonly name: string;
  readonly long: string;
  readonly kind: 'text' | 'switch';
}
const text = (name: string, long = name): Flag => ({ name, long, kind: 'text' });
const on = (name: string, long = name): Flag => ({ name, long, kind: 'switch' });

const FLAGS: readonly Flag[] = [
  on('json'),
  text('limit'),
  text('after'),
  text('ferret'),
  on('agents'),
  on('yes'),
  on('dryRun', 'dry-run'),
];
const BY_LONG = new Map(FLAGS.map(flag => [flag.long, flag]));

interface Grammar {
  readonly flags: readonly string[];
  readonly min: number;
  readonly max: number;
  readonly usage: string;
}

const GRAMMARS = {
  open: { flags: ['limit', 'after'], min: 0, max: 0, usage: 'open [--limit <n>] [--after <cursor>]' },
  roll: { flags: ['limit', 'after'], min: 0, max: 0, usage: '[--limit <n>] [--after <cursor>]' },
  mode: { flags: ['ferret'], min: 0, max: 1, usage: 'mode [on|off] --ferret <id>' },
  clear: { flags: ['agents', 'yes', 'dry-run'], min: 0, max: 0, usage: 'clear --agents [--dry-run] [--yes]' },
} as const satisfies Record<string, Grammar>;

export type GrammarName = keyof typeof GRAMMARS;

export type Read =
  | {
      readonly ok: true;
      readonly flags: Readonly<Record<string, string | boolean>>;
      readonly args: readonly string[];
      readonly ferret?: string;
    }
  | { readonly ok: false; readonly message: string };

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
const describeWords = (count: number): string => (count === 1 ? 'one word' : `${count} words`);

export function readVerb(verb: GrammarName, invocation: VerbInvocation): Read {
  const grammar: Grammar = GRAMMARS[verb];
  const allowed = new Set<string>(['json', ...grammar.flags]);
  const said = verb === 'roll' ? 'fy agenda' : `fy agenda ${verb}`;
  const refuse = (reason: string): Read => ({
    ok: false,
    message: `${said}: ${reason}\nusage: fy agenda ${grammar.usage}`,
  });
  const tokens = rawOf(invocation);
  const given = new Map<string, string | boolean>();
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
    let flag = token.startsWith('--') ? BY_LONG.get(name) : undefined;
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
    given.set(flag.name, value);
  }
  if (args.length < grammar.min) return refuse(`it needs ${describeWords(grammar.min)}, not ${args.length}`);
  if (args.length > grammar.max)
    return refuse(`it takes ${describeWords(grammar.max)}, not ${args.length} (${args.join(' ')})`);
  const ferret = given.get('ferret');
  return { ok: true, flags: Object.fromEntries(given), args, ...(typeof ferret === 'string' ? { ferret } : {}) };
}
