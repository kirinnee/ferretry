import { z } from 'zod';
import { type AnalyticsResponse, AnalyticsResponseSchema } from '../lib/analytics.ts';
import { type ProjectList, ProjectListSchema, type SessionSkills, SessionSkillsSchema } from '../lib/catalog.ts';
import {
  FY_REQUEST_ID_HEADER,
  FY_VERSION_HEADER,
  type FyClientOptions,
  type IFyApiClient,
  type IFyEventTransport,
  type IFyFileLoader,
  type IFyHttpTransport,
} from '../lib/client.ts';
import { ApiErrorResponseSchema, NonNegativeIntegerSchema, PositiveIntegerSchema } from '../lib/common.ts';
import { CONFIG_CHANGE_TOPIC, type ConfigChangeFrame, ConfigChangeFrameSchema } from '../lib/config-changes.ts';
import {
  classifyDaemonUnreachable,
  type DaemonAttempt,
  type DaemonRestartPatience,
  daemonStartingOf,
  waitOutDaemonRestart,
} from '../lib/daemon-restart.ts';
import {
  type DaemonUpdateSettingsPatch,
  DaemonUpdateSettingsPatchSchema,
  type DaemonUpdateStartRequest,
  DaemonUpdateStartRequestSchema,
  type DaemonUpdateView,
  DaemonUpdateViewSchema,
} from '../lib/daemon-update.ts';
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
  type HarnessUpdateStartRequest,
  HarnessUpdateStartRequestSchema,
  type HarnessUpdateView,
  HarnessUpdateViewSchema,
} from '../lib/harness-update.ts';
import { OpenUrlRequestSchema, type OpenUrlView, OpenUrlViewSchema } from '../lib/open-url.ts';
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
} from '../lib/service.ts';
import {
  type AnswerSessionRequest,
  AnswerSessionRequestSchema,
  AskToStopJobsRequestSchema,
  type AskToStopJobsResult,
  AskToStopJobsResultSchema,
  type ComposerDraftRequest,
  ComposerDraftRequestSchema,
  type ComposerDraftResult,
  ComposerDraftResultSchema,
  type ConversionPreview,
  ConversionPreviewRequestSchema,
  ConversionPreviewSchema,
  type FyEvent,
  FyEventListSchema,
  FyEventStreamFrameSchema,
  type FyEventStreamIdle,
  InterruptSessionRequestSchema,
  MigrateSessionRequestSchema,
  type MigrationConversation,
  NameSuggestionsSchema,
  RenameSessionRequestSchema,
  ResumeSessionRequestSchema,
  type RuntimeControlRequest,
  RuntimeControlRequestSchema,
  SendCancelRequestSchema,
  SendListResponseSchema,
  type SendRecord,
  SendRecordSchema,
  type SendRequest,
  SendRequestSchema,
  type SendResult,
  SendResultSchema,
  SendRetryRequestSchema,
  SendSubmitRequestSchema,
  type SessionAttachTarget,
  SessionAttachTargetSchema,
  SessionListSchema,
  type SessionView,
  SessionViewSchema,
  type SignalKind,
  type SignalOptions,
  SignalSessionRequestSchema,
  type SnapshotScope,
  SnapshotScopeSchema,
  type StartSessionRequestInput,
  StartSessionRequestSchema,
  StopSessionRequestSchema,
} from '../lib/session.ts';
import {
  type ForkSessionOutcome,
  ForkSessionOutcomeSchema,
  type ForkSessionRequest,
  ForkSessionRequestSchema,
} from '../lib/session-fork.ts';
import {
  SESSION_LIVE_STREAM_FLAG,
  SESSION_TRANSCRIPT_STREAM_FLAG,
  type SessionLiveActivity,
  type SessionTranscriptMoved,
} from '../lib/session-live.ts';
import {
  type RestartCancelResult,
  RestartCancelResultSchema,
  type RestartRequest,
  RestartRequestSchema,
  type RestartResult,
  RestartResultSchema,
  type RestartStatus,
  RestartStatusSchema,
} from '../lib/session-restart.ts';
import {
  type LogPageOptions,
  type SessionLogPage,
  SessionLogPageSchema,
  type SessionTranscriptPage,
  SessionTranscriptPageSchema,
} from '../lib/session-transcript.ts';
import {
  type MachineSkillsInventory,
  MachineSkillsInventorySchema,
  type SessionSkillsInventory,
  SessionSkillsInventorySchema,
  type SkillFile,
  SkillFileSchema,
} from '../lib/skills-inventory.ts';
import { type TranscriptImageDownload, TranscriptImageDownloadSchema } from '../lib/transcript-images.ts';
import { type SessionHandoff, SessionHandoffNameSchema, SessionHandoffSchema } from '../lib/turn-handoff.ts';
import {
  detectVersionSkew,
  formatUnknownRouteError,
  ProtocolVersionSchema,
  type VersionSkew,
} from '../lib/version-skew.ts';
import {
  LEGACY_WARDEN_ATTENTION_PATH,
  WARDEN_INVESTIGATE_PATH,
  WARDEN_LEAVE_PATH,
  type WardenAgendaView,
  WardenAgendaViewSchema,
  type WardenConfigPatch,
  WardenConfigPatchSchema,
  type WardenConfigView,
  WardenConfigViewSchema,
  type WardenInvestigateRequest,
  WardenInvestigateRequestSchema,
  type WardenInvestigateView,
  WardenInvestigateViewSchema,
  type WardenLeaveRequest,
  WardenLeaveRequestSchema,
  type WardenLeaveView,
  WardenLeaveViewSchema,
  WardenRunRequestSchema,
  type WardenRunView,
  WardenRunViewSchema,
  type WardenStatusView,
  WardenStatusViewSchema,
  type WardenVerdictsView,
  WardenVerdictsViewSchema,
} from '../lib/warden.ts';

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

const unreachableOrFailed = (error: unknown): DaemonAttempt<Response> => {
  const how = classifyDaemonUnreachable(error);
  return how === undefined ? { kind: 'failed', error } : { kind: 'unreachable', how, error };
};

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
    /**
     * The whole error body as the daemon sent it, for a refusal that carries more than a sentence —
     * a `422 config_invalid` names every located issue (docs/config-files.md). Parsed by the caller
     * that knows its shape; never trusted as anything but data.
     */
    readonly body?: unknown,
    /**
     * The version the answering daemon stamped on the response (`x-fy-version`), when it did. It is what
     * lets a caller tell "this request is wrong" from "this machine is older than the app that sent it".
     */
    readonly daemonVersion?: string,
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

/** How long a failed send's id is offered back to an identical retry. */
const FAILED_SEND_MEMORY_MS = 10 * 60_000;
/** Bounded, so a client that fails a great many sends cannot grow without limit. */
const FAILED_SEND_MEMORY_LIMIT = 32;

/**
 * The idempotency key of a send that failed, so pressing Send again REUSES it.
 *
 * A composer that mints a fresh id per press turns "the answer was lost" into "the agent read it
 * twice": the daemon applied the first request, the browser never saw the reply, and the retry looks
 * like a new message. Remembering the failed id per (session, message, attachments) — and only for
 * ten minutes — makes that retry the same logical send, which the daemon's ledger applies once.
 * `now` is deliberately not part of the key: an interrupt-then-send retry is still the same message.
 */
class FailedSendMemory {
  readonly #entries = new Map<string, { readonly requestId: string; readonly at: number }>();

  constructor(private readonly nowMs: () => number) {}

  recall(key: string): string | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (this.nowMs() - entry.at <= FAILED_SEND_MEMORY_MS) return entry.requestId;
    this.#entries.delete(key);
    return undefined;
  }

  remember(key: string, requestId: string): void {
    this.#entries.delete(key);
    this.#entries.set(key, { requestId, at: this.nowMs() });
    for (const oldest of this.#entries.keys()) {
      if (this.#entries.size <= FAILED_SEND_MEMORY_LIMIT) break;
      this.#entries.delete(oldest);
    }
  }

  forget(key: string): void {
    this.#entries.delete(key);
  }
}

/** How many transcript reads keep their validator. A few open chats each; past that the oldest re-reads whole. */
const VALIDATED_LOG_LIMIT = 16;

/** The body a read last answered, and the `etag` that names it. */
interface ValidatedText {
  readonly etag: string;
  readonly body: string;
}

/**
 * The last transcript each read path answered, so the next read of it can be conditional.
 *
 * The chat page reads a session's whole transcript tail every few seconds, and a quiet session answers
 * the same text each time — hundreds of kilobytes on a metered relay for nothing. Holding the last body
 * and its `etag` lets the next read send `If-None-Match` and take a bodyless `304` instead.
 *
 * In memory and per client, which is per daemon connection: nothing here outlives the page or reaches
 * another daemon. Bounded and least-recently-used, keyed by the exact read path (session and query), so
 * `?turn=` reads never answer for the whole tail. The body is the daemon's already-redacted text.
 */
class ValidatedLogMemory {
  readonly #entries = new Map<string, ValidatedText>();

  recall(path: string): ValidatedText | undefined {
    return this.#entries.get(path);
  }

  remember(path: string, entry: ValidatedText): void {
    this.#entries.delete(path);
    this.#entries.set(path, entry);
    for (const oldest of this.#entries.keys()) {
      if (this.#entries.size <= VALIDATED_LOG_LIMIT) break;
      this.#entries.delete(oldest);
    }
  }

  forget(path: string): void {
    this.#entries.delete(path);
  }
}

/** The fleet list a read last answered, and the `etag` that names it. */
interface ValidatedSessions {
  readonly etag: string;
  readonly sessions: readonly SessionView[];
}

/** A successful answer's body: none for a `204`, parsed JSON when it says so, its text otherwise. */
async function responsePayload(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  if ((response.headers.get('content-type') ?? '').includes('application/json')) return await response.json();
  return await response.text();
}

/** One logical message: the session, the exact text, and the attachment set in a stable order. */
function failedSendKey(id: string, input: SendRequest): string {
  return JSON.stringify([id, input.message, [...(input.attachmentIds ?? [])].sort()]);
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
  readonly #failedSends: FailedSendMemory;
  readonly #validatedLogs = new ValidatedLogMemory();
  #validatedSessions: ValidatedSessions | undefined;
  readonly #nowMs: () => number;
  readonly #restartPatience: DaemonRestartPatience | undefined;
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
    this.#nowMs = options.nowMs ?? Date.now;
    this.#failedSends = new FailedSendMemory(this.#nowMs);
    this.#restartPatience = options.restartPatience;
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
    return schema.parse(await responsePayload(await this.#exchange(path, init, timeoutMs, false)));
  }

  /**
   * One request to its answer: retried, waited out across a restart, and refused unless it succeeded.
   *
   * `notModified` admits a `304` as an answer rather than an error. Only a caller that SENT a validator
   * may pass it: a `304` to anyone else has no body it could stand for, and reading its empty text as
   * the answer would show an empty transcript as though the session had said nothing.
   */
  async #exchange(path: string, init: RequestInit, timeoutMs: number, notModified: boolean): Promise<Response> {
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
        response = await this.#send(path, init, headers, timeoutMs);
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

    // A daemon that is restarting refuses every quick retry above; a patient client waits it out.
    if (response === undefined && !cancelled && !timedOut) {
      const outcome = await waitOutDaemonRestart<Response>({
        attempt: () => this.#attempt(path, init, headers, timeoutMs),
        first: unreachableOrFailed(lastError),
        // Every attempt carries the same logical request id, which is what the daemon applies once.
        repeatable: true,
        patience: this.#restartPatience,
        nowMs: this.#nowMs,
        sleep: this.#sleep,
        signal: init.signal ?? undefined,
      });
      if (outcome.kind === 'answered') response = outcome.value;
      else {
        lastError = outcome.error;
        cancelled = init.signal?.aborted === true;
        timedOut = !cancelled && isTimeoutError(outcome.error);
      }
    }

    if (response === undefined) {
      const detail = lastError instanceof Error ? ` (${lastError.message})` : '';
      // WHAT WAS ATTEMPTED, NEVER WHAT IT PROVES. This used to read "fyd is unavailable at <url>", and
      // that is a claim this code cannot support: a browser that refuses a request before sending it
      // produces exactly this failure with the daemon serving and answering — no status, no body, and
      // not one line in the daemon's log. The sentence shipped in a panel and cost an owner and two
      // agents an afternoon, spent on the cause it named rather than on the one they had.
      const message = cancelled
        ? `fyd request ${path} was cancelled${detail}`
        : timedOut
          ? `fyd did not answer ${path} within ${Math.round(timeoutMs / 1_000)}s${detail}; it may still have applied the request`
          : `could not reach fyd at ${this.#baseUrl}${detail}`;
      throw new FyTransportError(message, path, timedOut, lastError);
    }

    const daemonVersion = response.headers.get(FY_VERSION_HEADER);
    this.#noteVersion(daemonVersion);

    if (!response.ok && !(notModified && response.status === 304)) {
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
          undefined,
          daemonVersion ?? undefined,
        );
      }
      throw new FyHttpError(
        payload?.error ?? `fyd returned HTTP ${response.status}`,
        response.status,
        payload?.code,
        candidate,
        daemonVersion ?? undefined,
      );
    }
    return response;
  }

  /**
   * One request on the wire. A daemon that answers that it is still STARTING is thrown as
   * {@link DaemonStartingError} rather than returned: it ran no route, so the request is exactly as
   * safe to send again as a refused connection, and the restart wait above treats it as one. Before
   * the daemon bound its address first, the same moment was a refused connection.
   */
  async #send(path: string, init: RequestInit, headers: Headers, timeoutMs: number): Promise<Response> {
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = init.signal == null ? deadline : AbortSignal.any([init.signal, deadline]);
    const response = await this.#transport.send(`${this.#baseUrl}${path}`, { ...init, headers, signal });
    const starting = await daemonStartingOf(response);
    if (starting !== undefined) throw starting;
    return response;
  }

  /** One attempt as the restart wait reads it: an answer, the daemon away, or anything else. */
  async #attempt(
    path: string,
    init: RequestInit,
    headers: Headers,
    timeoutMs: number,
  ): Promise<DaemonAttempt<Response>> {
    try {
      return { kind: 'answered', value: await this.#send(path, init, headers, timeoutMs) };
    } catch (error) {
      return unreachableOrFailed(error);
    }
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

  wardenAgenda(): Promise<WardenAgendaView> {
    return this.request(LEGACY_WARDEN_ATTENTION_PATH, WardenAgendaViewSchema);
  }

  wardenInvestigate(request: WardenInvestigateRequest): Promise<WardenInvestigateView> {
    return this.request(
      WARDEN_INVESTIGATE_PATH,
      WardenInvestigateViewSchema,
      jsonRequest('POST', WardenInvestigateRequestSchema, request),
    );
  }

  wardenLeave(request: WardenLeaveRequest): Promise<WardenLeaveView> {
    return this.request(
      WARDEN_LEAVE_PATH,
      WardenLeaveViewSchema,
      jsonRequest('POST', WardenLeaveRequestSchema, request),
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

  daemonUpdate(): Promise<DaemonUpdateView> {
    return this.request('/v1/daemon/update', DaemonUpdateViewSchema);
  }

  startDaemonUpdate(request: DaemonUpdateStartRequest): Promise<DaemonUpdateView> {
    return this.request(
      '/v1/daemon/update',
      DaemonUpdateViewSchema,
      jsonRequest('POST', DaemonUpdateStartRequestSchema, request),
    );
  }

  updateDaemonUpdateSettings(patch: DaemonUpdateSettingsPatch): Promise<DaemonUpdateView> {
    return this.request(
      '/v1/daemon/update/settings',
      DaemonUpdateViewSchema,
      jsonRequest('PATCH', DaemonUpdateSettingsPatchSchema, patch),
    );
  }

  harnessUpdate(): Promise<HarnessUpdateView> {
    return this.request('/v1/harnesses/update', HarnessUpdateViewSchema);
  }

  startHarnessUpdate(request: HarnessUpdateStartRequest): Promise<HarnessUpdateView> {
    return this.request(
      '/v1/harnesses/update',
      HarnessUpdateViewSchema,
      jsonRequest('POST', HarnessUpdateStartRequestSchema, request),
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

  skillsInventory(): Promise<MachineSkillsInventory> {
    return this.request('/v1/skills', MachineSkillsInventorySchema);
  }

  sessionSkillsInventory(id: string): Promise<SessionSkillsInventory> {
    return this.request(`/v1/sessions/${encodeURIComponent(id)}/skills/inventory`, SessionSkillsInventorySchema);
  }

  skillFile(path: string, sessionId?: string): Promise<SkillFile> {
    const search = new URLSearchParams({ path });
    if (sessionId !== undefined) search.set('sessionId', sessionId);
    return this.request(`/v1/skills/file?${search.toString()}`, SkillFileSchema);
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

  /** Hands one web address to this computer's own browser; the daemon refuses it unless the call arrived on the host. */
  openUrl(url: string): Promise<OpenUrlView> {
    return this.request('/v1/system/open-url', OpenUrlViewSchema, jsonRequest('POST', OpenUrlRequestSchema, { url }));
  }

  /**
   * Conditional, like {@link logs}: every open app re-reads the fleet on a beat, and an unchanged one
   * answers `304` instead of its whole list again (about 25 KB on a real fleet, on a metered relay).
   *
   * One list is held per client, which is per daemon connection. A `304` answers a deep copy of it, so
   * a caller gets a fresh value exactly as a full read would give one and cannot reach the held list
   * through it. The held entry is captured BEFORE the request, as in {@link logs}, and a daemon that
   * predates the tag (no `etag`) leaves nothing held, so the next read is an ordinary one.
   */
  async list(): Promise<SessionView[]> {
    const held = this.#validatedSessions;
    const response = await this.#exchange(
      '/v1/sessions',
      { method: 'GET', headers: held === undefined ? {} : { 'if-none-match': held.etag } },
      FY_REQUEST_TIMEOUT_MS,
      held !== undefined,
    );
    // Whatever is held now stays: a read that overlapped this one may already hold a newer list.
    if (held !== undefined && response.status === 304) return structuredClone([...held.sessions]);
    const sessions = SessionListSchema.parse(await responsePayload(response));
    const etag = response.headers.get('etag');
    this.#validatedSessions = etag === null ? undefined : { etag, sessions: structuredClone(sessions) };
    return sessions;
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

  async start(input: StartSessionRequestInput, requestId?: string): Promise<SessionView> {
    const parsed = StartSessionRequestSchema.parse(input);
    const logicalRequestId = NonEmptyValueSchema.parse(requestId ?? this.#requestId());

    const body = JSON.stringify(parsed);
    const digest = await payloadDigest(body);
    const headers = new Headers({
      'content-type': 'application/json',
      [FY_REQUEST_ID_HEADER]: logicalRequestId,
    });
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
    return recovered;
  }

  async send(id: string, input: SendRequest, requestId?: string): Promise<SendResult> {
    const key = failedSendKey(id, input);
    const remembered = this.#failedSends.recall(key);
    const logical = NonEmptyValueSchema.parse(requestId ?? remembered ?? this.#requestId());
    try {
      const result = await this.#post(id, 'send', SendRequestSchema, input, SendResultSchema, logical);
      this.#failedSends.forget(key);
      return result;
    } catch (error) {
      // ANY failure is remembered, not only a lost answer: a refusal before acceptance left no record,
      // so reusing its id costs nothing, while a lost answer after acceptance is exactly the case where
      // a fresh id would make the agent read the message twice.
      this.#failedSends.remember(key, logical);
      throw error;
    }
  }

  async sends(id: string): Promise<SendRecord[]> {
    const page = await this.request(
      `/v1/sessions/${encodeURIComponent(NonEmptyValueSchema.parse(id))}/sends`,
      SendListResponseSchema,
    );
    return page.sends;
  }

  sendStatus(id: string, sendId: string): Promise<SendRecord> {
    return this.request(
      `/v1/sessions/${encodeURIComponent(NonEmptyValueSchema.parse(id))}/sends/${encodeURIComponent(NonEmptyValueSchema.parse(sendId))}`,
      SendRecordSchema,
    );
  }

  retrySend(id: string, sendId: string, force?: boolean): Promise<SendRecord> {
    return this.#post(
      id,
      `sends/${encodeURIComponent(NonEmptyValueSchema.parse(sendId))}/retry`,
      SendRetryRequestSchema,
      force === true ? { force: true } : {},
      SendRecordSchema,
    );
  }

  cancelSend(id: string, sendId: string): Promise<SendRecord> {
    return this.#post(
      id,
      `sends/${encodeURIComponent(NonEmptyValueSchema.parse(sendId))}/cancel`,
      SendCancelRequestSchema,
      {},
      SendRecordSchema,
    );
  }

  submitSend(id: string, sendId: string): Promise<SendRecord> {
    return this.#post(
      id,
      `sends/${encodeURIComponent(NonEmptyValueSchema.parse(sendId))}/enter`,
      SendSubmitRequestSchema,
      {},
      SendRecordSchema,
    );
  }

  resolveComposerDraft(id: string, request: ComposerDraftRequest): Promise<ComposerDraftResult> {
    return this.#post(id, 'composer', ComposerDraftRequestSchema, request, ComposerDraftResultSchema);
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
    forceInflight = false,
    conversation?: MigrationConversation,
  ): Promise<SessionView> {
    return this.#post(
      id,
      'migrate',
      MigrateSessionRequestSchema,
      { agent, model, allowContextDowngrade, forceInflight, ...(conversation === undefined ? {} : { conversation }) },
      SessionViewSchema,
      NonEmptyValueSchema.parse(requestId ?? this.#requestId()),
    );
  }

  conversionPreview(id: string, agent: string, model?: string): Promise<ConversionPreview> {
    return this.#post(
      id,
      'conversion-preview',
      ConversionPreviewRequestSchema,
      { agent, ...(model === undefined ? {} : { model }) },
      ConversionPreviewSchema,
    );
  }

  askToStopJobs(id: string): Promise<AskToStopJobsResult> {
    return this.#post(id, 'migrate/ask-to-stop-jobs', AskToStopJobsRequestSchema, {}, AskToStopJobsResultSchema);
  }

  /** Restarts the ferrets `request` names now, and queues the busy ones; at most once per request id. */
  restart(request: RestartRequest, requestId?: string): Promise<RestartResult> {
    const init = jsonRequest('POST', RestartRequestSchema, request);
    const headers = new Headers(init.headers);
    headers.set(FY_REQUEST_ID_HEADER, NonEmptyValueSchema.parse(requestId ?? this.#requestId()));
    return this.request('/v1/restarts', RestartResultSchema, { ...init, headers });
  }

  /** The outdated ferrets and the restarts waiting for an idle moment. */
  restartStatus(): Promise<RestartStatus> {
    return this.request('/v1/restarts', RestartStatusSchema);
  }

  /** Clears every waiting restart. */
  cancelRestarts(): Promise<RestartCancelResult> {
    return this.request('/v1/restarts', RestartCancelResultSchema, { method: 'DELETE' });
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

  /** Keep one request id across request()'s transport retries so a lost response cannot fork twice. */
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

  snapshot(id: string, scope: SnapshotScope = 'history'): Promise<string> {
    const suffix = SnapshotScopeSchema.parse(scope) === 'screen' ? '&scope=screen' : '';
    return this.request(
      `/v1/sessions/${encodeURIComponent(NonEmptyValueSchema.parse(id))}/snapshot?live=true${suffix}`,
      TextResponseSchema,
    );
  }

  /**
   * Conditional when this client has read the same path before: an unchanged transcript answers `304`
   * and the body held from the last read is returned, so a caller cannot tell the two apart.
   *
   * The held entry is captured BEFORE the request, so a read of another session that evicts it while
   * this one is in flight cannot leave a `304` with nothing to stand for.
   */
  async logs(id: string, turn?: number): Promise<string> {
    const suffix = turn === undefined ? '' : `?turn=${NonNegativeIntegerSchema.parse(turn)}`;
    const path = `/v1/sessions/${encodeURIComponent(NonEmptyValueSchema.parse(id))}/logs${suffix}`;
    const held = this.#validatedLogs.recall(path);
    const response = await this.#exchange(
      path,
      { method: 'GET', headers: held === undefined ? {} : { 'if-none-match': held.etag } },
      FY_REQUEST_TIMEOUT_MS,
      held !== undefined,
    );
    if (held !== undefined && response.status === 304) {
      this.#validatedLogs.remember(path, held);
      return held.body;
    }
    const body = TextResponseSchema.parse(await responsePayload(response));
    const etag = response.headers.get('etag');
    if (etag === null) this.#validatedLogs.forget(path);
    else this.#validatedLogs.remember(path, { etag, body });
    return body;
  }

  /**
   * One page of the chat's transcript: the tail, or the page `before` a byte. Conditional like `logs`,
   * so a polled tail that has not moved is a `304` and the page held from the last read.
   */
  async logPage(id: string, options: LogPageOptions = {}): Promise<SessionLogPage> {
    const search = new URLSearchParams();
    if (options.before !== undefined) search.set('before', String(NonNegativeIntegerSchema.parse(options.before)));
    if (options.from !== undefined) search.set('from', String(NonNegativeIntegerSchema.parse(options.from)));
    if (options.limit !== undefined) search.set('limit', String(PositiveIntegerSchema.max(2_000).parse(options.limit)));
    if (options.file !== undefined) search.set('file', NonEmptyValueSchema.parse(options.file));
    const suffix = search.size === 0 ? '' : `?${search.toString()}`;
    const path = `/v1/sessions/${encodeURIComponent(NonEmptyValueSchema.parse(id))}/log-page${suffix}`;
    const held = this.#validatedLogs.recall(path);
    const response = await this.#exchange(
      path,
      { method: 'GET', headers: held === undefined ? {} : { 'if-none-match': held.etag } },
      FY_REQUEST_TIMEOUT_MS,
      held !== undefined,
    );
    if (held !== undefined && response.status === 304) {
      this.#validatedLogs.remember(path, held);
      return SessionLogPageSchema.parse(JSON.parse(held.body));
    }
    const page = SessionLogPageSchema.parse(await responsePayload(response));
    const etag = response.headers.get('etag');
    if (etag === null) this.#validatedLogs.forget(path);
    else this.#validatedLogs.remember(path, { etag, body: JSON.stringify(page) });
    return page;
  }

  handoff(id: string, name: string): Promise<SessionHandoff> {
    return this.request(
      `/v1/sessions/${encodeURIComponent(NonEmptyValueSchema.parse(id))}/handoffs/${SessionHandoffNameSchema.parse(name)}`,
      SessionHandoffSchema,
    );
  }

  transcriptImage(id: string, handle: string): Promise<TranscriptImageDownload> {
    return this.request(
      `/v1/sessions/${encodeURIComponent(NonEmptyValueSchema.parse(id))}/transcript-images/${encodeURIComponent(NonEmptyValueSchema.parse(handle))}`,
      TranscriptImageDownloadSchema,
    );
  }

  /** The cursor is opaque daemon evidence: validate it, but send its original bytes without trimming. */
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
    onLive?: (live: SessionLiveActivity) => void,
    onTranscript?: (moved: SessionTranscriptMoved) => void,
  ): Promise<void> {
    const url = new URL(`${this.#baseUrl}/v1/events`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('after', String(NonNegativeIntegerSchema.parse(after)));
    if (sessionId !== undefined) url.searchParams.set('sessionId', NonEmptyValueSchema.parse(sessionId));
    if (sessionId !== undefined && onLive !== undefined) url.searchParams.set('live', SESSION_LIVE_STREAM_FLAG);
    if (sessionId !== undefined && onTranscript !== undefined)
      url.searchParams.set('transcript', SESSION_TRANSCRIPT_STREAM_FLAG);
    return this.#eventTransport.stream({
      url: url.toString(),
      token: this.#token,
      ...(signal === undefined ? {} : { signal }),
      onMessage: value => {
        const frame = FyEventStreamFrameSchema.parse(value);
        if (frame.kind === 'event') onEvent(frame.event);
        else if (frame.kind === 'live') onLive?.(frame.live);
        else if (frame.kind === 'transcript') onTranscript?.(frame.transcript);
        else onIdle?.(frame);
      },
    });
  }

  fleetEvents(
    tail: number,
    onEvent: (event: FyEvent) => void,
    signal?: AbortSignal,
    onIdle?: (idle: FyEventStreamIdle) => void,
  ): Promise<void> {
    const url = new URL(`${this.#baseUrl}/v1/events`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('tail', String(NonNegativeIntegerSchema.parse(tail)));
    return this.#eventTransport.stream({
      url: url.toString(),
      token: this.#token,
      ...(signal === undefined ? {} : { signal }),
      onMessage: value => {
        const frame = FyEventStreamFrameSchema.parse(value);
        if (frame.kind === 'event') onEvent(frame.event);
        else if (frame.kind === 'idle') onIdle?.(frame);
      },
    });
  }

  configChanges(onFrame: (frame: ConfigChangeFrame) => void, signal?: AbortSignal): Promise<void> {
    const url = new URL(`${this.#baseUrl}/v1/events`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('topic', CONFIG_CHANGE_TOPIC);
    return this.#eventTransport.stream({
      url: url.toString(),
      token: this.#token,
      ...(signal === undefined ? {} : { signal }),
      onMessage: value => onFrame(ConfigChangeFrameSchema.parse(value)),
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
