import type { VerbInvocation } from '@ferretry/kernel/manifest';
import type { MoveCommandOptions } from './controller.ts';

/**
 * `fy ferret move <id>` (today's `fy migrate`, §1.4): continue a ferret on another runtime (another harness only with
 * `--convert`). Today's options, same spellings:
 *
 *   -a, --agent <agent>          the runtime to move the ferret onto (required)
 *   --model <model>              override the model; defaults to the target account's configured model
 *   --allow-context-downgrade    accept a target context window smaller than the current one
 *   --force-inflight             go ahead although the daemon could not show that what the agent runs is safe to stop
 *   --conversation <choice>      resume (default), fresh, previous or convert
 *   --convert                    move onto a runtime of the OTHER harness by converting the conversation
 *   --preview                    with --convert: show what the conversion would carry and change nothing
 *   --request-id <id>            stable idempotency key for an explicit retry of this move
 *   --json                       print the moved ferret as JSON
 *
 * The shell's parsed options as `MoveCommandOptions`; `--agent` is required, as today.
 */
export function moveOptions(invocation: VerbInvocation): MoveCommandOptions {
  const agent = text(invocation, 'agent') ?? text(invocation, 'a');
  if (agent === undefined) throw new Error("required option '-a, --agent <agent>' not specified");
  const optional = (name: string, key: keyof MoveCommandOptions): Partial<MoveCommandOptions> => {
    const value = text(invocation, name);
    return value === undefined ? {} : { [key]: value };
  };
  const flag = (name: string, key: keyof MoveCommandOptions): Partial<MoveCommandOptions> =>
    on(invocation, name) ? { [key]: true } : {};
  return {
    agent,
    ...optional('model', 'model'),
    ...flag('allow-context-downgrade', 'allowContextDowngrade'),
    ...flag('force-inflight', 'forceInflight'),
    ...optional('conversation', 'conversation'),
    ...flag('convert', 'convert'),
    ...flag('preview', 'preview'),
    ...optional('request-id', 'requestId'),
    ...flag('json', 'json'),
  };
}

function text(invocation: VerbInvocation, name: string): string | undefined {
  const value = invocation.options[name];
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value[value.length - 1] as string | undefined;
  return undefined;
}

function on(invocation: VerbInvocation, name: string): boolean {
  const value = invocation.options[name];
  return value === true || value === 'true';
}
