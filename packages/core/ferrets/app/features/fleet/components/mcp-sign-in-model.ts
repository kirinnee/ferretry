/**
 * Signing in to a remote MCP server, as words and checks (docs/mcp-oauth.md). Pure.
 *
 * The daemon owns the FACTS — whether a server is signed in, until when, with whom — and this module owns
 * the PROSE a person reads about them, and the two small checks the browser makes on its own: which
 * provider page a sign-in is waiting on, and whether an address handed over by the callback page belongs
 * to THIS sign-in. Neither check is a security boundary — the daemon checks the address strictly and
 * single-uses the state — they only keep this tab from forwarding another tab's sign-in.
 */

import {
  MCP_OAUTH_CALLBACK_PATH,
  type FleetComponentView,
  type McpOAuthConnection,
  type McpOAuthFlow,
} from '@ferretry/protocol';
import { timeUntil } from '../harness-login-model.ts';

/**
 * The same-origin channel the callback page and the tab that started a sign-in talk on.
 *
 * SPELLED TWICE, ON PURPOSE: `public/oauth/mcp-callback.js` is a static classic script nothing bundles,
 * so it cannot import this. `tests/unit/mcp-callback-page.test.ts` runs that file against this value and
 * fails if the two drift.
 */
export const MCP_OAUTH_CHANNEL = 'ferretry-mcp-oauth';

/** Where the provider sends the browser back to: this PWA's own callback page, on its own origin. */
export const mcpRedirectUri = (origin: string): string => `${origin}${MCP_OAUTH_CALLBACK_PATH}`;

/** An MCP server reached at a web address that says it signs in with OAuth. */
export const signsInWithOAuth = (component: FleetComponentView): boolean =>
  component.detail.kind === 'mcp' && component.detail.url !== undefined && component.detail.auth === 'oauth';

const parsedUrl = (value: string): URL | undefined => {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
};

/** Who a person signs in with: the host of an issuer, or the issuer as given when it is not an address. */
export const issuerHost = (issuer: string): string => parsedUrl(issuer)?.host || issuer;

/** The single-use `state` a sign-in's provider page carries, which the callback must bring back. */
export const flowState = (flow: Pick<McpOAuthFlow, 'authorizeUrl'>): string | undefined =>
  parsedUrl(flow.authorizeUrl)?.searchParams.get('state') ?? undefined;

/** Whether an address the callback page handed over is the one THIS sign-in is waiting for. */
export const callbackMatchesFlow = (href: string, flow: Pick<McpOAuthFlow, 'authorizeUrl'>): boolean => {
  const expected = flowState(flow);
  return expected !== undefined && parsedUrl(href)?.searchParams.get('state') === expected;
};

// ── The channel ──────────────────────────────────────────────────────────────────────────────────

/** What the callback page posts: its own address, under an id it made up for this one hand-over. */
export interface McpCallbackMessage {
  readonly id: string;
  readonly href: string;
}

/** A callback page's message, or `undefined` for anything else on the channel. */
export function callbackMessage(data: unknown): McpCallbackMessage | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const { type, id, href } = data as Record<string, unknown>;
  return type === 'callback' && typeof id === 'string' && typeof href === 'string' ? { id, href } : undefined;
}

/**
 * The answers this tab posts back. NEITHER REPEATS THE ADDRESS: `received` lets the callback page wipe
 * the code from its own address bar at once, and `finished` tells it how the daemon answered.
 */
export const receivedMessage = (id: string) => ({ type: 'received', id }) as const;
export const finishedMessage = (id: string, ok: boolean) => ({ type: 'finished', id, ok }) as const;

// ── Where a sign-in stands ───────────────────────────────────────────────────────────────────────

export type McpSignInTone = 'ok' | 'warn' | 'pend';

export interface McpSignInStatus {
  /** The headline: "Signed in · expires in 3h", "Needs sign-in". */
  readonly title: string;
  /** One sentence under it about what happens next, or `undefined` when there is nothing to add. */
  readonly detail?: string;
  readonly tone: McpSignInTone;
  /** Whether the button says "Sign in again" rather than "Sign in". */
  readonly signedInBefore: boolean;
  /** Whether there are stored tokens a Sign out would delete. */
  readonly canSignOut: boolean;
}

/** "in 3h", or a calendar day once it is more than a day away. */
const expiryPhrase = (expiresAt: string, nowMs: number): string => {
  const left = timeUntil(expiresAt, nowMs);
  if (left === 'now') return 'now';
  if (left?.endsWith('d') === true)
    return new Date(expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  return `in ${left}`;
};

/** Where one server's sign-in stands. A server the daemon did not list has never been signed in. */
export function mcpSignInStatus(connection: McpOAuthConnection | undefined, nowMs: number): McpSignInStatus {
  if (connection === undefined || connection.state === 'needs-sign-in')
    return {
      title: 'Needs sign-in',
      detail: 'Runtimes that use this server can’t launch until you sign in.',
      tone: 'warn',
      signedInBefore: connection?.signedInAt !== undefined,
      canSignOut: connection !== undefined && connection.secrets.length > 0,
    };
  if (connection.state === 'expired')
    return connection.renewable
      ? {
          title: 'Expired · renews at next launch',
          detail: 'Ferretry renews it by itself the next time a runtime uses this server.',
          tone: 'pend',
          signedInBefore: true,
          canSignOut: true,
        }
      : {
          title: 'Expired',
          detail: 'Sign in again so runtimes that use this server can launch.',
          tone: 'warn',
          signedInBefore: true,
          canSignOut: true,
        };
  return {
    title:
      connection.expiresAt === undefined
        ? 'Signed in'
        : `Signed in · expires ${expiryPhrase(connection.expiresAt, nowMs)}`,
    ...(connection.renewable ? { detail: 'Ferretry renews it by itself when it runs out.' } : {}),
    tone: 'ok',
    signedInBefore: true,
    canSignOut: true,
  };
}

/** The sentence a finished sign-in shows: "Signed in · expires in 59m." */
export const signedInSentence = (connection: McpOAuthConnection, nowMs: number): string =>
  `${mcpSignInStatus(connection, nowMs).title}.`;
