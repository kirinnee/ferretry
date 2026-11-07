import {
  SIGN_IN_RULE_HONEST_LIMIT,
  SIGN_IN_RULE_ROOT_WARNING,
  SIGN_IN_RULES_SCREEN_PATH,
} from '../../../contract/routes/index.ts';
import type { TerminalIo, VerbHandler, VerbInvocation } from '@ferretry/kernel/manifest';
import {
  ACCOUNT_LISTING,
  type RulesController,
  type RulesStageOptions,
  SIGN_IN_LISTING,
} from './controller.ts';


/** `fy rules` help. The root line and the honest limit are the protocol's own sentences, quoted, never paraphrased. */
export const RULES_HELP = `The owner's command for standing sign-in rules: a sign-in a ferret may use unasked until the rule ends.

  ls                                        your rules, the ones waiting for a passkey, and why any are suspended
  add <si_…> [--username] [--totp --i-understand-one-factor] [--scope any|project:<uuid>|session:<id>]
      [--expires 7d] [--uses N] [--open]    stage a rule; you approve it with your passkey in the app
  resume <sr_…> [--totp --i-understand-one-factor]
                                            approve a suspended rule again, with a new passkey
  renew <sr_…> [--totp --i-understand-one-factor] [--expires 7d] [--uses N]
                                            approve a rule again for a new period, with a new passkey
  widen <sr_…> [--username] [--totp --i-understand-one-factor] [--scope …] [--expires 7d] [--uses N]
                                            give a rule more, with a new passkey; the rest stays as it is
  narrow <sr_…> [--drop-totp] [--expires 2h] [--uses N]
                                            take something away; no passkey needed
  rm <sr_…> | --account <ACCOUNT>           revoke a rule now, or every rule of an account; no passkey needed
                                            (also: revoke)

Find a sign-in's id (si_…) with \`${SIGN_IN_LISTING}\`, an account's with \`${ACCOUNT_LISTING}\`.

add, resume, renew and widen only STAGE the rule: this command prints a link, you confirm with your passkey in the
Ferretry app (${SIGN_IN_RULES_SCREEN_PATH}), and it waits for your answer. Nothing is approved until you do.
A rule for sudo, su or doas: ${SIGN_IN_RULE_ROOT_WARNING}
${SIGN_IN_RULE_HONEST_LIMIT}
A ferret's pane can't run these commands. A paste rule is not one of these: see \`fy copy rules\`.`;

/** The `fy rules` verbs the manifest declares, each answered by the controller. */
export type RulesVerb = 'rules ls' | 'rules add' | 'rules resume' | 'rules renew' | 'rules widen' | 'rules narrow' | 'rules rm';

/** A flag as the shell hands it: by its long name (`i-understand-one-factor`) or its camel-cased key. */
function flag(invocation: VerbInvocation, name: string): string | boolean | undefined {
  const camel = name.replaceAll(/-([a-z])/gu, (_whole, letter: string) => letter.toUpperCase());
  const value = invocation.options[camel] ?? invocation.options[name];
  if (Array.isArray(value)) return value.at(-1);
  return value as string | boolean | undefined;
}
const bool = (invocation: VerbInvocation, name: string): boolean | undefined =>
  flag(invocation, name) === undefined ? undefined : flag(invocation, name) === true;
const text = (invocation: VerbInvocation, name: string): string | undefined => {
  const value = flag(invocation, name);
  return typeof value === 'string' ? value : undefined;
};

const stageOptions = (invocation: VerbInvocation): RulesStageOptions => ({
  json: bool(invocation, 'json'),
  username: bool(invocation, 'username'),
  totp: bool(invocation, 'totp'),
  iUnderstandOneFactor: bool(invocation, 'i-understand-one-factor'),
  scope: text(invocation, 'scope'),
  expires: text(invocation, 'expires'),
  uses: text(invocation, 'uses'),
  open: bool(invocation, 'open'),
});

/**
 * `fy rules ls|add|resume|renew|widen|narrow|rm` as the CLI half's verbs. A refusal is printed as its sentence and exits
 * 1; nothing is asked of the daemon before the controller's own checks (a ferret's pane, `--totp` without its tick).
 */
export function rulesVerbs(
  controller: RulesController,
  io: Pick<TerminalIo, 'err'>,
): Readonly<Record<RulesVerb, VerbHandler>> {
  const run =
    (work: (invocation: VerbInvocation) => Promise<void>): VerbHandler =>
    async invocation => {
      try {
        await work(invocation);
        return 0;
      } catch (error) {
        io.err(error instanceof Error ? error.message : String(error));
        return 1;
      }
    };
  const first = (invocation: VerbInvocation): string => invocation.args[0] ?? '';
  return {
    'rules ls': run(async invocation => await controller.list({ json: bool(invocation, 'json') })),
    'rules add': run(async invocation => await controller.add(first(invocation), stageOptions(invocation))),
    'rules resume': run(async invocation => await controller.resume(first(invocation), stageOptions(invocation))),
    'rules renew': run(async invocation => await controller.renew(first(invocation), stageOptions(invocation))),
    'rules widen': run(async invocation => await controller.widen(first(invocation), stageOptions(invocation))),
    'rules narrow': run(
      async invocation =>
        await controller.narrow(first(invocation), {
          json: bool(invocation, 'json'),
          dropTotp: bool(invocation, 'drop-totp'),
          expires: text(invocation, 'expires'),
          uses: text(invocation, 'uses'),
        }),
    ),
    'rules rm': run(
      async invocation =>
        await controller.remove(invocation.args[0], {
          json: bool(invocation, 'json'),
          account: text(invocation, 'account'),
        }),
    ),
  };
}
