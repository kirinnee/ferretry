/**
 * BROWSERS' PAGE TARGET (§2.3, §4.7): the `page` input target the Vault types an owner's value through, the page holds'
 * page side, who a page signs in, and the four page tools that type into a page or hand it to its owner. The daemon
 * half (`../index.ts`) calls {@link pageTarget} once in `build` and spreads what it answers:
 *
 * ```ts
 * const identities = new TypedIdentities(() => kernel.clock.nowMs());
 * const runtime = new BrowserSessionService(…, identities);
 * const target = pageTarget({ kernel, pages: runtime, host: pageToolHost(tools), identities, vault });
 * return {
 *   hooks: { 'input.targets:page': target.adapter, … },
 *   tools: { ...target.tools, … },
 *   …
 * };
 * ```
 *
 * `pages` is the agent browser's page queue (`BrowserSubsystem.inputOnPage` today) and `host` its surface control. ONE
 * {@link TypedIdentities} is shared by the runtime (its {@link BrowserSignInWatch}: it clears who a page signs in whenever
 * an act may have changed it), the other browser tools and these four; one made here is only for a target built alone. The browser worker serves the seam with `./lib/worker-serve.ts`, and the daemon reaches it with
 * `./lib/worker-port.ts`.
 */
import type { InputTargetAdapter } from '@ferretry/core-vault/contract';
import type { KernelPorts } from '@ferretry/kernel/contract';
import type { ToolHandler } from '@ferretry/kernel/manifest';
import { type PageInputHost, PageInputTarget } from './adapter.ts';
import { TypedIdentities } from './sign-in/identities.ts';
import type { BrowserSignInWatch } from './sign-in/watch.ts';
import { type PageToolDeps, pageInputTools } from './tools/index.ts';

export type { PageInputHost } from './adapter.ts';
export { PageInputTarget, throwawayValue } from './adapter.ts';
export type { BrowserSignInWatch, SignInAct } from './sign-in/watch.ts';
export { NON_TYPING_KEYS, pageActLeavesSignIn, toolbarActLeavesSignIn } from './sign-in/watch.ts';
export { TYPED_IDENTITY_TTL_MS, TypedIdentities } from './sign-in/identities.ts';
export type {
  ActedPage,
  ActNote,
  PageActs,
  PageApprovals,
  PageCaller,
  PageInputAction,
  PageInputOutcome,
  PageToolHost,
  ResolvedPage,
} from './tools/index.ts';

/** What the page target is built from. */
export interface PageTargetDeps extends Omit<PageToolDeps, 'kernel' | 'identities'> {
  readonly kernel: Pick<KernelPorts, 'act' | 'redaction' | 'clock'>;
  /** The agent browser's page queue: every look, picture and write of the input target runs inside it. */
  readonly pages: PageInputHost;
  /** Who each page signs in: the daemon half's one ledger, which its runtime clears (I155). */
  readonly identities?: TypedIdentities;
}

/** What the daemon half spreads into its own. */
export interface PageTargetHalf {
  /** The value of `input.targets:page`. */
  readonly adapter: InputTargetAdapter & PageInputTarget;
  readonly tools: {
    readonly browser_type: ToolHandler;
    readonly browser_fill_form: ToolHandler;
    readonly browser_request_input: ToolHandler;
    readonly browser_ask_owner: ToolHandler;
  };
  /** Who each page signs in, in memory only (I154); the runtime clears it as a {@link BrowserSignInWatch} (I155). */
  readonly identities: TypedIdentities & BrowserSignInWatch;
}

export function pageTarget(deps: PageTargetDeps): PageTargetHalf {
  const identities = deps.identities ?? new TypedIdentities(() => deps.kernel.clock.nowMs());
  const adapter = new PageInputTarget(deps.pages);
  const tools = pageInputTools({
    kernel: deps.kernel,
    host: deps.host,
    identities,
    ...(deps.vault === undefined ? {} : { vault: deps.vault }),
    ...(deps.approvals === undefined ? {} : { approvals: deps.approvals }),
    ...(deps.acts === undefined ? {} : { acts: deps.acts }),
  });
  return { adapter, tools, identities };
}
