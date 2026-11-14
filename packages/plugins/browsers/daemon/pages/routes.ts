import {
  ApiError,
  type ApiResponse,
  type CallContext,
  type KernelPorts,
  jsonResponse,
  type Redaction,
  type RouteHandler,
  type SocketAccept,
  type SocketDownstream,
  type SocketHandler,
} from '@ferretry/kernel/contract';
import { ferretOf, isFerretCall, isHumanAdminActor } from '@ferretry/core-gate/contract';
import { BrowserLoginActionSchema } from '../../contract/index.ts';
import { mapStrings } from '../address-rule.ts';
import { hostOfOrigin } from '../sealed/page-guards.ts';
import { isWebUrl, WEB_URL_ONLY } from '../../contract/wire/limits.ts';
import {
  originOnly,
  SEALED_ANSWER_WITHHELD,
  type SealedGate,
  SealedRefusal,
  SEALED_STREAM_REFUSAL,
  sealedWithheld,
  selectorsOf,
} from '../sealed/gate.ts';
import { BrowserControlError, type BrowserLoginLifecycle, type BrowserLoginStatus } from '../worker/control/index.ts';
import { acted, maskedSnapshot, maskedStatus, opOfAction, targetOfAction, writeAct } from './acts.ts';
import { parseBody } from './body.ts';
import { ferretAnswer, ferretStatus } from './agent-view.ts';
import { type BrowserActGuard, type BrowserPageGuard, BrowserSessionError, type BrowserSubsystem } from './service.ts';
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
/**
 * Who is watching a viewer socket. `agent` is true when a ferret's credential, not a person, is. `mayType` is what the
 * socket's admission proved (a person on the host or a paired device, never a ferret): a viewer that may not type is
 * refused every input. `ferret` is the ferret an agent viewer is, for the rule that says which pages it may see.
 */
interface BrowserViewer {
  readonly agent: boolean;
  readonly mayType: boolean;
  readonly ferret?: string;
}

/** Opens one viewer stream on a socket. */
export type BrowserStreamOpener = (
  sessionId: string,
  downstream: SocketDownstream,
  viewer: BrowserViewer,
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

/**
 * Every URL an action names, whatever it is called (`open`, `navigate`, `new-page`): an agent's goes only to a web page, the
 * rule the MCP tools hold, before anything is dispatched. A person's own navigation is as it was.
 */
function nonWebUrl(action: BrowserAction): string | undefined {
  const url = (action as { readonly url?: unknown }).url;
  return typeof url === 'string' && !isWebUrl(url) ? url : undefined;
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
async function withholdStatus(
  gate: SealedGate | undefined,
  browser: Pick<BrowserSubsystem, 'pageHosts'>,
  ferret: string,
  status: BrowserStatus,
): Promise<BrowserStatus> {
  if (gate === undefined || !gate.anyLive() || status.state !== 'running' || !('url' in status)) return status;
  // By the address AND the host of every frame in the page, read from the live page: a page that only embeds the site shows it too.
  const coveredIds = new Set<string>();
  await Promise.all(
    status.pages.map(async page => {
      const hosts = await browser.pageHosts(ferret, page.id).catch(() => undefined);
      const own = hostOfOrigin(page.url);
      if (
        await gate.covered(ferret, page.url, { hosts: async () => (hosts === undefined ? undefined : [own, ...hosts]) })
      )
        coveredIds.add(page.id);
    }),
  );
  const active = (status as { readonly activePageId?: string }).activePageId;
  const top = status.pages.find(page => page.id === active) ?? status.pages.find(page => page.url === status.url);
  const shown = <T extends { readonly url: string; readonly title: string }>(page: T, covered: boolean): T =>
    covered ? { ...page, url: originOnly(page.url), title: sealedWithheld.title } : page;
  return {
    ...shown(
      status as typeof status & { readonly url: string; readonly title: string },
      top !== undefined && coveredIds.has(top.id),
    ),
    pages: status.pages.map(page => shown(page, coveredIds.has(page.id))),
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

/** What a refusal says when its own message could not be masked: the status and code stay, the words do not. */
export const WITHHELD_REFUSAL = 'the browser reported an error that cannot be shown';

/**
 * A refusal with its message and its `extra` passed through the redaction seam, or withheld whole when the seam
 * cannot be read (FAIL CLOSED): an owner-visible error is text a page or a launch error may have written, so it is
 * masked on the way out exactly as a success result is. A thrown value that is no `ApiError` is returned as it is — the
 * kernel answers it with its own fixed 500 sentence, never its message.
 */
export async function maskedRefusal(redaction: Redaction, error: unknown): Promise<unknown> {
  if (!(error instanceof ApiError)) return error;
  try {
    return await redaction.read(
      scope =>
        new ApiError(
          error.status,
          scope.text(error.message),
          error.code,
          error.validationIssues === undefined
            ? undefined
            : mapStrings(error.validationIssues, text => scope.text(text)),
          error.extra === undefined ? undefined : mapStrings(error.extra, text => scope.text(text)),
        ),
    );
  } catch {
    return new ApiError(error.status, WITHHELD_REFUSAL, error.code);
  }
}

/** Every failure a handler of this file can end in, as the transport's own refusal (never masked here: see {@link guarded}). */
export function refusalOf(error: unknown): unknown {
  if (error instanceof BrowserControlError) return refusal(error);
  if (!(error instanceof BrowserSessionError)) return error;
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
  return new ApiError(status, error.message, error.code);
}

/** Translates a browser session's refusal into the transport's, unmasked: {@link guarded} masks it on its way out. */
function browserFailure(error: unknown): never {
  throw refusalOf(error);
}

/**
 * The ONE exit every route and socket accept of this file leaves by on failure: any refusal it raises — a worker's
 * launch error, a page-error sentence, a body's validation message, the sign-in window's — is translated and then
 * masked by the redaction seam before it is serialised (the kernel serialises an `ApiError`'s message as it is).
 */
export function guarded<Call, Answer>(
  redaction: Redaction,
  handler: (call: Call) => Promise<Answer>,
): (call: Call) => Promise<Answer> {
  return async call => {
    try {
      return await handler(call);
    } catch (error) {
      throw await maskedRefusal(redaction, refusalOf(error));
    }
  };
}

export function sessionIdOf(call: CallContext): string {
  const id = call.params.get('ferretId') ?? '';
  if (id === '' || id.includes('/') || id.includes('\\'))
    throw new ApiError(400, 'the ferret id in the path is not usable', 'bad_request');
  return id;
}

/** `GET /v1/ferrets/:ferretId/browser`: the status, every page's address and title masked (S16). */
async function browserStatus(
  kernel: KernelPorts,
  browser: BrowserSubsystem,
  guard: FerretBrowserGuard,
  gate: SealedGate | undefined,
  call: CallContext,
): Promise<ApiResponse> {
  const sessionId = sessionIdOf(call);
  const caller = ferretOf(call);
  if (caller !== undefined) await guard.check(caller, sessionId, undefined);
  const agent = gate !== undefined && isFerretCall(call);
  const since = agent ? gate.stamp() : undefined;
  const all = await browser.status(sessionId).catch(browserFailure);
  // A ferret is shown its own pages and nothing of a person's; then what a sealed value covers is withheld from that.
  const raw = caller === undefined ? all : ferretStatus(all, await guard.owned(caller, sessionId, all.pages));
  const status = isFerretCall(call) ? await withholdStatus(gate, browser, sessionId, raw) : raw;
  const answer = jsonResponse(await kernel.redaction.read(scope => maskedStatus(scope, status)));
  // The final check, right before the answer leaves: a value sealed while it was being made withholds it.
  if (agent && since !== undefined && !gate.mayDeliver('agent', since))
    throw sealedRefusal(new SealedRefusal(SEALED_ANSWER_WITHHELD));
  return answer;
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

/** `POST /v1/ferrets/:ferretId/browser`: one action on its page, through the act runner. */
async function browserAction(
  kernel: KernelPorts,
  browser: BrowserSubsystem,
  guard: FerretBrowserGuard,
  gate: SealedGate | undefined,
  call: CallContext,
): Promise<ApiResponse> {
  const sessionId = sessionIdOf(call);
  const caller = ferretOf(call);
  // A ferret's own browser and the switch first, before anything about it is read.
  if (caller !== undefined) await guard.check(caller, sessionId, undefined);
  const action = await parseBody(call.request, BrowserActionSchema);
  // An AGENT's address must be a web page, before the status is read, the gate asked or anything dispatched.
  if (isFerretCall(call) && nonWebUrl(action) !== undefined) throw new ApiError(400, WEB_URL_ONLY, 'bad_request');
  const before = await browser.status(sessionId).catch(browserFailure);
  const target = targetOfAction(sessionId, action, before);
  const op = opOfAction(action);
  // A ferret's own credential on this route is an AGENT: it meets the same sealed gate the tools do, before the act and again
  // inside the page's queue, and what comes back is withheld for a page that holds a sealed value. A person passes.
  const agent = gate !== undefined && isFerretCall(call);
  // Taken before any of the work: an answer an agent is given leaves only if no value began to be sealed since (see `leaves`).
  const since = agent ? gate.stamp() : undefined;
  /** The FINAL check, synchronous, immediately before the answer's bytes: what was made before a seal does not leave after it. */
  const leaves = <T>(answer: T): T => {
    if (agent && since !== undefined && !gate.mayDeliver('agent', since))
      throw sealedRefusal(new SealedRefusal(SEALED_ANSWER_WITHHELD));
    return answer;
  };
  const viewed = before.state === 'running' && 'url' in before ? before.url : undefined;
  const sealedGuard: BrowserActGuard | undefined = agent
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
  // The page this act is about, resolved ONCE: the hold target above and the page the service acts on are the same page
  // (the service refuses if the view moved), and a ferret's check is run by the service inside that page's queue, for each
  // page the act touches — a stop asks every page it will close — never here, ahead of the queue. The sealed gate rides the
  // same call in the same queue.
  const touched = pageTouchedBy(action, before);
  const queueGuard: BrowserPageGuard | undefined =
    caller === undefined && sealedGuard === undefined
      ? undefined
      : async (pageId, page) => {
          if (caller !== undefined) await pageGuardOf(guard, caller, sessionId)(pageId, page);
          await sealedGuard?.(page);
        };
  const options = {
    ...(touched === undefined ? {} : { pinned: touched }),
    ...(queueGuard === undefined ? {} : { guard: queueGuard }),
    ...(caller === undefined ? {} : { openedBy: { by: 'agent' as const, sessionId: caller } }),
  };
  /** What the caller may be shown of an answer: a person all of it, a ferret its own pages. */
  const view = async (answer: BrowserActionResult): Promise<BrowserActionResult> =>
    caller === undefined ? answer : ferretAnswer(answer, await guard.owned(caller, sessionId, answer.status.pages));
  const act = async (): Promise<BrowserActionResult> => {
    try {
      return await view(await browser.act(sessionId, action, options));
    } catch (error) {
      if (error instanceof ApiError) throw error;
      // A failure on a page that holds a sealed value is one fixed sentence: what the browser said can echo the page.
      if (agent && (await gate.covered(sessionId, viewed)))
        throw new ApiError(409, sealedWithheld.error, 'upstream_failed');
      return browserFailure(error);
    }
  };
  const answerStatus = async (status: BrowserStatus): Promise<BrowserStatus> =>
    agent ? await withholdStatus(gate, browser, sessionId, status) : status;
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
        const shownStatus = await answerStatus(result.status);
        return await kernel.redaction.read(scope => ({
          kind: 'content' as const,
          data: {
            status: maskedStatus(scope, shownStatus),
            ...('result' in result
              ? { result: { ...maskedSnapshot(scope, result.result), text: scope.text(text) } }
              : {}),
          } as never,
        }));
      }),
    );
    return leaves(jsonResponse(content.data as BrowserActionResult));
  }
  if (op === 'picture') {
    let answerBody: BrowserActionResult | undefined;
    acted(
      await kernel.act(target, 'picture', async () => {
        const result = await act();
        const shownStatus = await answerStatus(result.status);
        answerBody = await kernel.redaction.read(
          scope =>
            ({
              status: maskedStatus(scope, shownStatus),
              ...('result' in result ? { result: maskedSnapshot(scope, result.result) } : {}),
            }) as BrowserActionResult,
        );
        const shot = 'result' in result && 'screenshotBase64' in result.result ? result.result.screenshotBase64 : '';
        return { kind: 'picture' as const, mime: 'image/png' as const, bytes: Buffer.from(shot, 'base64') };
      }),
    );
    return leaves(jsonResponse(answerBody));
  }
  await writeAct(kernel.act, target, op, async () => await act());
  const afterAll = await browser.status(sessionId).catch(browserFailure);
  const after =
    caller === undefined ? afterAll : ferretStatus(afterAll, await guard.owned(caller, sessionId, afterAll.pages));
  const shownAfter = await answerStatus(after);
  const status = await kernel.redaction.read(scope => maskedStatus(scope, shownAfter));
  return leaves(jsonResponse({ status }));
}

/** The routes this file serves, keyed as the manifest declares them. */
export function pageRoutes(
  kernel: KernelPorts,
  window: BrowserLoginLifecycle,
  browser: BrowserSubsystem,
  ferretGuard: FerretBrowserGuard,
  gate?: SealedGate,
) {
  const guard = (handler: RouteHandler): RouteHandler => guarded(kernel.redaction, handler);
  return {
    'GET /v1/browser/login': guard(async () => await answer(async () => await window.status())),
    'POST /v1/browser/login': guard(async call => await loginAct(window, call)),
    'GET /v1/ferrets/:ferretId/browser': guard(
      async call => await browserStatus(kernel, browser, ferretGuard, gate, call),
    ),
    'POST /v1/ferrets/:ferretId/browser': guard(
      async call => await browserAction(kernel, browser, ferretGuard, gate, call),
    ),
  } as const;
}

/** `GET /v1/ferrets/:ferretId/browser/stream`: proves the session, then hands the socket to the viewer stream. */
export function streamSocket(
  redaction: Redaction,
  browser: Pick<BrowserSubsystem, 'status'>,
  stream: BrowserStreamOpener,
  guard: FerretBrowserGuard,
  gate?: SealedGate,
): SocketAccept {
  return guarded(redaction, async call => {
    const id = sessionIdOf(call);
    const status = await browser.status(id).catch(browserFailure);
    const mayType = viewerMayType(call);
    const ferret = ferretOf(call);
    // A person's viewer — the owner's own, a paired device's — always opens, whole.
    if (ferret === undefined) return async downstream => await stream(id, downstream, { agent: false, mayType });
    // A ferret's credential here is an AGENT. Its stream is closed while a sealed value lives (the frames are pictures,
    // which cannot be masked); and it opens only on a page that is its own, nobody holds and the one rule (the page tools')
    // allows — anything else is refused BEFORE the socket opens. After that every frame is asked again (stamped when it
    // arrives, checked again where it leaves, retries and chunks included): see `stream/delivery.ts`.
    if (gate?.anyLive() === true) throw new ApiError(403, SEALED_STREAM_REFUSAL, 'forbidden');
    const viewed = status.state === 'running' && 'activePageId' in status ? status.activePageId : undefined;
    await guard.check(ferret, id, viewed);
    if (viewed === undefined) throw new ApiError(409, 'this browser has no page open to watch', 'not_running');
    return async downstream => await stream(id, downstream, { agent: true, mayType: false, ferret });
  });
}
