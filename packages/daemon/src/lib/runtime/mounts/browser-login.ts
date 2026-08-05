import { BrowserLoginActionSchema } from '@ferretry/protocol';
import {
  BrowserControlError,
  type BrowserLoginLifecycle,
  type BrowserLoginStatus,
} from '../../browser/control/index.ts';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import type { ApiResponse } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';

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
 * THE PER-SESSION BROWSER IS NOT SERVED, and it is mounted as a stated refusal rather than left off
 * the table for the same reason `/v1/learning/run` is: `fy browser open` is a shipped command, and a
 * 404 is indistinguishable from version skew while a 501 naming the missing piece is actionable. What
 * is missing is NOT the worker program: `packages/daemon/bin/browser-worker.ts` is the browser worker,
 * and `bin/fyd.ts` already wires a `browserTransport` — `BrowserWorkerClient.connect` and
 * `BrowserViewerStream.connect` — that can launch one and stream its frames. What is missing is the
 * per-session runtime that would turn a session id into a launched worker and a production
 * `BrowserViewerHost`: nothing builds that object, so `browserLoginRoutes` below is called, at its one
 * call site in `mounts/index.ts`, with only the login window and never with the transport. Composing
 * that runtime, and wiring it into this mount, belongs to the unit that ports the browser session
 * runtime.
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

export function browserLoginRoutes(window: BrowserLoginLifecycle): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/browser/login',
      scope: 'admin',
      noStore: true,
      handle: async () => await answer(async () => await window.status()),
    },
    {
      method: 'POST',
      path: '/v1/browser/login',
      scope: 'admin',
      noStore: true,
      handle: async context => await act(window, context),
    },
    {
      // A stated refusal rather than a 404. See the header: the worker program and the transport both
      // exist, but no per-session runtime composes them into something this mount can call.
      method: 'GET',
      path: '/v1/sessions/:sessionId/browser',
      scope: 'admin',
      noStore: true,
      handle: async () => {
        throw browserAutomationUnmounted();
      },
    },
    {
      method: 'POST',
      path: '/v1/sessions/:sessionId/browser',
      scope: 'admin',
      noStore: true,
      handle: async () => {
        throw browserAutomationUnmounted();
      },
    },
  ];
}

function browserAutomationUnmounted(): ApiError {
  return new ApiError(
    501,
    'this daemon mounts the human browser-login window but no per-session automation: it has no browser worker program and no viewer host',
    'browser_automation_not_mounted',
  );
}
