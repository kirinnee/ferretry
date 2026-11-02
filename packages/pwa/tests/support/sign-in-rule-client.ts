/** A fake secrets-gated client for the standing sign-in rule routes: it answers by `METHOD path`, parses with the caller's schema, and records every call. */

import type { SignInRuleList, SignInRuleStaged, SignInRuleSuggestionView, SignInRuleView } from '@ferretry/protocol';
import type { RuleClient } from '../../src/lib/sign-in-rules.ts';
import { list as accountList } from './accounts-fixtures.ts';
import {
  pageRule,
  RULE_ID,
  ruleList,
  SITE_SIGN_IN,
  STAGE_ID,
  stagedRule,
  suggestion,
} from './sign-in-rule-fixtures.ts';

export interface RuleWorld {
  /** The rule list; a function is asked on every read, so a test can change it between reads. */
  readonly list?: SignInRuleList | (() => SignInRuleList);
  readonly eligibility?: unknown;
  readonly suggestions?: readonly SignInRuleSuggestionView[];
  readonly staged?: SignInRuleStaged;
  readonly committed?: SignInRuleView;
  /** Returns an error to throw for a call (with its body), or nothing to answer it. */
  readonly fail?: (key: string, body?: Record<string, unknown>) => Error | undefined;
}

export interface RuleCall {
  readonly key: string;
  readonly body: Record<string, unknown> | undefined;
}

/** An error the way the daemon client throws one. */
export const refused = (message: string, extra: { status?: number; code?: string } = {}): Error =>
  Object.assign(new Error(message), extra);

const answerFor =
  (world: RuleWorld) =>
  ({ key, body }: RuleCall): unknown => {
    const failure = world.fail?.(key, body);
    if (failure !== undefined) throw failure;
    if (key === 'GET /v1/sign-in-rules')
      return typeof world.list === 'function' ? world.list() : (world.list ?? ruleList());
    if (key.startsWith('GET /v1/sign-in-rules/eligibility'))
      return world.eligibility ?? { signIn: SITE_SIGN_IN, eligible: true };
    if (key === 'GET /v1/sign-in-rules/suggestions') return { suggestions: world.suggestions ?? [suggestion()] };
    if (key === 'GET /v1/accounts') return accountList();
    if (key === 'POST /v1/sign-in-rules/stages' || key.endsWith('/bind')) return world.staged ?? stagedRule();
    if (key.endsWith('/commit')) return world.committed ?? pageRule();
    if (key.endsWith('/narrow')) return pageRule();
    if (key.startsWith('DELETE /v1/sign-in-rules/stages/')) return { stage: STAGE_ID, dropped: true };
    if (key.startsWith('DELETE /v1/sign-in-rules/suggestions/')) return { id: suggestion().id, dismissed: true };
    if (key.startsWith('DELETE /v1/sign-in-rules/')) return { id: RULE_ID, revoked: true };
    throw new Error(`no answer for ${key}`);
  };

export function ruleClient(world: RuleWorld = {}) {
  const calls: RuleCall[] = [];
  const answer = answerFor(world);
  const client = {
    request: async (path: string, schema: { parse: (value: unknown) => unknown }, init?: RequestInit) => {
      const call: RuleCall = {
        key: `${init?.method ?? 'GET'} ${path}`,
        body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
      };
      calls.push(call);
      return schema.parse(answer(call));
    },
  } as unknown as RuleClient;
  return { client, calls, keys: (): string[] => calls.map(call => call.key) };
}
