import type { TerminalIo, VerbHandler, VerbInvocation } from '@ferretry/kernel/manifest';
import { type ExitStatus, type OptionShape, verbHandler } from '../shell.ts';
import type { SecretController } from './secret-controller.ts';

const JSON_OPTION: OptionShape = { names: ['json'], takesValue: false };

/** The text of an option that takes a value; the last one given when it was repeated. */
function text(invocation: VerbInvocation, name: string): string | undefined {
  const value = invocation.options[name];
  if (typeof value === 'string') return value;
  return Array.isArray(value) ? (value[value.length - 1] as string | undefined) : undefined;
}

/** Every value an option was given, in the order given (`--with A --with B`, or `-w A`). */
function all(invocation: VerbInvocation, names: readonly string[]): readonly string[] {
  return names.flatMap(name => {
    const value = invocation.options[name];
    if (typeof value === 'string') return [value];
    return Array.isArray(value) ? (value as readonly string[]) : [];
  });
}

/** What `secret use` was asked to run and with which names, or the usage sentence that refuses the words. */
type UseWords =
  | {
      readonly names: readonly string[];
      readonly command: readonly string[];
      readonly cwd?: string;
      readonly timeout?: string;
      readonly json: boolean;
    }
  | { readonly refused: string };

const WITH = new Set(['with', 'w']);
const VALUE_OPTIONS = new Set(['cwd', 'timeout']);

/**
 * Reads `secret use`'s words the way v4's commander (15) did. `--with <name...>` is variadic: every word after it, up to
 * the next option or `--`, is a name. A word that is neither an option nor in that list is a command word, wherever it
 * stands before `--`; `--` ends option parsing and every word after it is a command word too, so
 * `printf -w A -- hello` runs `printf hello` and `printf -- --help` runs `printf --help`. A list that swallowed the
 * command (no command word at all) is refused, never guessed at, because running a secret's name as the program is the
 * mistake this guards against. A switch (`--json`) takes no value, so the word after it is a command word.
 */
function readUseWords(words: readonly string[]): UseWords {
  const boundary = words.indexOf('--');
  const head = boundary < 0 ? words : words.slice(0, boundary);
  const tail = boundary < 0 ? [] : words.slice(boundary + 1);
  const names: string[] = [];
  const bare: string[] = [];
  let cwd: string | undefined;
  let timeout: string | undefined;
  let json = false;
  let listing = false;
  for (let index = 0; index < head.length; index += 1) {
    const word = head[index] as string;
    if (!word.startsWith('-') || word === '-') {
      (listing ? names : bare).push(word);
      continue;
    }
    listing = false;
    const body = word.replace(/^-{1,2}/u, '');
    const equals = body.indexOf('=');
    const given = equals >= 0 ? body.slice(0, equals) : body;
    const inline = equals >= 0 ? body.slice(equals + 1) : undefined;
    if (WITH.has(given)) {
      if (inline === undefined) listing = true;
      else names.push(inline);
    } else if (VALUE_OPTIONS.has(given)) {
      const value = inline ?? head[index + 1];
      if (inline === undefined) index += 1;
      if (given === 'cwd') cwd = value;
      else timeout = value;
    } else if (given === 'json') json = inline === undefined || inline === 'true';
    else if (given === 'no-json') json = false;
  }
  const options = { ...(cwd === undefined ? {} : { cwd }), ...(timeout === undefined ? {} : { timeout }), json };
  const command = [...bare, ...tail];
  if (command.length === 0)
    return {
      refused:
        names.length === 0 || boundary >= 0
          ? "missing required argument 'command'"
          : "missing required argument 'command' (--with takes every word after it as a name: end the names with -- and write the command after it)",
    };
  return { names, command, ...options };
}

const on = (invocation: VerbInvocation, name: string): boolean => {
  const value = invocation.options[name];
  return value === true || value === 'true';
};

/**
 * Mounts `fy secret set <name>`, `ls`, `rm <name>` and `use <command...>`.
 *
 * `set` takes NO value argument. That is deliberate and it is the whole point of the command: a credential typed on a
 * command line is in the shell history of whoever typed it and readable in `/proc/<pid>/cmdline` by every account on
 * the box while it runs. The verb's shape is ONE word, the name; a second word is refused as "too many arguments" and
 * any option as "unknown option", before the controller runs (S33). The value comes in on stdin (S1).
 *
 * `use` is the verb agents are meant to reach for:
 *
 *     fy secret use --with ANTHROPIC_KEY -- curl -H "Authorization: Bearer $ANTHROPIC_KEY" https://…
 *
 * The caller writes the NAME. The daemon puts the value in the environment of the child it spawns and answers that
 * child's output with every known value masked. `--with` takes several names, or repeats, as v4's did:
 * `--with A B -- command`; the `--` is where the names end and the command begins. Without it a name list that
 * swallowed the command is refused with a usage error, never run.
 */
export function secretVerbs(
  controller: SecretController,
  io: Pick<TerminalIo, 'err'>,
  exit: ExitStatus,
): {
  readonly secret: VerbHandler;
  readonly 'secret set': VerbHandler;
  readonly 'secret ls': VerbHandler;
  readonly 'secret rm': VerbHandler;
  readonly 'secret use': VerbHandler;
} {
  const list = verbHandler(io, exit, { command: 'ls', args: [], options: [JSON_OPTION] }, async invocation => {
    await controller.list({ json: on(invocation, 'json') });
  });
  const useOptions: readonly OptionShape[] = [
    { names: ['with', 'w'], takesValue: true },
    { names: ['cwd'], takesValue: true },
    { names: ['timeout'], takesValue: true },
    JSON_OPTION,
  ];
  // The words as typed: the generic reader still refuses an unknown option or one missing its value, but it cannot know
  // which positional is the command (a switch it took for a value, a variadic list, `--`), so `readUseWords` is the
  // one place that decides there IS a command.
  const runWords = verbHandler(
    io,
    exit,
    { command: 'use', args: [], variadic: true, options: useOptions },
    async invocation => {
      const read = readUseWords(invocation.words ?? []);
      if ('refused' in read) throw new Error(read.refused);
      await controller.use(read.command, {
        with: read.names,
        ...(read.cwd === undefined ? {} : { cwd: read.cwd }),
        ...(read.timeout === undefined ? {} : { timeout: read.timeout }),
        json: read.json,
      });
    },
  );
  // No words (a caller that already split them): the parsed args are the command.
  const runParsed = verbHandler(
    io,
    exit,
    { command: 'use', args: ['command'], variadic: true, options: useOptions },
    async invocation => {
      const cwd = text(invocation, 'cwd');
      const timeout = text(invocation, 'timeout');
      await controller.use(invocation.args, {
        with: all(invocation, ['with', 'w']),
        ...(cwd === undefined ? {} : { cwd }),
        ...(timeout === undefined ? {} : { timeout }),
        json: on(invocation, 'json'),
      });
    },
  );
  return {
    // Bare `fy secret` lists, as it always did.
    secret: list,
    'secret set': verbHandler(io, exit, { command: 'set', args: ['name'] }, async ({ args }) => {
      await controller.set(args[0] ?? '');
    }),
    'secret ls': list,
    'secret rm': verbHandler(io, exit, { command: 'rm', args: ['name'] }, async ({ args }) => {
      await controller.remove(args[0] ?? '');
    }),
    'secret use': invocation => (invocation.words === undefined ? runParsed(invocation) : runWords(invocation)),
  };
}
