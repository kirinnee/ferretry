/**
 * Accounts' daemon half (§2.3): half a (accounts, sign-ins, saved logins, 2FA keys; `./accounts.ts`) and half b
 * (rules, plans, recipes, phone approval, secure copy; built in `./rules.ts`, keyed by accounts-b's `./half-b.ts`),
 * composed here. Every declared route or tool neither half answers yet is `503 plugin_unavailable` with the skeleton
 * sentence, as a skeleton half's would be.
 *
 * Half b's `step-up.stages` providers (approve-task-plan, approve-sign-in-rule, approve-paste-rule) and half a's
 * (`add-2fa-key`: `TwoFactorSeedStages.boundSubjectOf`) are built; they are provided once Access's contract on this
 * base declares `StepUpStages` (TODO(contract)).
 */
import type { SourceKey } from '@ferretry/core-asks/contract';
import { errorResponse, KERNEL_REFUSALS, skeletonSentence } from '@ferretry/kernel/contract';
import { type DaemonHalf, implementDaemon, type ToolHandler } from '@ferretry/kernel/manifest';
import manifest from '../manifest.ts';
import { buildAccounts } from './accounts.ts';
import { buildRules } from './rules.ts';

type Half = DaemonHalf<typeof manifest>;
type Routes = Half['routes'];
type Tools = Half['tools'];

const SIGN_IN_APPROVAL_HOOK: keyof Half['hooks'] = `ask.sources:${'sign-in-approval' as SourceKey}`;

const NOT_BUILT = skeletonSentence(manifest.title);
const notBuiltRoute = async () =>
  errorResponse(KERNEL_REFUSALS.pluginUnavailable.status, NOT_BUILT, KERNEL_REFUSALS.pluginUnavailable.code);
const notBuiltTool: ToolHandler = async () => ({ text: NOT_BUILT, isError: true });

export default implementDaemon(manifest, {
  build(ctx) {
    let rules: ReturnType<typeof buildRules> | undefined;
    const a = buildAccounts(ctx, { recipes: () => rules?.recipes });
    rules = buildRules(ctx, a.core);
    const b = rules;
    const answered: Record<string, unknown> = { ...b.routes, ...a.routes };
    const tools: Record<string, ToolHandler> = { ...a.tools };
    return {
      routes: Object.fromEntries(
        manifest.actions.routes.map(route => [route.key, answered[route.key] ?? notBuiltRoute]),
      ) as Routes,
      tools: Object.fromEntries(
        manifest.actions.agentTools.map(tool => [tool.name, tools[tool.name] ?? notBuiltTool]),
      ) as Tools,
      provides: a.provides,
      subscribers: b.subscribers,
      // One source for every Accounts card: a plan, a rule suggestion or suspension, a phone approval, a recipe
      // proposal, a staged 2FA seed. Its refs name an id only; Asks' generic answer creates nothing.
      hooks: {
        [SIGN_IN_APPROVAL_HOOK]: b.hooks['ask.sources:sign-in-approval'],
        'redaction.sources:source': a.masks,
      } as Half['hooks'],
    } satisfies Half;
  },
});
