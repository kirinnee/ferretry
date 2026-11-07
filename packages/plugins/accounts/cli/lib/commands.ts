import type { TerminalIo, VerbHandler } from '@ferretry/kernel/manifest';
import { type ExitStatus, type ReadVerb, type VerbShape, verbHandler } from '../shell.ts';
import type { AccountController } from './account-controller.ts';
import type { FactorKeyController } from './factor-keys-controller.ts';
import type { TwoFactorSeedController } from './factor-controller.ts';
import type { SignInController } from './sign-in-controller.ts';

/**
 * `fy account …` (half a), as the 5.0 shell hands it over: today's `account-commands.ts` with commander's option
 * declarations turned into one {@link VerbShape} per verb, the same flags, the same controller calls. Gone with the
 * compat they served: the hidden `fy secret entry` spelling and `account edit --totp` ("moved"). The `account site
 * recipe …` verbs are half b's (recipes).
 */
export interface AccountControllers {
  readonly accounts: AccountController;
  readonly signIns: SignInController;
  readonly factorKeys: FactorKeyController;
  readonly seeds: TwoFactorSeedController;
}

const PLACE = { repeatable: ['domain', 'for'], values: ['tool', 'host', 'dest'] } as const;
const METHOD = { values: ['method', 'sso-name', 'via'] } as const;
const YES = { switches: ['yes'], aliases: { y: 'yes' } } as const;
const JSON_SWITCH = ['json'] as const;

// The option objects the controllers take are commander's; `ReadVerb.options` has exactly that shape.
// biome-ignore lint/suspicious/noExplicitAny: commander's option bag, as today's actions received it.
const bag = (read: ReadVerb): any => read.options;
const arg = (read: ReadVerb, n: number): string => read.args[n] ?? '';

export function accountVerbs(
  controllers: () => AccountControllers,
  io: Pick<TerminalIo, 'err'>,
  exit: ExitStatus,
): Readonly<Record<string, VerbHandler>> {
  const verb = (shape: VerbShape, run: (read: ReadVerb, c: AccountControllers) => Promise<void>): VerbHandler =>
    verbHandler(io, exit, shape, async read => await run(read, controllers()));
  return {
    'account ls': verb({ command: 'ls', args: [], switches: JSON_SWITCH }, async (read, c) =>
      c.accounts.list(bag(read)),
    ),
    'account add': verb(
      {
        command: 'add',
        args: ['id'],
        values: ['label', 'username', ...PLACE.values, ...METHOD.values],
        repeatable: PLACE.repeatable,
        switches: ['no-password'],
        required: ['label'],
      },
      async (read, c) => c.accounts.add(arg(read, 0), bag(read)),
    ),
    'account edit': verb(
      { command: 'edit', args: ['id'], values: ['label', 'username'], switches: ['no-username', 'password'] },
      async (read, c) => c.accounts.edit(arg(read, 0), bag(read)),
    ),
    'account rename': verb({ command: 'rename', args: ['id', 'new-id'] }, async (read, c) =>
      c.accounts.rename(arg(read, 0), arg(read, 1)),
    ),
    'account rm': verb({ command: 'rm', args: ['id'], ...YES }, async (read, c) =>
      c.accounts.remove(arg(read, 0), bag(read)),
    ),
    'account merge': verb({ command: 'merge', args: ['keep', 'from'], ...YES }, async (read, c) =>
      c.accounts.merge(arg(read, 0), arg(read, 1), bag(read)),
    ),
    'account apart': verb({ command: 'apart', args: ['id', 'other'] }, async (read, c) =>
      c.accounts.apart(arg(read, 0), arg(read, 1)),
    ),
    'account look-alike': verb({ command: 'look-alike', args: [], switches: JSON_SWITCH }, async (read, c) =>
      c.accounts.lookAlike(bag(read)),
    ),
    'account hint': verb({ command: 'hint', args: ['site'], switches: JSON_SWITCH }, async (read, c) =>
      c.accounts.hint(arg(read, 0), bag(read)),
    ),
    'account default set': verb(
      { command: 'set', args: ['key', 'account'], values: ['project', 'folder'] },
      async (read, c) => c.accounts.defaultSet(arg(read, 0), arg(read, 1), bag(read)),
    ),
    'account default rm': verb({ command: 'rm', args: ['key'], values: ['project', 'folder'] }, async (read, c) =>
      c.accounts.defaultRemove(arg(read, 0), bag(read)),
    ),
    'account site ls': verb({ command: 'ls', args: [], optional: 'account', switches: JSON_SWITCH }, async (read, c) =>
      c.signIns.list(read.args[0], bag(read)),
    ),
    'account site add': verb(
      {
        command: 'add',
        args: ['account'],
        values: [...PLACE.values, ...METHOD.values, 'auto-apply-recipe'],
        repeatable: PLACE.repeatable,
      },
      async (read, c) => c.signIns.add(arg(read, 0), bag(read)),
    ),
    'account site edit': verb(
      {
        command: 'edit',
        args: ['sign-in'],
        values: [...PLACE.values, ...METHOD.values, 'auto-apply-recipe'],
        repeatable: PLACE.repeatable,
        switches: ['no-via'],
      },
      async (read, c) => c.signIns.edit(arg(read, 0), bag(read)),
    ),
    'account site rm': verb({ command: 'rm', args: ['sign-in'], ...YES }, async (read, c) =>
      c.signIns.remove(arg(read, 0), bag(read)),
    ),
    'account factor ls': verb(
      { command: 'ls', args: [], optional: 'account', switches: JSON_SWITCH },
      async (read, c) => c.factorKeys.list(read.args[0], bag(read)),
    ),
    'account factor add': verb(
      {
        command: 'add',
        args: ['account'],
        switches: ['totp', 'authenticator', 'sms', 'email', 'push', 'security-key', 'i-understand-totp'],
        values: ['ends-with', 'to', 'app', 'label', 'session'],
        aliases: { s: 'session' },
      },
      async (read, c) => {
        const options = bag(read);
        if (options.totp === true) {
          const others = [options.authenticator, options.sms, options.email, options.push, options.securityKey];
          if (others.some(flag => flag === true))
            throw new Error('--totp is a kind of its own: do not combine it with another kind');
          await c.seeds.add(arg(read, 0), options);
          return;
        }
        await c.factorKeys.add(arg(read, 0), options);
      },
    ),
    'account factor rm': verb({ command: 'rm', args: ['account', 'factor'], ...YES }, async (read, c) =>
      c.factorKeys.remove(arg(read, 0), arg(read, 1), bag(read)),
    ),
  };
}
