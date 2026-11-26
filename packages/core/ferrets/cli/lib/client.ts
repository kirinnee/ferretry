import { createHash, randomUUID } from 'node:crypto';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { z } from 'zod';
import {
  type FerretLiveRead,
  FerretLiveReadSchema,
  type FerretSummary,
  FerretSummarySchema,
  type FyEvent,
  FyEventListSchema,
  SubtreeViewSchema,
  type SubtreeView,
  type RestartCancelResult,
  type RestartRequest,
  type RestartResult,
  type RestartStatus,
  startFingerprintText,
} from '../../contract/index.ts';
import type { IRestartGateway } from './restart/ports.ts';
import type { ListedFerret } from './session/display.ts';
import type { PinnedView, ISessionPinGateway } from './session/pin-agent.ts';
import type { ISessionApi, RenameChange, SignalAnswer, SignalKind, SignalOptions, StartBody } from './session/ports.ts';
import type { ISessionSubtree } from './session/subtree-controller.ts';
import type { CredentialRevoked, ISessionCredentialGateway } from './session/revoke-credential.ts';
import type { IStopSessionGateway } from './stop/types.ts';
import { HeldFleetList } from './session/held-list.ts';

/**
 * Every Ferrets route the `fy` verbs call, by its manifest key (route paths: `/v1/ferrets/…`, today's elsewhere).
 * A key another branch of this port has not declared yet is refused by the shell, unsent, with "no plugin declares
 * the route".
 */
export const FERRET_ROUTES = {
  list: 'GET /v1/ferrets',
  subtree: 'GET /v1/ferrets/:ferretId/subtree',
  /** The STORED last screen (`FerretsApi.lastSnapshot`): gated, and masked again on every read. */
  lastScreen: 'GET /v1/ferrets/:ferretId/last-screen',
  get: 'GET /v1/ferrets/:ferretId',
  events: 'GET /v1/ferrets/:ferretId/events',
  live: 'GET /v1/ferrets/:ferretId/live',
  start: 'POST /v1/ferrets',
  recoverStart: 'GET /v1/ferrets/by-request/:requestId',
  stop: 'POST /v1/ferrets/:ferretId/stop',
  resume: 'POST /v1/ferrets/:ferretId/resume',
  rename: 'POST /v1/ferrets/:ferretId/rename',
  revoke: 'POST /v1/ferrets/:ferretId/revoke-credential',
  names: 'GET /v1/names',
  signal: 'POST /v1/ferrets/:ferretId/signal',
  pin: 'POST /v1/ferrets/:ferretId/pin',
  unpin: 'POST /v1/ferrets/:ferretId/unpin',
  restarts: 'GET /v1/restarts',
  restart: 'POST /v1/restarts',
  cancelRestarts: 'DELETE /v1/restarts',
} as const;

/** The most events one journal page holds (the daemon's own bound). */
const EVENT_PAGE = 1_000;
const ListedSchema = FerretSummarySchema.array();
const LastScreenSchema = z.object({ screen: z.string() });
const at = (reference: string) => ({ params: { ferretId: reference } });

/** Only a transport failure retries a start; HTTP refusals and local guard errors are final (S54). */
function lostStartAnswer(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || 'status' in error || 'exitCode' in error) return false;
  if (error instanceof TypeError && /fetch failed|network|load failed/iu.test(error.message)) return true;
  if (error instanceof Error && error.name === 'TimeoutError') return true;
  if (
    'code' in error &&
    typeof error.code === 'string' &&
    [
      'ConnectionRefused',
      'FailedToOpenSocket',
      'ECONNREFUSED',
      'ENOENT',
      'ECONNRESET',
      'ConnectionClosed',
      'EPIPE',
      'UND_ERR_SOCKET',
      'UND_ERR_CLOSED',
    ].includes(error.code)
  )
    return true;
  return 'cause' in error && error.cause !== error && lostStartAnswer(error.cause);
}

/** The call's answer, or an `AbortError` as soon as `signal` aborts; the call's own late outcome is dropped. */
function abandonOnAbort<T>(call: Promise<T>, signal: AbortSignal): Promise<T> {
  call.catch(() => undefined);
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    call.then(
      value => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      error => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}
const abortError = (): Error =>
  Object.assign(new Error('the read was abandoned at the deadline'), { name: 'AbortError' });

/**
 * The ferret verbs' daemon side, over the shell's guarded client. Every method is one route and a parse of its answer
 * against the contract's schema where the contract has one; the decisions live in the controllers.
 */
export class ClientSessionApi
  implements ISessionApi, ISessionSubtree, IStopSessionGateway, ISessionPinGateway, ISessionCredentialGateway
{
  /** R502: the one last list this connection holds, read conditionally while the shell can (the held list's reader). */
  readonly #held: HeldFleetList | undefined;

  constructor(private readonly client: PluginClient) {
    const conditional = client.conditional?.bind(client);
    this.#held =
      conditional === undefined
        ? undefined
        : new HeldFleetList(async headers => {
            const tag = headers['if-none-match'];
            const answer = await conditional(FERRET_ROUTES.list, {}, tag === undefined ? {} : { ifNoneMatch: tag });
            return {
              status: answer.status,
              ...(answer.etag === undefined ? {} : { etag: answer.etag }),
              body: answer.status === 200 ? JSON.stringify(answer.body) : '',
            };
          });
  }

  async list(): Promise<readonly ListedFerret[]> {
    if (this.#held !== undefined) return await this.#held.list();
    return ListedSchema.parse(await this.client.call<unknown>(FERRET_ROUTES.list));
  }

  /**
   * `signal` ends the wait for the answer when it aborts (a `--timeout` deadline, today's gateway.get): the client
   * call takes no signal, so a read still in flight is abandoned and its late answer or failure is dropped.
   */
  async get(reference: string, signal?: AbortSignal): Promise<FerretSummary> {
    const call = this.client.call<unknown>(FERRET_ROUTES.get, at(reference));
    return FerretSummarySchema.parse(signal === undefined ? await call : await abandonOnAbort(call, signal));
  }

  /**
   * The journal events after sequence `after`, paged to the end (the daemon holds a page to 1,000). `signal` ends the
   * wait for an answer as `get` does.
   */
  async eventsAfter(reference: string, after: number, signal?: AbortSignal): Promise<readonly FyEvent[]> {
    const events: FyEvent[] = [];
    let cursor = after;
    for (;;) {
      const call = this.client.call<unknown>(FERRET_ROUTES.events, {
        ...at(reference),
        query: { after: String(cursor), limit: String(EVENT_PAGE) },
        quiet: true,
      });
      const page = FyEventListSchema.parse(signal === undefined ? await call : await abandonOnAbort(call, signal));
      events.push(...page);
      const last = page.at(-1);
      if (last === undefined || page.length < EVENT_PAGE) return events;
      cursor = last.sequence;
    }
  }

  /**
   * The ferret's STORED last screen, through the gated and re-masked read (`live=false`), or `undefined` when there is
   * none, the caller may not read it or the route is not there: a ferret's last words are a courtesy, never a failure.
   */
  async lastScreen(reference: string): Promise<string | undefined> {
    const answer = await this.client
      .call<unknown>(FERRET_ROUTES.lastScreen, { ...at(reference), quiet: true })
      .catch(() => undefined);
    const parsed = LastScreenSchema.safeParse(answer);
    return parsed.success ? parsed.data.screen : undefined;
  }

  /** The ferret's turns and context fill, or `undefined` when the daemon cannot say: a detail line is never a failure. */
  async live(reference: string): Promise<FerretLiveRead | undefined> {
    const answer = await this.client
      .call<unknown>(FERRET_ROUTES.live, { ...at(reference), quiet: true })
      .catch(() => undefined);
    const parsed = FerretLiveReadSchema.safeParse(answer);
    return parsed.success ? parsed.data : undefined;
  }

  async subtree(reference: string): Promise<SubtreeView> {
    return SubtreeViewSchema.parse(await this.client.call<unknown>(FERRET_ROUTES.subtree, at(reference)));
  }

  async suggestNames(count: number): Promise<string[]> {
    const answer = await this.client.call<unknown>(FERRET_ROUTES.names, { query: { count: String(count) } });
    return Array.isArray(answer) ? answer.filter((name): name is string => typeof name === 'string') : [];
  }

  async start(body: StartBody, given?: string): Promise<{ readonly id: string }> {
    // Today's protocol start: one id and one body snapshot, reused by both POSTs and the recovery read. A caller's
    // `--request-id` is that id, so a later run with the same key answers the ferret this one started.
    const requestId = given ?? randomUUID();
    const payload = JSON.stringify(body);
    const captured: unknown = JSON.parse(payload);
    const init = Object.freeze({ body: captured, headers: Object.freeze({ 'x-fy-request-id': requestId }) });
    // The one header a half may set (PluginCallHeaders); the shell forwards it, and a start without it is refused.
    let originalError: unknown;
    try {
      return await this.client.call<{ id: string }>(FERRET_ROUTES.start, init);
    } catch (error) {
      if (!lostStartAnswer(error)) throw error;
      originalError = error;
    }
    try {
      return await this.client.call<{ id: string }>(FERRET_ROUTES.start, init);
    } catch (error) {
      if (!lostStartAnswer(error)) throw error;
    }
    const recovered = await this.client
      .call<{ id: string }>(FERRET_ROUTES.recoverStart, {
        params: { requestId },
        query: { payload: createHash('sha256').update(startFingerprintText(payload), 'utf8').digest('hex') },
      })
      .catch(() => undefined);
    if (recovered === undefined) throw originalError;
    return recovered;
  }

  async stop(
    reference: string,
    reason?: string,
    how?: 'now' | 'polite',
  ): Promise<{ readonly id: string; readonly state?: string }> {
    return await this.client.call<{ id: string; state?: string }>(FERRET_ROUTES.stop, {
      ...at(reference),
      ...(how === undefined ? {} : { query: { how } }),
      ...(reason === undefined ? {} : { body: { reason } }),
    });
  }

  async resume(reference: string, message?: string): Promise<{ readonly id: string }> {
    return await this.client.call<{ id: string }>(FERRET_ROUTES.resume, {
      ...at(reference),
      ...(message === undefined ? {} : { body: { message } }),
    });
  }

  async rename(reference: string, change: RenameChange): Promise<FerretSummary> {
    return FerretSummarySchema.parse(
      await this.client.call<unknown>(FERRET_ROUTES.rename, { ...at(reference), body: change }),
    );
  }

  async signal(
    reference: string,
    kind: SignalKind,
    message?: string,
    options: SignalOptions = {},
  ): Promise<SignalAnswer> {
    return await this.client.call<SignalAnswer>(FERRET_ROUTES.signal, {
      ...at(reference),
      body: { kind, ...(message === undefined ? {} : { message }), ...options },
    });
  }

  async pin(reference: string): Promise<PinnedView> {
    return await this.client.call<PinnedView>(FERRET_ROUTES.pin, at(reference));
  }

  async unpin(reference: string): Promise<PinnedView> {
    return await this.client.call<PinnedView>(FERRET_ROUTES.unpin, at(reference));
  }

  async revoke(reference: string): Promise<CredentialRevoked> {
    return await this.client.call<CredentialRevoked>(FERRET_ROUTES.revoke, at(reference));
  }

  async state(reference: string): Promise<string> {
    return (await this.get(reference)).state;
  }
}

/** The restart calls over the shell's client. */
export class ClientRestartGateway implements IRestartGateway {
  constructor(private readonly client: PluginClient) {}

  async restart(request: RestartRequest, requestId?: string): Promise<RestartResult> {
    return await this.client.call<RestartResult>(FERRET_ROUTES.restart, {
      body: request,
      ...(requestId === undefined ? {} : { headers: { 'x-fy-request-id': requestId } }),
    });
  }

  async restartStatus(): Promise<RestartStatus> {
    return await this.client.call<RestartStatus>(FERRET_ROUTES.restarts);
  }

  async cancelRestarts(): Promise<RestartCancelResult> {
    return await this.client.call<RestartCancelResult>(FERRET_ROUTES.cancelRestarts);
  }
}
