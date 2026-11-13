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
import { isFerretCall } from '@ferretry/core-gate/contract';
import { BrowserLoginActionSchema } from '../../contract/index.ts';
import {
  originOnly,
  type SealedGate,
  SealedRefusal,
  SEALED_STREAM_REFUSAL,
  sealedWithheld,
  selectorsOf,
} from '../sealed/gate.ts';
import { BrowserControlError, type BrowserLoginLifecycle, type BrowserLoginStatus } from '../worker/control/index.ts';
import { acted, maskedSnapshot, maskedStatus, opOfAction, targetOfAction, writeAct } from './acts.ts';
import { parseBody } from './body.ts';
import { type BrowserActGuard, BrowserSessionError, type BrowserSubsystem } from './service.ts';
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
/** Opens one viewer stream on a socket; `agent` is true when a ferret's credential, not a person, is watching. */
export type BrowserStreamOpener = (
  sessionId: string,
  downstream: SocketDownstream,
  viewer: { readonly agent: boolean },
) => Promise<SocketHandler>;

/** An agent's refusal from the sealed gate, as the transport's own. */
function sealedRefusal(error: SealedRefusal): ApiError {
  return new ApiError(403, error.message, 'forbidden');
}

/** The tool an action is, for the sealed gate's rules (a picture, a read, or any other act). */
function toolOfAction(action: BrowserAction): string {
  switch (action.action) {
    case 'read':
      return 'browser.read';
    case 'screenshot':
      return 'browser.screenshot';
    case 'highlight':
      return 'browser.highlight';
    default:
      return `browser.${action.action}`;
  }
}

/** The chords an action presses, as strings. */
function keysOf(action: BrowserAction): readonly string[] {
  const keys = (action as { readonly keys?: unknown }).keys;
  return Array.isArray(keys) ? keys.map(String) : [];
}

/**
 * A status as an AGENT may see it while a sealed value lives: a page a live copy covers shows its origin and a fixed
 * title, never its path, query or title (they are what the page says). A person's status is whole.
 */
function withholdStatus(gate: SealedGate | undefined, ferret: string, status: BrowserStatus): BrowserStatus {
  if (gate === undefined || !gate.anyLive() || status.state !== 'running' || !('url' in status)) return status;
  const covered = (url: string): boolean => gate.coveringAddress(ferret, url).length > 0;
  const shown = <T extends { readonly url: string; readonly title: string }>(page: T): T =>
    covered(page.url) ? { ...page, url: originOnly(page.url), title: sealedWithheld.title } : page;
  return {
    ...shown(status as typeof status & { readonly url: string; readonly title: string }),
    pages: status.pages.map(shown),
  } as BrowserStatus;
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
  const id = call.params.get('sessionId') ?? '';
  if (id === '' || id.includes('/') || id.includes('\\'))
    throw new ApiError(400, 'the session id in the path is not usable', 'bad_request');
  return id;
}

/** `GET /v1/sessions/:sessionId/browser`: the status, every page's address and title masked (S16). */
async function browserStatus(
  kernel: KernelPorts,
  browser: BrowserSubsystem,
  gate: SealedGate | undefined,
  call: CallContext,
): Promise<ApiResponse> {
  const sessionId = sessionIdOf(call);
  const raw = await browser.status(sessionId).catch(browserFailure);
  const status = isFerretCall(call) ? withholdStatus(gate, sessionId, raw) : raw;
  return jsonResponse(await kernel.redaction.read(scope => maskedStatus(scope, status)));
}

/** `POST /v1/sessions/:sessionId/browser`: one action on its page, through the act runner. */
async function browserAction(
  kernel: KernelPorts,
  browser: BrowserSubsystem,
  gate: SealedGate | undefined,
  call: CallContext,
): Promise<ApiResponse> {
  const sessionId = sessionIdOf(call);
  const action = await parseBody(call.request, BrowserActionSchema);
  const before = await browser.status(sessionId).catch(browserFailure);
  const target = targetOfAction(sessionId, action, before);
  const op = opOfAction(action);
  // A ferret's own credential on this route is an AGENT: it meets the same sealed gate the tools do, before the act and again
  // inside the page's queue, and what comes back is withheld for a page that holds a sealed value. A person passes.
  const agent = gate !== undefined && isFerretCall(call);
  const viewed = before.state === 'running' && 'url' in before ? before.url : undefined;
  const guard: BrowserActGuard | undefined = agent
    ? async page => {
        try {
          await gate.check({
            ferret: sessionId,
            tool: toolOfAction(action),
            reference: 'the viewed page',
            address: viewed,
            page,
            selectors: selectorsOf(action),
            keys: keysOf(action),
          });
        } catch (error) {
          if (error instanceof SealedRefusal) throw sealedRefusal(error);
          throw error;
        }
      }
    : undefined;
  const act = async (): Promise<BrowserActionResult> => {
    try {
      return await browser.act(sessionId, action, guard);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // A failure on a page that holds a sealed value is one fixed sentence: what the browser said can echo the page.
      if (agent && (await gate.covered(sessionId, viewed)))
        throw new ApiError(409, sealedWithheld.error, 'upstream_failed');
      return browserFailure(error);
    }
  };
  const answerStatus = (status: BrowserStatus): BrowserStatus =>
    agent ? withholdStatus(gate, sessionId, status) : status;
  if (agent && gate.anyLive()) {
    // The pre-check, before the act waits its turn: by the address the viewed page had.
    try {
      await gate.check({
        ferret: sessionId,
        tool: toolOfAction(action),
        reference: 'the viewed page',
        address: viewed,
        selectors: selectorsOf(action),
        keys: keysOf(action),
      });
    } catch (error) {
      if (error instanceof SealedRefusal) throw sealedRefusal(error);
      throw error;
    }
  }
  if (op === 'read') {
    const content = acted<'read'>(
      await kernel.act(target, 'read', async () => {
        const result = await act();
        const text = 'result' in result && 'text' in result.result ? result.result.text : '';
        return await kernel.redaction.read(scope => ({
          kind: 'content' as const,
          data: {
            status: maskedStatus(scope, answerStatus(result.status)),
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
        const result = await act();
        answerBody = await kernel.redaction.read(
          scope =>
            ({
              status: maskedStatus(scope, answerStatus(result.status)),
              ...('result' in result ? { result: maskedSnapshot(scope, result.result) } : {}),
            }) as BrowserActionResult,
        );
        const shot = 'result' in result && 'screenshotBase64' in result.result ? result.result.screenshotBase64 : '';
        return { kind: 'picture' as const, mime: 'image/png' as const, bytes: Buffer.from(shot, 'base64') };
      }),
    );
    return jsonResponse(answerBody);
  }
  await writeAct(kernel.act, target, op, async () => await act());
  const after = await browser.status(sessionId).catch(browserFailure);
  return jsonResponse({ status: await kernel.redaction.read(scope => maskedStatus(scope, answerStatus(after))) });
}

/** The routes this file serves, keyed as the manifest declares them. */
export function pageRoutes(
  kernel: KernelPorts,
  window: BrowserLoginLifecycle,
  browser: BrowserSubsystem,
  gate?: SealedGate,
) {
  return {
    'GET /v1/browser/login': (async () => await answer(async () => await window.status())) satisfies RouteHandler,
    'POST /v1/browser/login': (async call => await loginAct(window, call)) satisfies RouteHandler,
    'GET /v1/sessions/:sessionId/browser': (async call =>
      await browserStatus(kernel, browser, gate, call)) satisfies RouteHandler,
    'POST /v1/sessions/:sessionId/browser': (async call =>
      await browserAction(kernel, browser, gate, call)) satisfies RouteHandler,
  } as const;
}

/** `GET /v1/sessions/:sessionId/browser/stream`: proves the session, then hands the socket to the viewer stream. */
export function streamSocket(
  browser: Pick<BrowserSubsystem, 'status'>,
  stream: BrowserStreamOpener,
  gate?: SealedGate,
): SocketAccept {
  return async call => {
    const id = sessionIdOf(call);
    await browser.status(id).catch(browserFailure);
    // A ferret's credential here is an AGENT: its stream is closed while a sealed value lives (the frames are pictures, which
    // cannot be masked), and every frame is asked again as it arrives. A person's view is whole.
    const agent = isFerretCall(call);
    if (agent && gate?.anyLive() === true) throw new ApiError(403, SEALED_STREAM_REFUSAL, 'forbidden');
    return async downstream => await stream(id, downstream, { agent });
  };
}
