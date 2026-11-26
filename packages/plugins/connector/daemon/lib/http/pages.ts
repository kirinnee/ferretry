import type { ApiResponse } from '@ferretry/kernel/contract';
import type { ConnectorEndpoints } from '../ports.ts';
import type { OAuthError, ReconnectReason } from '../oauth/model.ts';

/**
 * Every HTML page the connector's public listener can show a person (docs/mcp-connector.md "Pages a person sees").
 * They share one template: a plain headline saying what happened, one obvious action, the steps to connect again,
 * and the machine-readable reference in small print for support. No script, no external asset, no token, no secret,
 * and nothing from the request beyond escaped client text in the waiting page.
 */

/** Where a person starts a connection in Claude; a plain link, never a redirect carrying anything. */
export const CLAUDE_CONNECTORS_URL = 'https://claude.ai/settings/connectors';
const CONNECT_PATH = 'Settings > Connectors > Ferretry > Connect';

const htmlHeaders: readonly [string, string][] = [
  ['content-type', 'text/html; charset=utf-8'],
  ['cache-control', 'no-store'],
  [
    'content-security-policy',
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  ],
  ['referrer-policy', 'no-referrer'],
  ['x-frame-options', 'DENY'],
];

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? '',
  );
}

const STYLE = [
  ':root{color-scheme:light dark;--bg:#fff;--fg:#1a1a1a;--muted:#555;--line:#d0d0d0;--accent:#1d4ed8;--on-accent:#fff}',
  '@media (prefers-color-scheme:dark){:root{--bg:#121212;--fg:#ececec;--muted:#b0b0b0;--line:#3a3a3a;--accent:#8ab4ff;--on-accent:#0b1220}}',
  'body{background:var(--bg);color:var(--fg);font:18px/1.5 system-ui,sans-serif;margin:0}',
  'main{max-width:36rem;margin:0 auto;padding:2rem 1rem 3rem}',
  'h1{font-size:1.6rem;line-height:1.25;margin:0 0 1rem}h2{font-size:1.1rem;margin:1.5rem 0 .5rem}',
  'ol{padding-left:1.4rem}li{margin:.4rem 0}',
  'a{color:var(--accent)}',
  'a.button{display:inline-block;background:var(--accent);color:var(--on-accent);padding:.7rem 1.1rem;border-radius:.5rem;font-weight:600;text-decoration:none}',
  'a:focus-visible{outline:3px solid var(--fg);outline-offset:2px}',
  'strong.code{display:block;font-size:2.5rem;letter-spacing:.15em;margin:.25rem 0 1rem}',
  '.small{color:var(--muted);font-size:.85rem;margin-top:2rem;border-top:1px solid var(--line);padding-top:.75rem}',
].join('');

export interface PageOptions {
  readonly refresh?: boolean;
  readonly status?: number;
  readonly headers?: readonly [string, string][];
}

/** The document shell: the one place a page's markup, style and headers are decided. */
export function page(title: string, content: string, options: PageOptions = {}): ApiResponse {
  return {
    status: options.status ?? 200,
    headers: new Map([...htmlHeaders, ...(options.headers ?? [])]),
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark">${options.refresh ? '<meta http-equiv="refresh" content="2">' : ''}<title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main><h1>${escapeHtml(title)}</h1>${content}</main></body></html>`,
  };
}

/** The Ferretry app's Claude connector panel for this machine; the same deep link the waiting page uses. */
export function appPanelUrl(endpoints: ConnectorEndpoints): string {
  const app = new URL('/', endpoints.appOrigin);
  app.searchParams.set('connector', endpoints.daemonId);
  app.hash = 'connector';
  return app.href;
}

interface Copy {
  readonly headline: string;
  readonly what: string;
  /** Steps after "In Claude, open …", most specific first. */
  readonly steps: readonly string[];
  readonly status: number;
}

const RECONNECT_STEP = `In Claude, open ${CONNECT_PATH}.`;
const APPROVE_STEP = 'Then open Ferretry and approve the new code.';
const COPY: Readonly<Record<ReconnectReason, Copy>> = {
  sign_in_gone: {
    headline: 'This sign-in is no longer waiting',
    what: 'It took longer than 10 minutes, it was already finished, or Ferretry restarted and forgot it. If Claude already shows Ferretry as connected, you can close this page.',
    steps: [RECONNECT_STEP, APPROVE_STEP],
    status: 400,
  },
  cancelled: {
    headline: 'This connection was cancelled',
    what: 'It was disconnected in Ferretry, or cancelled to keep your account safe, before Claude finished connecting. Connecting again is safe.',
    steps: [RECONNECT_STEP, APPROVE_STEP],
    status: 400,
  },
  unrecognised: {
    headline: 'Ferretry does not recognise this connection request',
    what: 'The connection Claude is trying to use is unknown here, most likely because it was removed or this machine was set up again. Nothing was connected.',
    steps: [RECONNECT_STEP, APPROVE_STEP],
    status: 400,
  },
  busy: {
    headline: 'Ferretry has too many sign-ins waiting',
    what: 'Other sign-ins are waiting for approval, so this one was not started.',
    steps: ['Wait a few minutes, or open Ferretry and deny the ones you do not recognise.', RECONNECT_STEP],
    status: 503,
  },
  slow_down: {
    headline: 'Too many tries in a short time',
    what: 'Ferretry paused this connection for a moment to stay safe.',
    steps: ['Wait a minute.', RECONNECT_STEP],
    status: 429,
  },
  trouble: {
    headline: 'Ferretry could not finish this sign-in',
    what: 'Something went wrong on the machine, and nothing was connected.',
    steps: ['Check that Ferretry is running on your machine.', RECONNECT_STEP, APPROVE_STEP],
    status: 503,
  },
};

function reconnectShell(
  copy: Copy,
  endpoints: ConnectorEndpoints,
  reference: string,
  status: number,
  headers: readonly [string, string][] = [],
): ApiResponse {
  const steps = copy.steps.map(step => `<li>${escapeHtml(step)}</li>`).join('');
  return page(
    copy.headline,
    `<p>${escapeHtml(copy.what)}</p><p><a class="button" href="${escapeHtml(CLAUDE_CONNECTORS_URL)}">Open Claude connector settings</a></p><h2>How to connect again</h2><ol>${steps}</ol><p><a href="${escapeHtml(appPanelUrl(endpoints))}">Open Ferretry's Claude connector panel</a></p><p class="small">Reference: ${escapeHtml(reference)}</p>`,
    { status, headers },
  );
}

/** The page for a failure on a page path: its own reason, else one read from its status. */
export function failurePage(failure: OAuthError, endpoints: ConnectorEndpoints): ApiResponse {
  const reason: ReconnectReason =
    failure.reason ??
    (failure.status === 429 || failure.retryAfter !== undefined
      ? 'slow_down'
      : failure.status >= 500
        ? 'trouble'
        : 'unrecognised');
  const headers: [string, string][] =
    failure.status === 429 || failure.retryAfter !== undefined
      ? [['retry-after', String(failure.retryAfter ?? 60)]]
      : [];
  return reconnectShell(
    COPY[reason],
    endpoints,
    failure.error,
    failure.status >= 400 ? failure.status : COPY[reason].status,
    headers,
  );
}
