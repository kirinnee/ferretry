/**
 * Accounts' daemon half (§2.3): half a (accounts, sign-ins, saved logins, 2FA keys; `./accounts.ts`) and half b
 * (rules, plans, recipes, phone approval, secure copy; `./rules.ts`), composed here. Every declared route or tool
 * neither half answers yet is `503 plugin_unavailable` with the skeleton sentence, as a skeleton half's would be.
 */
import type { SourceKey } from '@ferretry/core-asks/contract';
import { errorResponse, KERNEL_REFUSALS, skeletonSentence } from '@ferretry/kernel/contract';
import { type DaemonHalf, implementDaemon, type ToolHandler } from '@ferretry/kernel/manifest';
import { SignInApprovalRefSchema } from '../contract/index.ts';
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
    const tools: Record<string, ToolHandler> = { ...b.tools, ...a.tools };
    return {
      routes: Object.fromEntries(
        manifest.actions.routes.map(route => [route.key, answered[route.key] ?? notBuiltRoute]),
      ) as Routes,
      tools: Object.fromEntries(
        manifest.actions.agentTools.map(tool => [tool.name, tools[tool.name] ?? notBuiltTool]),
      ) as Tools,
      provides: a.provides,
      // One source for every Accounts card: a plan, a rule suggestion or suspension, a phone approval, a staged 2FA
      // seed. Its refs name an id only; Asks' generic answer creates nothing.
      hooks: {
        [SIGN_IN_APPROVAL_HOOK]: { schema: SignInApprovalRefSchema, title: 'Sign-in approval', form: false },
      } as Half['hooks'],
    } satisfies Half;
  },
});
