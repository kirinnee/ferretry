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
 * child's output with every known value masked. Repeat `--with` for more than one name: the shell cannot tell where a
 * list ends and the command begins, so a second name written after the first is part of the command.
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
    'secret use': verbHandler(
      io,
      exit,
      {
        command: 'use',
        args: ['command'],
        variadic: true,
        options: [
          { names: ['with', 'w'], takesValue: true },
          { names: ['cwd'], takesValue: true },
          { names: ['timeout'], takesValue: true },
          JSON_OPTION,
        ],
      },
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
    ),
  };
}
