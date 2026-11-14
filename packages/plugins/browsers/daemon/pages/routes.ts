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
import { ferretOf, isFerretCall, isHumanAdminActor } from '@ferretry/core-gate/contract';
import { BrowserLoginActionSchema } from '../../contract/index.ts';
import { BrowserControlError, type BrowserLoginLifecycle, type BrowserLoginStatus } from '../worker/control/index.ts';
import { acted, maskedSnapshot, maskedStatus, opOfAction, targetOfAction, writeAct } from './acts.ts';
import { parseBody } from './body.ts';
import { ferretAnswer, ferretStatus } from './agent-view.ts';
import { BrowserSessionError, type BrowserPageGuard, type BrowserSubsystem } from './service.ts';
import {
  type BrowserAction,
  type BrowserActionResult,
  BrowserActionSchema,
  type BrowserStatus,
} from '../../contract/wire/browser.ts';

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
export type BrowserStreamOpener = (
  sessionId: string,
  downstream: SocketDownstream,
  mayType: boolean,
  /** For a FERRET's viewer: asked before every frame whether the ferret may still see that page. Absent for a person. */
  admit?: (pageId: string) => Promise<boolean>,
) => Promise<SocketHandler>;

/**
 * Whether the caller of the viewer socket may TYPE into the page: a person (the owner's own app or `fy` with the admin
 * token, or a paired device), as Gate stamped it on the call. The socket is `caller: 'any'`, so a ferret's credential
 * is admitted to watch; its input never is. Anything Gate did not prove a person is refused.
 */
function viewerMayType(call: Pick<CallContext, 'actor' | 'credential'>): boolean {
  if (isFerretCall(call)) return false;
  if (call.credential?.tokenClass === 'device') return true;
  return call.credential?.tokenClass === 'admin' && isHumanAdminActor(call.actor);
}

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

/**
 * What a FERRET's call on the whole-browser routes must pass before it runs: the same ownership, takeover and
 * agent-control checks its own page tools make (`BrowserTools.guardFerretBrowser`). A person's call is not asked:
 * the toolbar is theirs. Throws the refusal (an `ApiError`).
 */
export interface FerretBrowserGuard {
  /** THE rule: refuses (with the sentence) unless the ferret may use this page of its own browser now. */
  check(ferret: string, target: string, pageId: string | undefined): Promise<void>;
  /** Which of these pages are the ferret's own: all a ferret is ever shown of the session's browser. */
  owned(ferret: string, target: string, pages: readonly { readonly id: string }[]): Promise<ReadonlySet<string>>;
}

/** The guard as the page service runs it, inside the page's queue, for the page it is about to touch. */
const pageGuardOf =
  (guard: FerretBrowserGuard, ferret: string, sessionId: string): BrowserPageGuard =>
  async pageId => {
    await guard.check(ferret, sessionId, pageId);
  };

/** `GET /v1/ferrets/:ferretId/browser`: the status, every page's address and title masked (S16). */
async function browserStatus(
  kernel: KernelPorts,
  browser: BrowserSubsystem,
  guard: FerretBrowserGuard,
  call: CallContext,
): Promise<ApiResponse> {
  const caller = ferretOf(call);
  const sessionId = sessionIdOf(call);
  if (caller !== undefined) await guard.check(caller, sessionId, undefined);
  const status = await browser.status(sessionId).catch(browserFailure);
  const shown =
    caller === undefined ? status : ferretStatus(status, await guard.owned(caller, sessionId, status.pages));
  return jsonResponse(await kernel.redaction.read(scope => maskedStatus(scope, shown)));
}

/** `POST /v1/ferrets/:ferretId/browser`: one action on its page, through the act runner. */
async function browserAction(
  kernel: KernelPorts,
  browser: BrowserSubsystem,
  guard: FerretBrowserGuard,
  call: CallContext,
): Promise<ApiResponse> {
  const sessionId = sessionIdOf(call);
  const caller = ferretOf(call);
  // A ferret's own browser and the switch first, before anything about it is read.
  if (caller !== undefined) await guard.check(caller, sessionId, undefined);
  const action = await parseBody(call.request, BrowserActionSchema);
  const before = await browser.status(sessionId).catch(browserFailure);
  const target = targetOfAction(sessionId, action, before);
  const op = opOfAction(action);
  // The page this act is about, resolved ONCE: the hold target above and the page the service acts on are the same page
  // (the service refuses if the view moved), and a ferret's check is run by the service inside that page's queue, for
  // each page the act touches — a stop asks every page it will close — never here, ahead of the queue.
  const options = {
    ...(pageTouchedBy(action, before) === undefined ? {} : { pinned: pageTouchedBy(action, before) as string }),
    ...(caller === undefined
      ? {}
      : { guard: pageGuardOf(guard, caller, sessionId), openedBy: { by: 'agent' as const, sessionId: caller } }),
  };
  /** What the caller may be shown of an answer: a person all of it, a ferret its own pages. */
  const view = async (answer: BrowserActionResult): Promise<BrowserActionResult> =>
    caller === undefined ? answer : ferretAnswer(answer, await guard.owned(caller, sessionId, answer.status.pages));
  const perform = async (): Promise<BrowserActionResult> =>
    await view(await browser.act(sessionId, action, options).catch(browserFailure));
  if (op === 'read') {
    const content = acted<'read'>(
      await kernel.act(target, 'read', async () => {
        const result = await perform();
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
        const result = await perform();
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
  await writeAct(kernel.act, target, op, perform);
  const afterAll = await browser.status(sessionId).catch(browserFailure);
  const after =
    caller === undefined ? afterAll : ferretStatus(afterAll, await guard.owned(caller, sessionId, afterAll.pages));
  return jsonResponse({ status: await kernel.redaction.read(scope => maskedStatus(scope, after)) });
}

/** The page an act would touch, when it touches one: the page it names, else the one the session is viewing. */
function pageTouchedBy(action: BrowserAction, status: BrowserStatus): string | undefined {
  if (action.action === 'stop' || action.action === 'new-page') return undefined;
  if (action.action === 'start' || action.action === 'open') {
    // Start/open only touch the viewed page when there is one and a url to go to.
    if (action.action === 'start' || action.url === undefined) return undefined;
  }
  const named = (action as { readonly pageId?: unknown }).pageId;
  if (typeof named === 'string' && named !== '') return named;
  return status.state === 'running' && 'activePageId' in status ? status.activePageId : undefined;
}

/** The routes this file serves, keyed as the manifest declares them. */
export function pageRoutes(
  kernel: KernelPorts,
  window: BrowserLoginLifecycle,
  browser: BrowserSubsystem,
  guard: FerretBrowserGuard,
) {
  return {
    'GET /v1/browser/login': (async () => await answer(async () => await window.status())) satisfies RouteHandler,
    'POST /v1/browser/login': (async call => await loginAct(window, call)) satisfies RouteHandler,
    'GET /v1/ferrets/:ferretId/browser': (async call =>
      await browserStatus(kernel, browser, guard, call)) satisfies RouteHandler,
    'POST /v1/ferrets/:ferretId/browser': (async call =>
      await browserAction(kernel, browser, guard, call)) satisfies RouteHandler,
  } as const;
}

/** `GET /v1/ferrets/:ferretId/browser/stream`: proves the session, then hands the socket to the viewer stream. */
export function streamSocket(
  browser: Pick<BrowserSubsystem, 'status'>,
  stream: BrowserStreamOpener,
  guard: FerretBrowserGuard,
): SocketAccept {
  return async call => {
    const id = sessionIdOf(call);
    const status = await browser.status(id).catch(browserFailure);
    const mayType = viewerMayType(call);
    const ferret = ferretOf(call);
    // A person's viewer — the owner's own, a paired device's — always opens. A ferret's opens only on a page that is its
    // own, nobody holds and the rule (one function, the page tools') allows; anything else is refused BEFORE the socket
    // opens. It is asked again before every frame, so a takeover while it is open ends it.
    if (ferret === undefined) return async downstream => await stream(id, downstream, mayType);
    const viewed = status.state === 'running' && 'activePageId' in status ? status.activePageId : undefined;
    await guard.check(ferret, id, viewed);
    if (viewed === undefined) throw new ApiError(409, 'this browser has no page open to watch', 'not_running');
    const admit = async (pageId: string): Promise<boolean> =>
      await guard.check(ferret, id, pageId).then(
        () => true,
        () => false,
      );
    return async downstream => await stream(id, downstream, mayType, admit);
  };
}
