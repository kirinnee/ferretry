import {
  BrowserActionSchema,
  BrowserLoginActionSchema,
  SOCKET_TICKET_TTL_SECONDS,
  SocketTicketResponseSchema,
  type BrowserActionResult,
} from '@ferretry/protocol';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import type { ApiResponse } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import {
  BrowserControlError,
  type BrowserLoginLifecycle,
  type BrowserLoginStatus,
} from '../../browser/control/index.ts';
import { BrowserSessionError, type BrowserSubsystem } from '../../browser/runtime/index.ts';
import type { SocketDownstream, SocketHandler, SocketRoute } from '../../api/socket.ts';
import type { SocketTicketBroker } from '../../api/socket-ticket.ts';

export interface BrowserMountedSubsystem extends BrowserSubsystem {
  stream(sessionId: string, downstream: SocketDownstream): Promise<SocketHandler>;
}

/**
 * The daemon-global human browser-login window: a short-lived virtual desktop, served over a
 * loopback VNC listener, that a person signs Google into by hand so the agent's browser profile is
 * primed.
 *
 * This is the route `fy browser login` and the PWA's login banner have both spoken since they were
 * ported, against a daemon that answered `unknown_route`. `packages/pwa/src/lib/browser-login.ts`
 * says so in its own header — "`/v1/browser/login` is not mounted by any daemon yet, so this module
 * is proved against an injected port rather than end to end" — and this mount is what retires that
 * sentence.
 *
 * ONE PATH, TWO METHODS, because that is the contract the two clients already parse: a GET reads the
 * window and a POST carries an explicit human intent (`start`, `stop`, `confirm`) validated by
 * `BrowserLoginActionSchema`. The daemon is never asked to INFER that a person signed in — closing
 * with `primed: true` is the human saying they did, and `confirm` is the same claim about a window
 * they want left open.
 *
 * WHY `noStore` IS NOT OPTIONAL HERE. An open window's status contains the live VNC password and the
 * port it is listening on. A cached one hands a later reader a credential for a window that has since
 * closed, and hands an intermediary one for a window that has not.
 *
 * WHY `admin`. Same reason: the status IS a credential. Warden-scoped callers read fleet health, and
 * a token that may read fleet health must not be able to open a desktop on the host or read the
 * password to one that is open.
 *
 * WHAT THE ANSWER MEANS WHEN IT FAILS. `BrowserControlError` carries the domain's own two-way split
 * and it is preserved rather than flattened. `bad_request` is a request that is unusable as written —
 * a duration outside one to sixty minutes — and answers 400. `launch_failed` is everything about the
 * WINDOW rather than the request: no Chrome, no Xvfb, no x11vnc, a host that is not Linux, a profile
 * another holder has, or no open window for a `confirm` to be about. That answers 503, which is what
 * it is: this daemon cannot serve a login window right now, and the body says which of those it is.
 * The split is the domain's call and it is passed through rather than re-decided here — a mount that
 * reclassified a refusal would be a second, quieter opinion about the same failure.
 *
 * THE PER-SESSION BROWSER IS SERVED NOW, and the shape of this file still records what it took. The
 * worker program was never the missing half — `packages/daemon/bin/browser-worker.ts` is the browser
 * worker and `bin/fyd.ts` has long wired a transport that can drive one. What was missing was the
 * per-session runtime that turns a session id into a launched worker and a production
 * `BrowserViewerHost`. `BrowserSessionService` is that object, so the one call site in
 * `mounts/index.ts` now hands this function a browser host and the socket-ticket broker as well as
 * the login window.
 *
 * THE HOST STAYS OPTIONAL because the refusal it replaces has to remain expressible. A daemon
 * composed without one answers the stated 501 below rather than a 404, for the same reason
 * `/v1/learning/run` does: `fy browser open` is a shipped command, and a 404 is indistinguishable
 * from version skew while a 501 naming the missing piece is actionable. The ticket counter is
 * separately optional, because a counter that could mint nothing would answer 500 where a 404 is the
 * truth.
 */

/** Every refusal the login domain raises, in the transport's own taxonomy. */
function refusal(error: BrowserControlError): ApiError {
  return error.code === 'bad_request'
    ? new ApiError(400, error.message, 'invalid_browser_login_request')
    : new ApiError(503, error.message, 'browser_login_unavailable');
}

/** Runs one lifecycle call, translating the domain's refusals and letting a genuine defect surface as
 *  the 500 it is — the dispatcher replaces an unexpected message with a fixed one, and the messages
 *  here routinely name a profile path. */
async function answer(work: () => Promise<BrowserLoginStatus>): Promise<ApiResponse> {
  try {
    return jsonResponse(await work());
  } catch (error) {
    if (error instanceof BrowserControlError) throw refusal(error);
    throw error;
  }
}

/** Carries out the one intent the body names. */
async function act(window: BrowserLoginLifecycle, context: RouteContext): Promise<ApiResponse> {
  const action = await parseBody(context.request, BrowserLoginActionSchema);
  return await answer(async () => {
    if (action.action === 'start') {
      return await window.start(action.minutes === undefined ? {} : { minutes: action.minutes });
    }
    if (action.action === 'stop') {
      return await window.stop(action.primed === undefined ? {} : { primed: action.primed });
    }
    return await window.confirm();
  });
}

function browserFailure(error: unknown): never {
  if (!(error instanceof BrowserSessionError)) throw error;
  const status = (
    { not_found: 404, capacity: 409, not_running: 409, launch_failed: 503, upstream_failed: 502 } as const
  )[error.code];
  throw new ApiError(status, error.message, error.code);
}

function sessionId(context: RouteContext): string {
  const id = context.params.get('sessionId') ?? '';
  if (id === '' || id.includes('/') || id.includes('\\'))
    throw new ApiError(400, 'the session id in the path is not usable', 'bad_request');
  return id;
}

async function browserStatus(browser: BrowserSubsystem, context: RouteContext): Promise<ApiResponse> {
  return jsonResponse(await browser.status(sessionId(context)).catch(browserFailure));
}

async function browserAction(browser: BrowserSubsystem, context: RouteContext): Promise<ApiResponse> {
  const action = await parseBody(context.request, BrowserActionSchema);
  const result: BrowserActionResult = await browser.act(sessionId(context), action).catch(browserFailure);
  return jsonResponse(result);
}

/** The real per-session browser routes. The projection is BrowserStatus, which carries the active tab
 * and its complete tab list from the daemon-owned worker rather than a UI-local guess. */
const streamPath = (sessionId: string): string => `/v1/sessions/${encodeURIComponent(sessionId)}/browser/stream`;

export function browserLoginRoutes(
  window: BrowserLoginLifecycle,
  browser?: BrowserSubsystem,
  tickets?: Pick<SocketTicketBroker, 'issue'>,
): readonly ApiRoute[] {
  const sessionRoutes: readonly ApiRoute[] =
    browser === undefined
      ? [
          {
            method: 'GET',
            path: '/v1/sessions/:sessionId/browser',
            minimum: 'operator',
            capability: { capability: 'browser', axis: 'use' },
            noStore: true,
            handle: async () => {
              throw browserAutomationUnmounted();
            },
          },
          {
            method: 'POST',
            path: '/v1/sessions/:sessionId/browser',
            minimum: 'operator',
            capability: { capability: 'browser', axis: 'use' },
            noStore: true,
            handle: async () => {
              throw browserAutomationUnmounted();
            },
          },
        ]
      : [
          {
            method: 'GET',
            path: '/v1/sessions/:sessionId/browser',
            minimum: 'operator',
            capability: { capability: 'browser', axis: 'use' },
            noStore: true,
            handle: async (context: RouteContext) => await browserStatus(browser, context),
          },
          {
            method: 'POST',
            path: '/v1/sessions/:sessionId/browser',
            minimum: 'operator',
            capability: { capability: 'browser', axis: 'use' },
            noStore: true,
            handle: async (context: RouteContext) => await browserAction(browser, context),
          },
          ...(tickets === undefined
            ? []
            : [
                {
                  method: 'POST' as const,
                  path: '/v1/sessions/:sessionId/browser/stream/ticket',
                  minimum: 'operator' as const,
                  capability: { capability: 'browser' as const, axis: 'use' as const },
                  noStore: true,
                  handle: async (context: RouteContext) => {
                    const id = sessionId(context);
                    await browser.status(id).catch(browserFailure);
                    if (context.credential === undefined) throw new ApiError(401, 'unauthorized', 'unauthorized');
                    const grant = tickets.issue(context.credential, streamPath(id));
                    return jsonResponse(
                      SocketTicketResponseSchema.parse({
                        ticket: grant.ticket,
                        ttlSeconds: SOCKET_TICKET_TTL_SECONDS,
                        expiresAt: new Date(grant.expiresAtMs).toISOString(),
                      }),
                      201,
                    );
                  },
                },
              ]),
        ];
  return [
    {
      method: 'GET',
      path: '/v1/browser/login',
      minimum: 'operator',
      capability: { capability: 'browser', axis: 'use' },
      noStore: true,
      handle: async () => await answer(async () => await window.status()),
    },
    {
      method: 'POST',
      path: '/v1/browser/login',
      minimum: 'operator',
      capability: { capability: 'browser', axis: 'use' },
      noStore: true,
      handle: async context => await act(window, context),
    },
    ...sessionRoutes,
  ];
}

/** Socket handler creation stays at composition: this route proves the existing ticket/capability
 * boundary before handing its socket to the same browser host HTTP actions address. */
export function browserSocketRoutes(browser: BrowserMountedSubsystem): readonly SocketRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/sessions/:sessionId/browser/stream',
      minimum: 'operator',
      capability: { capability: 'browser', axis: 'use' },
      accept: async context => {
        const id = sessionId(context);
        await browser.status(id).catch(browserFailure);
        return async downstream => await browser.stream(id, downstream);
      },
    },
  ];
}

function browserAutomationUnmounted(): ApiError {
  return new ApiError(
    501,
    'this daemon mounts the human browser-login window but no per-session automation: the browser worker and its transport exist, but nothing composes them into the per-session runtime and viewer host this route would call',
    'browser_automation_not_mounted',
  );
}
