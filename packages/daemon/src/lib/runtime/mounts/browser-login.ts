import {
  BrowserActionSchema,
  BrowserLoginActionSchema,
  hidePairingFragments,
  hidePairingFragmentsIn,
  PAIRING_SCREEN_REFUSAL,
} from '@ferretry/protocol';
import { isAgentCaller, OWNER_ONLY_CODE, ownerOnlyWords } from '../../api/agent-caller.ts';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import type { ApiResponse } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import type { SocketDownstream, SocketHandler, SocketRoute } from '../../api/socket.ts';
import {
  BrowserControlError,
  type BrowserLoginLifecycle,
  type BrowserLoginStatus,
} from '../../browser/control/index.ts';
import {
  type BrowserActGuard,
  BrowserSessionError,
  type BrowserSubsystem,
  holdPairingScreen,
} from '../../browser/runtime/index.ts';

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
 * `mounts/index.ts` now hands this function a browser host as well as the login window.
 *
 * THE HOST STAYS OPTIONAL because the refusal it replaces has to remain expressible. A daemon
 * composed without one answers the stated 501 below rather than a 404, for the same reason
 * `/v1/learning/run` does: `fy browser open` is a shipped command, and a 404 is indistinguishable
 * from version skew while a 501 naming the missing piece is actionable. There is no stream ticket
 * counter any more: a paired device opens the viewer's stream inside its own session.
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

/**
 * WHAT AN AGENT MAY READ OF A PAGE'S ADDRESS (docs/pairing.md, "Never show it to an agent"). `fy browser` — status, read,
 * navigation — answers from these routes, not from `AgentToolService`, so the one function that hides a pairing link's
 * fragment (`hidePairingFragments`) is applied here too, to every body and every refusal an AGENT receives. The owner's
 * own view of their browser (the PWA's page list and address bar, a person's `fy`) is the same bytes as before: the
 * caller predicate is the boundary's one answer to "agent or person" (`callerIsAgent`).
 */
const projectedFor = (context: RouteContext) =>
  isAgentCaller(context)
    ? { body: <T>(value: T): T => hidePairingFragmentsIn(value), text: hidePairingFragments }
    : { body: <T>(value: T): T => value, text: (text: string): string => text };

function browserFailure(error: unknown, context: RouteContext): never {
  if (!(error instanceof BrowserSessionError)) throw error;
  const status = (
    {
      not_found: 404,
      capacity: 409,
      conflict: 409,
      not_running: 409,
      launch_failed: 503,
      upstream_failed: 502,
    } as const
  )[error.code];
  throw new ApiError(status, projectedFor(context).text(error.message), error.code);
}

function sessionId(context: RouteContext): string {
  const id = context.params.get('sessionId') ?? '';
  if (id === '' || id.includes('/') || id.includes('\\'))
    throw new ApiError(400, 'the session id in the path is not usable', 'bad_request');
  return id;
}

async function browserStatus(browser: BrowserSubsystem, context: RouteContext): Promise<ApiResponse> {
  const status = await browser.status(sessionId(context)).catch(error => browserFailure(error, context));
  return jsonResponse(projectedFor(context).body(status));
}

/** The toolbar actions whose answer carries the page itself: its text, its markup, its picture. */
const PAGE_CONTENT_ACTIONS: ReadonlySet<string> = new Set(['read', 'screenshot', 'highlight']);

/** Refuses an agent's read of a page that carries the pairing-screen marker (docs/pairing.md), from inside its queue. */
const pairingScreenGuard: BrowserActGuard = async page =>
  await holdPairingScreen(page, () => new ApiError(403, PAIRING_SCREEN_REFUSAL, 'pairing_screen'));

async function browserAction(browser: BrowserSubsystem, context: RouteContext): Promise<ApiResponse> {
  const action = await parseBody(context.request, BrowserActionSchema);
  // What an agent is handed of a page (its words, its markup, a picture) is refused while the page shows a pairing code.
  const guard = isAgentCaller(context) && PAGE_CONTENT_ACTIONS.has(action.action) ? pairingScreenGuard : undefined;
  const result = await browser.act(sessionId(context), action, guard).catch(error => browserFailure(error, context));
  return jsonResponse(projectedFor(context).body(result));
}

/** The real per-session browser routes. The projection is BrowserStatus, which carries the active tab
 * and its complete tab list from the daemon-owned worker rather than a UI-local guess. */

export function browserLoginRoutes(window: BrowserLoginLifecycle, browser?: BrowserSubsystem): readonly ApiRoute[] {
  const sessionRoutes: readonly ApiRoute[] =
    browser === undefined
      ? [
          {
            method: 'GET',
            path: '/v1/sessions/:sessionId/browser',
            minimum: 'operator',
            caller: 'any',
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
            caller: 'any',
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
            caller: 'any',
            capability: { capability: 'browser', axis: 'use' },
            noStore: true,
            handle: async (context: RouteContext) => await browserStatus(browser, context),
          },
          {
            method: 'POST',
            path: '/v1/sessions/:sessionId/browser',
            minimum: 'operator',
            caller: 'any',
            capability: { capability: 'browser', axis: 'use' },
            noStore: true,
            handle: async (context: RouteContext) => await browserAction(browser, context),
          },
        ];
  return [
    {
      method: 'GET',
      path: '/v1/browser/login',
      minimum: 'operator',
      caller: 'person',
      capability: { capability: 'browser', axis: 'use' },
      noStore: true,
      handle: async () => await answer(async () => await window.status()),
    },
    {
      method: 'POST',
      path: '/v1/browser/login',
      minimum: 'operator',
      caller: 'person',
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
      caller: 'any',
      capability: { capability: 'browser', axis: 'use' },
      accept: async context => {
        const id = sessionId(context);
        // A stream of pictures of the page is the owner's view, never an agent's: a frame could show a pairing code.
        if (isAgentCaller(context))
          throw new ApiError(403, ownerOnlyWords('watches the browser view'), OWNER_ONLY_CODE);
        await browser.status(id).catch(error => browserFailure(error, context));
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
