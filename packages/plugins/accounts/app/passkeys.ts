/**
 * THE ACCOUNTS APP HALF'S BINDING TO THE APP'S ONE PASSKEY PROMPT (G105).
 *
 * Every Accounts act that WIDENS what a ferret may do (a paste rule, programs in your own profile, a standing sign-in
 * rule, a task plan's ticks, a machine-staged confirm, saving a 2FA seed) is approved by a passkey bound to the staged
 * thing, asked BEFORE its commit is sent. The ceremony is Access's and the prompt is the shell's one
 * (`usePasskeyAsk`, today's `useStepUpRequest`): this file only says which act and which staged id each ask is for,
 * and which machine it is about. The daemon's own words travel as STRUCTURE (never one text to split); nothing a
 * ferret wrote reaches them.
 *
 * Where nothing can ask (outside a shell, Access gave no handler, or the half's machine is not one the shell knows) the
 * answer is `undefined`, and every surface keeps today's no-passkey path: the stage is dropped and nothing is approved.
 */

import { daemonOfClient, type PasskeyAsk, usePasskeyAsk } from '@ferretry/app';
import { useMemo } from 'react';
import type { SignInRuleStageId, TaskPlanStageId, TwoFactorStageId } from '../contract/routes/account-ids.ts';
import type { PasteRuleStageId } from '../contract/routes/secure-copy.ts';
import type { PasteRuleAsk } from './lib/secure-copy.ts';
import type { RuleAsk } from './lib/sign-in-rules.ts';
import type { PasskeyWords } from './shell.tsx';
import type { AccountsClient } from './shell.tsx';

/** The shell's one prompt: a bound ask on a machine, `true` once confirmed, `false` when dismissed or unpaired. */
export type ShellAsk = (daemon: string, request: PasskeyAsk) => Promise<boolean>;

/** The asks Accounts' surfaces take, each already bound to its machine. */
export interface AccountsPasskeys {
  /** `approve-sign-in-rule`, bound to the staged rule. */
  readonly signInRule: RuleAsk;
  /** `approve-paste-rule` or `allow-profile-targets`, bound to the staged change (the act is the stage's kind). */
  readonly pasteRule: PasteRuleAsk;
  /** `approve-task-plan`, bound to the staged selection. */
  readonly taskPlan: (stage: TaskPlanStageId, words: PasskeyWords) => Promise<boolean>;
  /** `add-2fa-key`, bound to the staged seed; the words name the account from the daemon's own list. */
  readonly addKey: (stage: TwoFactorStageId, words: string) => Promise<boolean>;
}

/** Today's `store.stepUp.require(daemon, words.does, 'explicit', act, stage, words)`, one per act. */
export function bindPasskeys(ask: ShellAsk, daemon: string): AccountsPasskeys {
  const bound = (actId: string, stage: string, words: PasskeyWords): Promise<boolean> =>
    ask(daemon, { actId, act: words.does, subject: stage, words });
  return {
    signInRule: (stage: SignInRuleStageId, words) => bound('approve-sign-in-rule', stage, words),
    pasteRule: (stage: PasteRuleStageId, words, act) => bound(act, stage, words),
    taskPlan: (stage, words) => bound('approve-task-plan', stage, words),
    addKey: (stage, words) => ask(daemon, { actId: 'add-2fa-key', act: words, subject: stage }),
  };
}

/**
 * The asks for the machine this half was built for, or `undefined` when nothing can ask. A client the shell did not
 * make names no machine, so it asks nothing (fails closed) rather than guessing one.
 */
export function useAccountsPasskeys(client: AccountsClient): AccountsPasskeys | undefined {
  const ask = usePasskeyAsk();
  const daemon = daemonOfClient(client);
  return useMemo(
    () => (ask === undefined || daemon === undefined ? undefined : bindPasskeys(ask, daemon)),
    [ask, daemon],
  );
}
