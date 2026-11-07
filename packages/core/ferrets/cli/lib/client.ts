import { createHash, randomUUID } from 'node:crypto';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { type FerretSummary, FerretSummarySchema } from '../../contract/index.ts';
import type {
  RestartCancelResult,
  RestartRequest,
  RestartResult,
  RestartStatus,
} from '../../daemon/lib/protocol/session-restart.ts';
import type { IRestartGateway } from './restart/ports.ts';
import type { CompactAtChange, ISessionCompactAtGateway, SessionCompactAt } from './session/compact-at.ts';
import type { ListedFerret } from './session/display.ts';
import type { PinnedView, ISessionPinGateway } from './session/pin-agent.ts';
import type { ISessionApi, RenameChange, SignalAnswer, SignalKind, SignalOptions, StartBody } from './session/ports.ts';
import type { CredentialRevoked, ISessionCredentialGateway } from './session/revoke-credential.ts';
import type { IStopSessionGateway } from './stop/types.ts';

/**
 * Every Ferrets route the `fy` verbs call, by its manifest key (route paths: `/v1/ferrets/…`, today's elsewhere).
 * A key another branch of this port has not declared yet is refused by the shell, unsent, with "no plugin declares
 * the route".
 */
export const FERRET_ROUTES = {
  list: 'GET /v1/ferrets',
  get: 'GET /v1/ferrets/:ferretId',
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
  compactAt: 'GET /v1/ferrets/:ferretId/compact-at',
  setCompactAt: 'PATCH /v1/ferrets/:ferretId/compact-at',
  restarts: 'GET /v1/restarts',
  restart: 'POST /v1/restarts',
  cancelRestarts: 'DELETE /v1/restarts',
} as const;

const ListedSchema = FerretSummarySchema.array();
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

/**
 * The ferret verbs' daemon side, over the shell's guarded client. Every method is one route and a parse of its answer
 * against the contract's schema where the contract has one; the decisions live in the controllers.
 */
export class ClientSessionApi
  implements ISessionApi, IStopSessionGateway, ISessionPinGateway, ISessionCredentialGateway, ISessionCompactAtGateway
{
  constructor(private readonly client: PluginClient) {}

  async list(): Promise<readonly ListedFerret[]> {
    const answer = await this.client.call<unknown>(FERRET_ROUTES.list);
    return ListedSchema.parse(answer);
  }

  async get(reference: string): Promise<FerretSummary> {
    return FerretSummarySchema.parse(await this.client.call<unknown>(FERRET_ROUTES.get, at(reference)));
  }

  async suggestNames(count: number): Promise<string[]> {
    const answer = await this.client.call<unknown>(FERRET_ROUTES.names, { query: { count: String(count) } });
    return Array.isArray(answer) ? answer.filter((name): name is string => typeof name === 'string') : [];
  }

  async start(body: StartBody): Promise<{ readonly id: string }> {
    // Today's protocol start: one id and one body snapshot, reused by both POSTs and the recovery read.
    const requestId = randomUUID();
    const payload = JSON.stringify(body);
    const captured: unknown = JSON.parse(payload);
    const init = Object.freeze({ body: captured, headers: Object.freeze({ 'x-fy-request-id': requestId }) });
    // GG's header shape. Until the shell forwards GG, the server answers 400 missing_request_id, fail closed.
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
        query: { payload: createHash('sha256').update(payload, 'utf8').digest('hex') },
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

  async read(reference: string): Promise<SessionCompactAt> {
    const { id } = await this.get(reference);
    return await this.client.call<SessionCompactAt>(FERRET_ROUTES.compactAt, at(id));
  }

  async write(reference: string, change: { readonly compactAt: unknown }): Promise<CompactAtChange> {
    const { id } = await this.get(reference);
    return await this.client.call<CompactAtChange>(FERRET_ROUTES.setCompactAt, { ...at(id), body: change });
  }
}

/** The restart calls over the shell's client. */
export class ClientRestartGateway implements IRestartGateway {
  constructor(private readonly client: PluginClient) {}

  async restart(request: RestartRequest): Promise<RestartResult> {
    return await this.client.call<RestartResult>(FERRET_ROUTES.restart, { body: request });
  }

  async restartStatus(): Promise<RestartStatus> {
    return await this.client.call<RestartStatus>(FERRET_ROUTES.restarts);
  }

  async cancelRestarts(): Promise<RestartCancelResult> {
    return await this.client.call<RestartCancelResult>(FERRET_ROUTES.cancelRestarts);
  }
}
