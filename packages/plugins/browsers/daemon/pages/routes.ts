import {
  ApiError,
  type ApiResponse,
  type CallContext,
  type KernelPorts,
  jsonResponse,
  type RouteHandler,
  type SocketAccept,
  type SocketDownstream,
  type SocketHandler,
} from '@ferretry/kernel/contract';
import { BrowserLoginActionSchema } from '../../contract/index.ts';
import { BrowserControlError, type BrowserLoginLifecycle, type BrowserLoginStatus } from '../worker/control/index.ts';
import { acted, maskedSnapshot, maskedStatus, opOfAction, targetOfAction, writeAct } from './acts.ts';
import { parseBody } from './body.ts';
import { BrowserSessionError, type BrowserSubsystem } from './service.ts';
import { type BrowserActionResult, BrowserActionSchema } from '../../contract/wire/browser.ts';

/**
 * The per-session browser and the human sign-in window (today's `runtime/mounts/browser-login.ts`).
 *
 * The sign-in window: ONE PATH, TWO METHODS. A GET reads the window and a POST carries an explicit human intent
 * (`start`, `stop`, `confirm`) validated by `BrowserLoginActionSchema`. The daemon is never asked to INFER that a
 * person signed in. `noStore` is not optional: an open window's status contains the live VNC password.
 * `BrowserControlError` keeps the domain's two-way split: `bad_request` answers 400, `launch_failed` 503.
 *
 * The per-session browser: every action is an act on its page through `kernel.act` (§4.7). A write-only action
 * answers the status read afterwards, masked (S16); a read answers its masked text; a screenshot its picture.
 */
/** Opens one viewer stream on a socket. */
export type BrowserStreamOpener = (sessionId: string, downstream: SocketDownstream) => Promise<SocketHandler>;

/** Every refusal the login domain raises, in the transport's own taxonomy. */
function refusal(error: BrowserControlError): ApiError {
  return error.code === 'bad_request'
    ? new ApiError(400, error.message, 'invalid_browser_login_request')
    : new ApiError(503, error.message, 'browser_login_unavailable');
}

/** Runs one lifecycle call, translating the domain's refusals and letting a genuine defect surface as the 500 it is. */
async function answer(work: () => Promise<BrowserLoginStatus>): Promise<ApiResponse> {
  try {
    return jsonResponse(await work());
  } catch (error) {
    if (error instanceof BrowserControlError) throw refusal(error);
    throw error;
  }
}

/** Carries out the one intent the body names. */
async function loginAct(window: BrowserLoginLifecycle, call: CallContext): Promise<ApiResponse> {
  const action = await parseBody(call.request, BrowserLoginActionSchema);
  return await answer(async () => {
    if (action.action === 'start')
      return await window.start(action.minutes === undefined ? {} : { minutes: action.minutes });
    if (action.action === 'stop')
      return await window.stop(action.primed === undefined ? {} : { primed: action.primed });
    return await window.confirm();
  });
}

export function browserFailure(error: unknown): never {
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
  throw new ApiError(status, error.message, error.code);
}

export function sessionIdOf(call: CallContext): string {
  const id = call.params.get('ferretId') ?? '';
  if (id === '' || id.includes('/') || id.includes('\\'))
    throw new ApiError(400, 'the ferret id in the path is not usable', 'bad_request');
  return id;
}

/** `GET /v1/ferrets/:ferretId/browser`: the status, every page's address and title masked (S16). */
async function browserStatus(kernel: KernelPorts, browser: BrowserSubsystem, call: CallContext): Promise<ApiResponse> {
  const status = await browser.status(sessionIdOf(call)).catch(browserFailure);
  return jsonResponse(await kernel.redaction.read(scope => maskedStatus(scope, status)));
}

/** `POST /v1/ferrets/:ferretId/browser`: one action on its page, through the act runner. */
async function browserAction(kernel: KernelPorts, browser: BrowserSubsystem, call: CallContext): Promise<ApiResponse> {
  const sessionId = sessionIdOf(call);
  const action = await parseBody(call.request, BrowserActionSchema);
  const before = await browser.status(sessionId).catch(browserFailure);
  const target = targetOfAction(sessionId, action, before);
  const op = opOfAction(action);
  if (op === 'read') {
    const content = acted<'read'>(
      await kernel.act(target, 'read', async () => {
        const result = await browser.act(sessionId, action).catch(browserFailure);
        const text = 'result' in result && 'text' in result.result ? result.result.text : '';
        return await kernel.redaction.read(scope => ({
          kind: 'content' as const,
          data: {
            status: maskedStatus(scope, result.status),
            ...('result' in result
              ? { result: { ...maskedSnapshot(scope, result.result), text: scope.text(text) } }
              : {}),
          } as never,
        }));
      }),
    );
    return jsonResponse(content.data as BrowserActionResult);
  }
  if (op === 'picture') {
    let answerBody: BrowserActionResult | undefined;
    acted(
      await kernel.act(target, 'picture', async () => {
        const result = await browser.act(sessionId, action).catch(browserFailure);
        answerBody = await kernel.redaction.read(
          scope =>
            ({
              status: maskedStatus(scope, result.status),
              ...('result' in result ? { result: maskedSnapshot(scope, result.result) } : {}),
            }) as BrowserActionResult,
        );
        const shot = 'result' in result && 'screenshotBase64' in result.result ? result.result.screenshotBase64 : '';
        return { kind: 'picture' as const, mime: 'image/png' as const, bytes: Buffer.from(shot, 'base64') };
      }),
    );
    return jsonResponse(answerBody);
  }
  await writeAct(kernel.act, target, op, async () => await browser.act(sessionId, action).catch(browserFailure));
  const after = await browser.status(sessionId).catch(browserFailure);
  return jsonResponse({ status: await kernel.redaction.read(scope => maskedStatus(scope, after)) });
}

/** The routes this file serves, keyed as the manifest declares them. */
export function pageRoutes(kernel: KernelPorts, window: BrowserLoginLifecycle, browser: BrowserSubsystem) {
  return {
    'GET /v1/browser/login': (async () => await answer(async () => await window.status())) satisfies RouteHandler,
    'POST /v1/browser/login': (async call => await loginAct(window, call)) satisfies RouteHandler,
    'GET /v1/ferrets/:ferretId/browser': (async call =>
      await browserStatus(kernel, browser, call)) satisfies RouteHandler,
    'POST /v1/ferrets/:ferretId/browser': (async call =>
      await browserAction(kernel, browser, call)) satisfies RouteHandler,
  } as const;
}

/** `GET /v1/ferrets/:ferretId/browser/stream`: proves the session, then hands the socket to the viewer stream. */
export function streamSocket(browser: Pick<BrowserSubsystem, 'status'>, stream: BrowserStreamOpener): SocketAccept {
  return async call => {
    const id = sessionIdOf(call);
    await browser.status(id).catch(browserFailure);
    return async downstream => await stream(id, downstream);
  };
}
