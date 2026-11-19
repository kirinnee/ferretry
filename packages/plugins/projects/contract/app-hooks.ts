/**
 * THE APP HOOKS PROJECTS OFFERS (§5.2; `@ferretry/app`'s `useAppHook`, a provider's `shell.hooks`).
 *
 * The Create-a-project flow lets a person connect a GitHub account without leaving it. The connect card (the consent
 * words, the code to type at GitHub, the quiet polls, the passkey press) is Git accounts' to draw and to own, and
 * Projects does not depend on Git accounts, so Projects OFFERS the hook below and Git accounts PROVIDES it, over its own
 * client on one daemon. The name and the shape are the whole agreement.
 *
 * FAIL CLOSED. With no provider (Git accounts not installed, not allowed on that daemon, or two plugins giving the
 * name), the flow says that connecting is not available here and still lets the person pick accounts that exist.
 *
 * The value is plain data and functions (no framework type: this is a contract). `panel` is a component; the flow
 * renders it as one and passes it {@link ProjectsConnectAccountProps}.
 */

/** The connect-a-GitHub-account card, as the flow draws it. Provided by Git accounts. */
export const PROJECTS_CONNECT_ACCOUNT_HOOK = 'projects.connect-account' as const;

/** What the flow gives the card. */
export interface ProjectsConnectAccountProps {
  /** How many accounts are connected, so the button can say "another". */
  readonly connected: number;
  /** Called once with the id of the account GitHub has approved and the daemon now holds. */
  readonly onConnected: (accountId: string) => void;
}

/** `projects.connect-account`: the card as a component (`props` in, a React node out; the flow renders it as one). */
export interface ProjectsConnectAccount {
  readonly panel: (props: ProjectsConnectAccountProps) => unknown;
}

/** A provided value is read only when it has the shape: anything else is no provider. */
export const isProjectsConnectAccount = (value: unknown): value is ProjectsConnectAccount =>
  typeof value === 'object' && value !== null && typeof (value as { panel?: unknown }).panel === 'function';

/**
 * `projects.insights`: what another plugin can tell about ONE project, drawn as a section on the project's own page (the
 * app-side half of the insights seam; r9 E3, PRs & CI, is the first provider). Projects offers the section and knows
 * nothing about pull requests; with no provider the page simply has no such section.
 */
export const PROJECTS_INSIGHTS_HOOK = 'projects.insights' as const;

/** What the page gives the section: the project's id (the section reads its own facts by it) and the daemon it is on. */
export interface ProjectsInsightsProps {
  readonly project: string;
  readonly daemon: string;
}

export interface ProjectsInsights {
  /** The section's heading. */
  readonly title: string;
  /** The section's body as a component (`props` in, a React node out). */
  readonly panel: (props: ProjectsInsightsProps) => unknown;
}

export const isProjectsInsights = (value: unknown): value is ProjectsInsights =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as { title?: unknown }).title === 'string' &&
  typeof (value as { panel?: unknown }).panel === 'function';

/** THE DECLARATION: every app hook Projects offers, with the narrowing that says a provided value has its shape. */
export const PROJECTS_APP_HOOKS = {
  [PROJECTS_CONNECT_ACCOUNT_HOOK]: isProjectsConnectAccount,
  [PROJECTS_INSIGHTS_HOOK]: isProjectsInsights,
} as const;
