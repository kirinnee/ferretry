import { z } from 'zod';
import { type AnalyticsResponse, AnalyticsResponseSchema } from '../lib/analytics.ts';
import { type ProjectList, ProjectListSchema, type SessionSkills, SessionSkillsSchema } from '../lib/catalog.ts';
import {
  FY_BOARD_CAPABILITY_HEADER,
  FY_REQUEST_ID_HEADER,
  FY_VERSION_HEADER,
  type FyClientOptions,
  type IFyApiClient,
  type IFyEventTransport,
  type IFyFileLoader,
  type IFyHttpTransport,
} from '../lib/client.ts';
import { ApiErrorResponseSchema, NonNegativeIntegerSchema, PositiveIntegerSchema } from '../lib/common.ts';
import {
  type ForeignHistoryListing,
  ForeignHistoryListingSchema,
  type ImportedConversationDetail,
  ImportedConversationDetailSchema,
} from '../lib/foreign-history.ts';
import {
  type SessionHandoverReceipt,
  SessionHandoverReceiptSchema,
  type SessionHandoverRequestInput,
  SessionHandoverRequestSchema,
} from '../lib/handover.ts';
import {
  type ForkSessionOutcome,
  ForkSessionOutcomeSchema,
  type ForkSessionRequest,
  ForkSessionRequestSchema,
} from '../lib/session-fork.ts';
import { type SessionTranscriptPage, SessionTranscriptPageSchema } from '../lib/session-transcript.ts';
import {
  AttachmentUploadRequestSchema,
  type AttachmentView,
  AttachmentViewSchema,
  type CgroupConfigPatch,
  CgroupConfigPatchSchema,
  type CgroupConfigView,
  CgroupConfigViewSchema,
  EmptyResponseSchema,
  type HealthView,
  HealthViewSchema,
  type PwaConfigPatch,
  PwaConfigPatchSchema,
  type PwaConfigView,
  PwaConfigViewSchema,
  ScratchPlanListSchema,
  type ScratchPlanView,
  ScratchSweepRequestSchema,
  type ScratchSweepView,
  ScratchSweepViewSchema,
  type UsageFeedView,
  UsageFeedViewSchema,
  type WardenConfigPatch,
  WardenConfigPatchSchema,
  type WardenConfigView,
  WardenConfigViewSchema,
  WardenRunRequestSchema,
  type WardenRunView,
  WardenRunViewSchema,
  type WardenStatusView,
  WardenStatusViewSchema,
  type WardenVerdictsView,
  WardenVerdictsViewSchema,
} from '../lib/service.ts';
import {
  type AnswerSessionRequest,
  AnswerSessionRequestSchema,
  type FyEvent,
  FyEventListSchema,
  FyEventStreamFrameSchema,
  type FyEventStreamIdle,
  InterruptSessionRequestSchema,
  MigrateSessionRequestSchema,
  NameSuggestionsSchema,
  RenameSessionRequestSchema,
  ResumeSessionRequestSchema,
  type RuntimeControlRequest,
  RuntimeControlRequestSchema,
  type SendRequest,
  SendRequestSchema,
  type SendResult,
  SendResultSchema,
  type SessionAttachTarget,
  SessionAttachTargetSchema,
  SessionListSchema,
  type SessionView,
  SessionViewSchema,
  type SignalKind,
  type SignalOptions,
  SignalSessionRequestSchema,
  type StartSessionRequestInput,
  StartSessionRequestSchema,
  StopSessionRequestSchema,
} from '../lib/session.ts';
import { TaskBoardChildGrantRequestSchema, TaskBoardGrantRequestViewSchema } from '../lib/task-boards.ts';
import {
  detectVersionSkew,
  formatUnknownRouteError,
  ProtocolVersionSchema,
  type VersionSkew,
} from '../lib/version-skew.ts';

export const FY_REQUEST_TIMEOUT_MS = 120_000;
export const FY_RECOVERY_TIMEOUT_MS = 15_000;

const TextResponseSchema = z.string();
const NonEmptyValueSchema = z.string().trim().min(1);

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise(resolve => {
    setTimeout(resolve, milliseconds);
  });

const defaultRequestId = (): string => crypto.randomUUID();

const isTimeoutError = (error: unknown): boolean =>
  error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');

const jsonRequest = <Output>(method: string, schema: z.ZodType<Output>, value: unknown): RequestInit => ({
  method,
  body: JSON.stringify(schema.parse(value)),
  headers: { 'content-type': 'application/json' },
});

const normalizeBaseUrl = (value: string): string => {
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('baseUrl must use http or https');
  }
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('baseUrl may not contain credentials, a query, or a fragment');
  }
  url.pathname = url.pathname.replace(/\/+$/u, '');
  return url.toString().replace(/\/$/u, '');
};

const payloadDigest = async (payload: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
};

export class FyTransportError extends Error {
  override readonly name = 'FyTransportError';

  constructor(
    message: string,
    readonly path: string,
    readonly timedOut: boolean,
    cause: unknown,
  ) {
    super(message, { cause });
  }
}

export class FyHttpError extends Error {
  override readonly name = 'FyHttpError';

  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(message);
  }
}

export class FetchHttpTransport implements IFyHttpTransport {
  send(url: string, init: RequestInit): Promise<Response> {
    return fetch(url, init);
  }
}

export class WebSocketEventTransport implements IFyEventTransport {
  stream(input: { url: string; token: string; signal?: AbortSignal; onMessage(value: unknown): void }): Promise<void> {
    if (input.signal?.aborted === true) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const AuthenticatedWebSocket = WebSocket as unknown as {
        new (url: string | URL, options: { headers: RequestInit['headers'] }): WebSocket;
      };
      const socket = new AuthenticatedWebSocket(input.url, {
        headers: { authorization: `Bearer ${input.token}` },
      });
      let settled = false;
      const cleanup = (): void => {
        input.signal?.removeEventListener('abort', cancel);
        socket.removeEventListener('message', message);
        socket.removeEventListener('close', closed);
        socket.removeEventListener('error', failed);
      };
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.close();
        reject(error instanceof Error ? error : new Error('WebSocket stream failed'));
      };
      const message = (event: MessageEvent): void => {
        try {
          input.onMessage(JSON.parse(String(event.data)));
        } catch (error) {
          fail(error);
        }
      };
      const closed = (event: CloseEvent): void => {
        if (settled) return;
        settled = true;
        cleanup();
        const detail = event.reason === '' ? `code ${event.code}` : `${event.reason} (code ${event.code})`;
        reject(new Error(`WebSocket stream closed unexpectedly: ${detail}`));
      };
      const failed = (): void => fail(new Error('WebSocket stream failed'));
      const cancel = (): void => {
        if (settled) return;
        settled = true;
        cleanup();
        socket.close(1000, 'event stream cancelled');
        resolve();
      };
      socket.addEventListener('message', message);
      socket.addEventListener('close', closed);
      socket.addEventListener('error', failed);
      input.signal?.addEventListener('abort', cancel, { once: true });
      if (input.signal?.aborted === true) cancel();
    });
  }
}

export class FyApiClient implements IFyApiClient {
  readonly #baseUrl: string;
  readonly #token: string;
  readonly #version: string;
  readonly #baseHeaders: Headers;
  readonly #transport: IFyHttpTransport;
  readonly #eventTransport: IFyEventTransport;
  readonly #fileLoader: IFyFileLoader | undefined;
  readonly #requestId: () => string;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #onVersionSkew: ((skew: VersionSkew) => void) | undefined;
  #reportedVersionSkew = false;

  private constructor(options: FyClientOptions) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl);
    this.#token = NonEmptyValueSchema.parse(options.token);
    this.#version = ProtocolVersionSchema.parse(options.version);
    this.#baseHeaders = new Headers(options.headers);
    this.#transport = options.transport ?? new FetchHttpTransport();
    this.#eventTransport = options.eventTransport ?? new WebSocketEventTransport();
    this.#fileLoader = options.fileLoader;
    this.#requestId = options.requestId ?? defaultRequestId;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#onVersionSkew = options.onVersionSkew;
  }

  static connect(options: FyClientOptions): Promise<FyApiClient> {
    return Promise.resolve(new FyApiClient(options));
  }

  async request<T>(
    path: string,
    schema: z.ZodType<T>,
    init: RequestInit = {},
    timeoutMs = FY_REQUEST_TIMEOUT_MS,
  ): Promise<T> {
    NonEmptyValueSchema.parse(path);
    PositiveIntegerSchema.parse(timeoutMs);

    const suppliedHeaders = new Headers(init.headers);
    const suppliedRequestId = suppliedHeaders.get(FY_REQUEST_ID_HEADER)?.trim();
    const logicalRequestId =
      suppliedRequestId === undefined || suppliedRequestId === '' ? this.#requestId() : suppliedRequestId;
    NonEmptyValueSchema.parse(logicalRequestId);

    const headers = new Headers(this.#baseHeaders);
    for (const [name, value] of suppliedHeaders) headers.set(name, value);
    headers.set('authorization', `Bearer ${this.#token}`);
    headers.set(FY_VERSION_HEADER, this.#version);
    headers.set(FY_REQUEST_ID_HEADER, logicalRequestId);

    let response: Response | undefined;
    let lastError: unknown;
    let timedOut = false;
    let cancelled = false;
    for (let attempt = 0; attempt < 3 && response === undefined; attempt++) {
      if (init.signal?.aborted) {
        lastError = init.signal.reason;
        cancelled = true;
        break;
      }
      if (attempt > 0) await this.#sleep(250 * attempt);
      try {
        const deadline = AbortSignal.timeout(timeoutMs);
        const signal = init.signal == null ? deadline : AbortSignal.any([init.signal, deadline]);
        response = await this.#transport.send(`${this.#baseUrl}${path}`, { ...init, headers, signal });
      } catch (error) {
        lastError = error;
        if (init.signal?.aborted) {
          cancelled = true;
          break;
        }
        if (isTimeoutError(error)) {
          timedOut = true;
          break;
        }
      }
    }

    if (response === undefined) {
      const detail = lastError instanceof Error ? ` (${lastError.message})` : '';
      const message = cancelled
        ? `fyd request ${path} was cancelled${detail}`
        : timedOut
          ? `fyd did not answer ${path} within ${Math.round(timeoutMs / 1_000)}s${detail}; it may still have applied the request`
          : `fyd is unavailable at ${this.#baseUrl}${detail}`;
      throw new FyTransportError(message, path, timedOut, lastError);
    }

    const daemonVersion = response.headers.get(FY_VERSION_HEADER);
    this.#noteVersion(daemonVersion);

    if (!response.ok) {
      let candidate: unknown;
      try {
        candidate = await response.json();
      } catch {
        candidate = { error: response.statusText || `fyd returned HTTP ${response.status}` };
      }
      const parsed = ApiErrorResponseSchema.safeParse(candidate);
      const payload = parsed.success ? parsed.data : undefined;
      if (response.status === 404 && payload?.code === 'unknown_route') {
        const route = `${payload.method ?? init.method ?? 'GET'} ${payload.path ?? path}`;
        throw new FyHttpError(
          formatUnknownRouteError(route, this.#version, daemonVersion),
          response.status,
          payload.code,
        );
      }
      throw new FyHttpError(payload?.error ?? `fyd returned HTTP ${response.status}`, response.status, payload?.code);
    }

    let payload: unknown;
    if (response.status === 204) {
      payload = undefined;
    } else if ((response.headers.get('content-type') ?? '').includes('application/json')) {
      payload = await response.json();
    } else {
      payload = await response.text();
    }
    return schema.parse(payload);
  }

  health(): Promise<HealthView> {
    return this.request('/v1/health', HealthViewSchema);
  }

  wardenStatus(): Promise<WardenStatusView> {
    return this.request('/v1/warden/status', WardenStatusViewSchema);
  }

  wardenVerdicts(): Promise<WardenVerdictsView> {
    return this.request('/v1/warden/verdicts', WardenVerdictsViewSchema);
  }

  wardenReport(reportPath: string): Promise<string> {
    return this.request(`/v1/warden/report?path=${encodeURIComponent(reportPath)}`, z.string());
  }

  wardenRun(spawn = false): Promise<WardenRunView> {
    return this.request('/v1/warden/run', WardenRunViewSchema, jsonRequest('POST', WardenRunRequestSchema, { spawn }));
  }

  wardenConfig(): Promise<WardenConfigView> {
    return this.request('/v1/warden/config', WardenConfigViewSchema);
  }

  updateWardenConfig(patch: WardenConfigPatch): Promise<WardenConfigView> {
    return this.request(
      '/v1/warden/config',
      WardenConfigViewSchema,
      jsonRequest('PATCH', WardenConfigPatchSchema, patch),
    );
  }

  cgroupConfig(): Promise<CgroupConfigView> {
    return this.request('/v1/cgroups/config', CgroupConfigViewSchema);
  }

  updateCgroupConfig(patch: CgroupConfigPatch): Promise<CgroupConfigView> {
    return this.request(
      '/v1/cgroups/config',
      CgroupConfigViewSchema,
      jsonRequest('PATCH', CgroupConfigPatchSchema, patch),
    );
  }

  pwaConfig(): Promise<PwaConfigView> {
    return this.request('/v1/pwa/config', PwaConfigViewSchema);
  }

  updatePwaConfig(patch: PwaConfigPatch): Promise<PwaConfigView> {
    return this.request('/v1/pwa/config', PwaConfigViewSchema, jsonRequest('PATCH', PwaConfigPatchSchema, patch));
  }

  usage(): Promise<UsageFeedView> {
    return this.request('/v1/usage', UsageFeedViewSchema);
  }

  projects(): Promise<ProjectList> {
    return this.request('/v1/projects', ProjectListSchema);
  }

  sessionSkills(id: string): Promise<SessionSkills> {
    return this.request(`/v1/sessions/${encodeURIComponent(id)}/skills`, SessionSkillsSchema);
  }

  analytics(query?: string): Promise<AnalyticsResponse> {
    const search = new URLSearchParams();
    if (query?.trim()) search.set('q', query.trim());
    const suffix = search.size === 0 ? '' : `?${search.toString()}`;
    return this.request(`/v1/analytics${suffix}`, AnalyticsResponseSchema);
  }

  foreignHistory(): Promise<ForeignHistoryListing> {
    return this.request('/v1/imports/history', ForeignHistoryListingSchema);
  }

  foreignHistoryConversation(id: string): Promise<ImportedConversationDetail> {
    return this.request(
      `/v1/imports/history/${encodeURIComponent(NonEmptyValueSchema.parse(id))}`,
      ImportedConversationDetailSchema,
    );
  }

  scratchPlan(limit = 20): Promise<ScratchPlanView[]> {
    const parsedLimit = PositiveIntegerSchema.parse(limit);
    return this.request(`/v1/gc?limit=${parsedLimit}`, ScratchPlanListSchema);
  }

  scratchSweep(force = false): Promise<ScratchSweepView> {
    return this.request('/v1/gc', ScratchSweepViewSchema, jsonRequest('POST', ScratchSweepRequestSchema, { force }));
  }

  list(): Promise<SessionView[]> {
    return this.request('/v1/sessions', SessionListSchema);
  }

  suggestNames(count = 1): Promise<string[]> {
    const parsedCount = PositiveIntegerSchema.parse(count);
    return this.request(`/v1/names?count=${parsedCount}`, NameSuggestionsSchema);
  }

  get(id: string, signal?: AbortSignal): Promise<SessionView> {
    return this.request(
      `/v1/sessions/${encodeURIComponent(NonEmptyValueSchema.parse(id))}`,
      SessionViewSchema,
      signal === undefined ? {} : { signal },
    );
  }

  async start(input: StartSessionRequestInput, requestId?: string, boardCapability?: string): Promise<SessionView> {
    const parsed = StartSessionRequestSchema.parse(input);
    const logicalRequestId = NonEmptyValueSchema.parse(requestId ?? this.#requestId());
    const capability = boardCapability?.trim() ?? '';
    if (parsed.boardAccess !== 'none' && capability === '') {
      throw new Error('a non-none board-access start requires a board capability');
    }

    const body = JSON.stringify(parsed);
    const digest = await payloadDigest(body);
    const headers = new Headers({
      'content-type': 'application/json',
      [FY_REQUEST_ID_HEADER]: logicalRequestId,
    });
    if (capability !== '') headers.set(FY_BOARD_CAPABILITY_HEADER, capability);
    const startInit: RequestInit = { method: 'POST', body, headers };

    let originalError: FyTransportError;
    try {
      return await this.request('/v1/sessions', SessionViewSchema, startInit);
    } catch (error) {
      if (!(error instanceof FyTransportError)) throw error;
      originalError = error;
    }

    try {
      return await this.request('/v1/sessions', SessionViewSchema, startInit, FY_RECOVERY_TIMEOUT_MS);
    } catch (error) {
      if (!(error instanceof FyTransportError)) throw error;
    }

    const recoveryPath = `/v1/sessions/by-request/${encodeURIComponent(logicalRequestId)}?payload=${encodeURIComponent(digest)}`;
    const recovered = await this.request(recoveryPath, SessionViewSchema, {}, FY_RECOVERY_TIMEOUT_MS).catch(
      () => undefined,
    );
    if (recovered === undefined) throw originalError;
    if (parsed.boardAccess !== 'none') {
      await this.#ensureBoardAccess(recovered, parsed.boardAccess, logicalRequestId, digest, capability);
    }
    return recovered;
  }

  send(id: string, input: SendRequest): Promise<SendResult> {
    return this.#post(id, 'send', SendRequestSchema, input, SendResultSchema);
  }

  answer(
    id: string,
    toolUseId: string,
    labels: string[],
    other?: string,
    responses?: string[],
    answers?: AnswerSessionRequest['answers'],
    requestId?: string,
  ): Promise<SessionView> {
    return this.#post(
      id,
      'answer',
      AnswerSessionRequestSchema,
      { toolUseId, labels, other, responses, answers },
      SessionViewSchema,
      requestId,
    );
  }

  interrupt(id: string): Promise<SessionView> {
    return this.#post(id, 'interrupt', InterruptSessionRequestSchema, {}, SessionViewSchema);
  }

  stop(id: string, reason?: string): Promise<SessionView> {
    return this.#post(id, 'stop', StopSessionRequestSchema, { reason }, SessionViewSchema);
  }

  resume(id: string, message?: string): Promise<SessionView> {
    return this.#post(id, 'resume', ResumeSessionRequestSchema, { message }, SessionViewSchema);
  }

  runtime(id: string, request: RuntimeControlRequest, requestId?: string): Promise<SessionView> {
    return this.#post(
      id,
      'runtime',
      RuntimeControlRequestSchema,
      request,
      SessionViewSchema,
      NonEmptyValueSchema.parse(requestId ?? this.#requestId()),
    );
  }

  migrate(
    id: string,
    agent: string,
    model?: string,
    allowContextDowngrade = false,
    requestId?: string,
  ): Promise<SessionView> {
    return this.#post(
      id,
      'migrate',
      MigrateSessionRequestSchema,
      { agent, model, allowContextDowngrade },
      SessionViewSchema,
      NonEmptyValueSchema.parse(requestId ?? this.#requestId()),
    );
  }

  handover(id: string, request: SessionHandoverRequestInput, requestId?: string): Promise<SessionHandoverReceipt> {
    return this.#post(
      id,
      'handover',
      SessionHandoverRequestSchema,
      request,
      SessionHandoverReceiptSchema,
      NonEmptyValueSchema.parse(requestId ?? this.#requestId()),
    );
  }

  handoverReceipt(id: string): Promise<SessionHandoverReceipt> {
    return this.request(
      `/v1/sessions/${encodeURIComponent(NonEmptyValueSchema.parse(id))}/handover`,
      SessionHandoverReceiptSchema,
    );
  }

  cancelHandover(id: string, requestId?: string): Promise<SessionHandoverReceipt> {
    return this.#post(
      id,
      'handover/cancel',
      z.strictObject({}),
      {},
      SessionHandoverReceiptSchema,
      NonEmptyValueSchema.parse(requestId ?? this.#requestId()),
    );
  }

  fork(id: string, input: ForkSessionRequest, requestId?: string): Promise<ForkSessionOutcome> {
    return this.#post(
      id,
      'fork',
      ForkSessionRequestSchema,
      input,
      ForkSessionOutcomeSchema,
      NonEmptyValueSchema.parse(requestId ?? this.#requestId()),
    );
  }

  rename(id: string, name?: string, teammate?: string, clearParent?: boolean): Promise<SessionView> {
    return this.#post(id, 'rename', RenameSessionRequestSchema, { name, teammate, clearParent }, SessionViewSchema);
  }

  signal(id: string, kind: SignalKind, message?: string, options: SignalOptions = {}): Promise<SessionView> {
    return this.#post(id, 'signal', SignalSessionRequestSchema, { kind, message, ...options }, SessionViewSchema);
  }

  remove(id: string, purge = false, force = false): Promise<void> {
    const sessionId = encodeURIComponent(NonEmptyValueSchema.parse(id));
    return this.request(`/v1/sessions/${sessionId}?purge=${purge}&force=${force}`, EmptyResponseSchema, {
      method: 'DELETE',
    });
  }

  attachTarget(id: string): Promise<SessionAttachTarget> {
    return this.request(
      `/v1/sessions/${encodeURIComponent(NonEmptyValueSchema.parse(id))}/attach`,
      SessionAttachTargetSchema,
    );
  }

  snapshot(id: string): Promise<string> {
    return this.request(
      `/v1/sessions/${encodeURIComponent(NonEmptyValueSchema.parse(id))}/snapshot?live=true`,
      TextResponseSchema,
    );
  }

  logs(id: string, turn?: number): Promise<string> {
    const suffix = turn === undefined ? '' : `?turn=${NonNegativeIntegerSchema.parse(turn)}`;
    return this.request(
      `/v1/sessions/${encodeURIComponent(NonEmptyValueSchema.parse(id))}/logs${suffix}`,
      TextResponseSchema,
    );
  }

  messages(id: string, cursor?: string, limit?: number, signal?: AbortSignal): Promise<SessionTranscriptPage> {
    const sessionId = encodeURIComponent(NonEmptyValueSchema.parse(id));
    const search = new URLSearchParams();
    if (cursor !== undefined) {
      NonEmptyValueSchema.parse(cursor);
      search.set('cursor', cursor);
    }
    if (limit !== undefined) search.set('limit', String(PositiveIntegerSchema.max(1_000).parse(limit)));
    const suffix = search.size === 0 ? '' : `?${search.toString()}`;
    return this.request(
      `/v1/sessions/${sessionId}/messages${suffix}`,
      SessionTranscriptPageSchema,
      signal === undefined ? {} : { signal },
    );
  }

  events(id: string, after = 0, limit = 1_000, signal?: AbortSignal): Promise<FyEvent[]> {
    const parsedAfter = NonNegativeIntegerSchema.parse(after);
    const parsedLimit = PositiveIntegerSchema.max(1_000).parse(limit);
    return this.request(
      `/v1/sessions/${encodeURIComponent(NonEmptyValueSchema.parse(id))}/events?after=${parsedAfter}&limit=${parsedLimit}`,
      FyEventListSchema,
      signal === undefined ? {} : { signal },
    );
  }

  async history(id: string, after = 0, limit?: number): Promise<FyEvent[]> {
    let cursor = NonNegativeIntegerSchema.parse(after);
    const parsedLimit = limit === undefined ? undefined : PositiveIntegerSchema.parse(limit);
    const events: FyEvent[] = [];
    while (parsedLimit === undefined || events.length < parsedLimit) {
      const pageSize = Math.min(1_000, parsedLimit === undefined ? 1_000 : parsedLimit - events.length);
      const page = await this.events(id, cursor, pageSize);
      events.push(...page);
      if (page.length < pageSize) break;
      const nextCursor = page.at(-1)?.sequence;
      if (nextCursor === undefined || nextCursor <= cursor) {
        throw new Error('event history page did not advance its cursor');
      }
      cursor = nextCursor;
    }
    return events;
  }

  async upload(id: string, file: string | Blob, filename?: string): Promise<AttachmentView> {
    let blob: Blob;
    let resolvedFilename: string;
    if (typeof file === 'string') {
      if (this.#fileLoader === undefined) throw new Error('uploading a path requires a file loader');
      const loaded = await this.#fileLoader.load(file);
      blob = loaded.blob;
      resolvedFilename = filename ?? loaded.filename;
    } else {
      blob = file;
      resolvedFilename = filename ?? (file instanceof File ? file.name : 'attachment');
    }
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.byteLength; offset += 32_768) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 32_768));
    }
    return this.request(
      `/v1/sessions/${encodeURIComponent(NonEmptyValueSchema.parse(id))}/attachments`,
      AttachmentViewSchema,
      jsonRequest('POST', AttachmentUploadRequestSchema, {
        filename: NonEmptyValueSchema.parse(resolvedFilename),
        mime: blob.type || 'application/octet-stream',
        base64: btoa(binary),
      }),
    );
  }

  stream(
    sessionId: string | undefined,
    after: number,
    onEvent: (event: FyEvent) => void,
    signal?: AbortSignal,
    onIdle?: (idle: FyEventStreamIdle) => void,
  ): Promise<void> {
    const url = new URL(`${this.#baseUrl}/v1/events`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('after', String(NonNegativeIntegerSchema.parse(after)));
    if (sessionId !== undefined) url.searchParams.set('sessionId', NonEmptyValueSchema.parse(sessionId));
    return this.#eventTransport.stream({
      url: url.toString(),
      token: this.#token,
      ...(signal === undefined ? {} : { signal }),
      onMessage: value => {
        const frame = FyEventStreamFrameSchema.parse(value);
        if (frame.kind === 'event') onEvent(frame.event);
        else onIdle?.(frame);
      },
    });
  }

  #noteVersion(daemonVersion: string | null): void {
    if (this.#reportedVersionSkew) return;
    const skew = detectVersionSkew(this.#version, daemonVersion);
    if (skew === undefined) return;
    this.#reportedVersionSkew = true;
    this.#onVersionSkew?.(skew);
  }

  /**
   * Re-requests the child grant a recovered start could not confirm the daemon had made.
   *
   * Only the RECOVERY path reaches here: a start whose POST was answered had its grant requested by
   * the daemon, which is why the board capability travels on `/v1/sessions` at all. When both POSTs
   * died in transport the client cannot know how far the daemon got, so it asks again — and the ask
   * is safe to repeat because the board derives its own request id from the operation's identity and
   * replays rather than opening a second intent.
   *
   * The path is plural. `/v1/task-boards` is the prefix the daemon mounts and the one
   * `TASK_BOARD_ROUTE_PREFIX` names for the CLI's own eleven routes; the singular spelling this used
   * to carry reached no route at all, so the one call that exists to make a recovered start whole
   * answered `unknown_route`.
   */
  async #ensureBoardAccess(
    view: SessionView,
    role: Exclude<StartSessionRequestInput['boardAccess'], undefined | 'none'>,
    requestId: string,
    digest: string,
    capability: string,
  ): Promise<void> {
    await this.request(
      '/v1/task-boards/child-grants/request',
      TaskBoardGrantRequestViewSchema,
      {
        ...jsonRequest('POST', TaskBoardChildGrantRequestSchema, {
          targetSessionId: view.config.id,
          role,
        }),
        headers: {
          'content-type': 'application/json',
          [FY_REQUEST_ID_HEADER]: `${requestId}:board-access:${digest}`,
          [FY_BOARD_CAPABILITY_HEADER]: capability,
        },
      },
      FY_RECOVERY_TIMEOUT_MS,
    );
  }

  /**
   * `requestId` is threaded as a SUPPLIED header rather than left to `request()`'s per-call default,
   * because `request()` computes its logical id once and reuses it across all three retry attempts —
   * so handing it one here is what makes the whole retry sequence one logical operation to the daemon.
   */
  #post<RequestOutput, ResponseOutput>(
    id: string,
    action: string,
    requestSchema: z.ZodType<RequestOutput>,
    value: unknown,
    responseSchema: z.ZodType<ResponseOutput>,
    requestId?: string,
  ): Promise<ResponseOutput> {
    const path = `/v1/sessions/${encodeURIComponent(NonEmptyValueSchema.parse(id))}/${action}`;
    const init = jsonRequest('POST', requestSchema, value);
    if (requestId === undefined) return this.request(path, responseSchema, init);
    const headers = new Headers(init.headers);
    headers.set(FY_REQUEST_ID_HEADER, requestId);
    return this.request(path, responseSchema, { ...init, headers });
  }
}
