/**
 * HALF B of Accounts' daemon (rebuild unit accounts-b): standing sign-in rules, task plans and copy plans, recipes and
 * their proposals, phone approvals, secure copy, and the F640 recipe approval raised through Asks.
 *
 * THIS FILE IS ACCOUNTS-B'S TO FILL. Half a (`./accounts.ts`) built the one store first and hands it in as `core`, so
 * the rules share its lock and follow its commits (`AccountDirectory.followRulesWith`). Return the routes, tools and
 * subscribers half b answers, keyed exactly as the manifest declares them; `./index.ts` answers every declared key
 * neither half returns with `503 plugin_unavailable`, so nothing here is required until it is ported.
 */
import type { ApiResponse, CallContext } from '@ferretry/kernel/contract';
import type { ToolHandler } from '@ferretry/kernel/manifest';
import type { AccountsContext, AccountsCore } from './accounts.ts';
import type { RecipeMasking } from './routes/accounts.ts';

export interface RulesHalf {
  readonly routes: Readonly<Record<string, (call: CallContext) => Promise<ApiResponse>>>;
  readonly tools: Readonly<Record<string, ToolHandler>>;
  /** The recipe masking half a's routes and `account_hint` serve through (I133); absent until recipes are ported. */
  readonly recipes?: RecipeMasking;
}

export function buildRules(_ctx: AccountsContext, _core: AccountsCore): RulesHalf {
  return { routes: {}, tools: {} };
}
