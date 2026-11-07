/**
 * ACCOUNTS-B'S SLOT: the standing sign-in rule views (today's `use-sign-in-rules.ts`, `sign-in-rule-panel.tsx`,
 * `account-rules.tsx`) are half b's and not ported to the app yet. Every screen draws them only when `rules` is
 * present, and `RulesBinding` is `never` until b fills this file, so no screen can be handed one and the rule tab,
 * revoke list and edit warnings stay hidden: the state today's app shows a machine that reports no rules.
 */
import type { AccountSummary, SignInId, SignInSummary } from '../../../contract/routes/index.ts';

export type RulesBinding = never;

export function SignInRulePanel(_props: {
  readonly account: AccountSummary | undefined;
  readonly rules: RulesBinding;
  readonly signIn: SignInSummary;
}): null {
  return null;
}

export function RuleEditWarning(_props: { readonly rules: RulesBinding; readonly signIn: SignInId }): null {
  return null;
}

export function AccountRulesRevoke(_props: { readonly account: AccountSummary; readonly rules: RulesBinding }): null {
  return null;
}
