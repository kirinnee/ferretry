import type { TerminalIo, VerbHandler } from '@ferretry/kernel/manifest';
import {
  AUTOMATED_CODE_ACK_WORDS,
  AUTOMATED_CODE_WARNING,
  TASK_PLAN_HONEST_LIMIT,
} from '../../../contract/routes/index.ts';
import { type ExitStatus, type ReadVerb, type VerbShape, verbHandler } from '../../shell.ts';
import type { CopyController } from './controller.ts';
import type { PlanController } from './plan-controller.ts';

/** `fy copy` help (today's `plan/commands.ts`, the same words). */
export const COPY_HELP = `The owner's command for secure copy. A ferret can seal a value it must not see (a new token) and
paste it by name; each paste asks you on a card unless a paste rule you made here allows it.

  ls --session <id>                 the copies a session holds: where each came from, length, expiry, never a value
  rules ls                          your paste rules (the app's "Pastes approved in advance")
  rules add --from command:gh --to terminal:vercel [--session <id>] [--count N] [--expires 2h]
                                    a paste rule: pastes from what gh prints into the vercel program go unasked;
                                    it is only STAGED here, and you make it with your passkey in the app
  rules rm <id>                     end a paste rule
  rules profile on|off              whether a paste rule may match a program in your own profile (~/.nix-profile);
                                    on is only STAGED here, and you approve it with your passkey in the app
  plan ls | approve | revoke        the same as \`plan\` (see \`plan --help\`)

Every paste a paste rule allows is still raised, audited and shown in the log. A ferret cannot run these commands.
A paste rule is not a standing sign-in rule: see \`fy rules\`.`;

/** `fy plan` help. */
export const PLAN_HELP = `The owner's command for a ferret's plan: the sign-ins and pastes it asked you to approve before it starts.

  ls [--session <id>]                           the plans ferrets asked you about, line by line, with their warnings
  approve <id> [1 2 ...] [--pick 2=GITHUB_WORK] [--totp 1 --i-understand-one-factor] [--open]
                                                allow those lines; no numbers declines the plan
  revoke <id> [1 2 ...]                         end those lines (all of them with no numbers)

Every line, a paste line too, is only STAGED here: you confirm the selection with your passkey on the plan's card in
the app, and this command waits for your answer. Nothing is allowed until you do; declining needs no passkey. --totp on a line also lets
Ferretry type its 2FA code: ${AUTOMATED_CODE_WARNING} A ferret cannot run these commands.

${TASK_PLAN_HONEST_LIMIT}`;

/** What `--i-understand-one-factor` says on `plan approve`. */
export const PLAN_TOTP_ACK_HELP = AUTOMATED_CODE_ACK_WORDS;

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
