import type { TerminalIo, VerbHandler } from '@ferretry/kernel/manifest';
import { type ExitStatus, type ReadVerb, type VerbShape, verbHandler } from '../../shell.ts';
import type { CopyController } from './controller.ts';
import type { PlanController } from './plan-controller.ts';

export interface CopyControllers {
  readonly copy: CopyController;
  readonly plans: PlanController;
}

const SESSION = { values: ['session'], aliases: { s: 'session' } } as const;
const JSON_SWITCH = ['json'] as const;

// The option objects the controllers take are commander's; `ReadVerb.options` has exactly that shape.
// biome-ignore lint/suspicious/noExplicitAny: commander's option bag, as today's actions received it.
const bag = (read: ReadVerb): any => read.options;
const arg = (read: ReadVerb, n: number): string => read.args[n] ?? '';

/**
 * `fy copy ls|rules …` and `fy plan` with its alias `fy copy plan`, as the 5.0 shell hands them over: today's
 * `plan/commands.ts` with commander's option declarations turned into one {@link VerbShape} per verb, the same flags,
 * the same controller calls. `fy copy plan …` and `fy plan …` run on the one plan controller.
 */
export function copyVerbs(
  controllers: () => CopyControllers,
  io: Pick<TerminalIo, 'err'>,
  exit: ExitStatus,
): Readonly<Record<string, VerbHandler>> {
  const verb = (shape: VerbShape, run: (read: ReadVerb, c: CopyControllers) => Promise<void>): VerbHandler =>
    verbHandler(io, exit, shape, async read => await run(read, controllers()));
  /** A verb whose last positional is variadic (`[lines...]`): the fixed ones are read as a shape, the rest passed on. */
  const variadic =
    (
      shape: VerbShape,
      run: (read: ReadVerb, rest: readonly string[], c: CopyControllers) => Promise<void>,
    ): VerbHandler =>
    async invocation => {
      const fixed = shape.args.length;
      return await verbHandler(
        io,
        exit,
        shape,
        async read => await run(read, invocation.args.slice(fixed), controllers()),
      )({ ...invocation, args: invocation.args.slice(0, fixed) });
    };

  const planLs = verb({ command: 'ls', args: [], ...SESSION, switches: JSON_SWITCH }, async (read, c) =>
    c.plans.list(bag(read)),
  );
  const planApprove = variadic(
    {
      command: 'approve',
      args: ['id'],
      repeatable: ['pick', 'totp'],
      switches: ['i-understand-one-factor', 'open', 'json'],
    },
    async (read, lines, c) => c.plans.approve(arg(read, 0), lines, { pick: [], totp: [], ...bag(read) }),
  );
  const planRevoke = variadic({ command: 'revoke', args: ['id'], switches: JSON_SWITCH }, async (read, lines, c) =>
    c.plans.revoke(arg(read, 0), lines, bag(read)),
  );

  return {
    'copy ls': verb({ command: 'ls', args: [], ...SESSION, switches: JSON_SWITCH }, async (read, c) =>
      c.copy.list(bag(read)),
    ),
    'copy rules ls': verb({ command: 'ls', args: [], switches: JSON_SWITCH }, async (read, c) =>
      c.copy.rules(bag(read)),
    ),
    'copy rules add': verb(
      {
        command: 'add',
        args: [],
        values: ['from', 'to', 'session', 'count', 'expires'],
        required: ['from', 'to'],
        aliases: SESSION.aliases,
        switches: JSON_SWITCH,
      },
      async (read, c) => c.copy.addRule(bag(read)),
    ),
    'copy rules profile': verb({ command: 'profile', args: ['state'], switches: JSON_SWITCH }, async (read, c) =>
      c.copy.profile(arg(read, 0), bag(read)),
    ),
    'copy rules rm': verb({ command: 'rm', args: ['id'], switches: JSON_SWITCH }, async (read, c) =>
      c.copy.removeRule(arg(read, 0), bag(read)),
    ),
    'copy plan ls': planLs,
    'copy plan approve': planApprove,
    'copy plan revoke': planRevoke,
    'plan ls': planLs,
    'plan approve': planApprove,
    'plan revoke': planRevoke,
  };
}
