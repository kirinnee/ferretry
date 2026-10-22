import type { z } from 'zod';
import type { AnalyticsResponse } from './analytics.ts';
import type { ProjectList, SessionSkills } from './catalog.ts';
import type { ConfigChangeFrame } from './config-changes.ts';
import type { DaemonRestartPatience } from './daemon-restart.ts';
import type { DaemonUpdateSettingsPatch, DaemonUpdateStartRequest, DaemonUpdateView } from './daemon-update.ts';
import type { ForeignHistoryListing, ImportedConversationDetail } from './foreign-history.ts';
import type { SessionHandoverReceipt, SessionHandoverRequestInput } from './handover.ts';
import type { HarnessUpdateStartRequest, HarnessUpdateView } from './harness-update.ts';
import type {
  AttachmentView,
  CgroupConfigPatch,
  CgroupConfigView,
  HealthView,
  PwaConfigPatch,
  PwaConfigView,
  ScratchPlanView,
  ScratchSweepView,
  UsageFeedView,
} from './service.ts';
import type {
  ComposerDraftRequest,
  ComposerDraftResult,
  ConversionPreview,
  FyEvent,
  FyEventStreamIdle,
  MigrationConversation,
  RuntimeControlRequest,
  SendRecord,
  SendRequest,
  SendResult,
  SessionAttachTarget,
  SessionView,
  SignalKind,
  SignalOptions,
  SnapshotScope,
  StartSessionRequestInput,
  StructuredQuestionAnswer,
} from './session.ts';
import type { ForkSessionOutcome, ForkSessionRequest } from './session-fork.ts';
import type { SessionLiveActivity } from './session-live.ts';
import type { SessionTranscriptPage } from './session-transcript.ts';
import type { SessionHandoff } from './turn-handoff.ts';
import type { VersionSkew } from './version-skew.ts';
import type {
  WardenAttentionView,
  WardenConfigPatch,
  WardenConfigView,
  WardenInvestigateRequest,
  WardenInvestigateView,
  WardenLeaveRequest,
  WardenLeaveView,
  WardenRunView,
  WardenStatusView,
  WardenVerdictsView,
} from './warden.ts';

export const FY_VERSION_HEADER = 'x-fy-version';
export const FY_REQUEST_ID_HEADER = 'x-fy-request-id';
export const FY_BOARD_CAPABILITY_HEADER = 'x-fy-board-capability';

export interface IFyHttpTransport {
  send(url: string, init: RequestInit): Promise<Response>;
}

export interface IFyEventTransport {
  stream(input: { url: string; token: string; signal?: AbortSignal; onMessage(value: unknown): void }): Promise<void>;
}

export interface IFyFileLoader {
  load(path: string): Promise<{ blob: Blob; filename: string }>;
}

export interface FyClientOptions {
  baseUrl: string;
  token: string;
  version: string;
  headers?: RequestInit['headers'];
  transport?: IFyHttpTransport;
  eventTransport?: IFyEventTransport;
  fileLoader?: IFyFileLoader;
  requestId?: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Wall clock in milliseconds; injectable so the failed-send memory's expiry is testable. */
  nowMs?: () => number;
  onVersionSkew?: (skew: VersionSkew) => void;
  /**
   * Wait for a restarting daemon instead of failing (`daemon-restart.ts`). The CLI passes one; a
   * browser does not, because it shows its own reconnecting state.
   */
  restartPatience?: DaemonRestartPatience;
}

export interface IFyApiClient {
  request<T>(path: string, schema: z.ZodType<T>, init?: RequestInit, timeoutMs?: number): Promise<T>;
  health(): Promise<HealthView>;
  wardenStatus(): Promise<WardenStatusView>;
  wardenVerdicts(): Promise<WardenVerdictsView>;
  wardenReport(reportPath: string): Promise<string>;
  wardenRun(spawn?: boolean): Promise<WardenRunView>;
  wardenConfig(): Promise<WardenConfigView>;
  updateWardenConfig(patch: WardenConfigPatch): Promise<WardenConfigView>;
  /** Every ferret that needs the owner, and why. */
  wardenAttention(): Promise<WardenAttentionView>;
  /** Ask for an investigation of one ferret: it skips Jev and waits for a free slot. */
  wardenInvestigate(request: WardenInvestigateRequest): Promise<WardenInvestigateView>;
  /** Leave a flagged or cleared ferret alone for longer than the Warden would: an hour, four, or until it changes. */
  wardenLeave(request: WardenLeaveRequest): Promise<WardenLeaveView>;
  cgroupConfig(): Promise<CgroupConfigView>;
  updateCgroupConfig(patch: CgroupConfigPatch): Promise<CgroupConfigView>;
  /** How this machine's daemon was installed, the latest release, and what updating takes. */
  daemonUpdate(): Promise<DaemonUpdateView>;
  /** Start, or schedule for idle, the update to `request.target`; the daemon restarts after answering. */
  startDaemonUpdate(request: DaemonUpdateStartRequest): Promise<DaemonUpdateView>;
  updateDaemonUpdateSettings(patch: DaemonUpdateSettingsPatch): Promise<DaemonUpdateView>;
  /** How this machine's `claude` and `codex` were installed, whether Ferretry verified them, and updating them. Asks npm. */
  harnessUpdate(): Promise<HarnessUpdateView>;
  /** Start one harness's update; it runs in the daemon, and the view's `job` says how it ended. */
  startHarnessUpdate(request: HarnessUpdateStartRequest): Promise<HarnessUpdateView>;
  pwaConfig(): Promise<PwaConfigView>;
  updatePwaConfig(patch: PwaConfigPatch): Promise<PwaConfigView>;
  usage(): Promise<UsageFeedView>;
  projects(): Promise<ProjectList>;
  sessionSkills(id: string): Promise<SessionSkills>;
  analytics(query?: string): Promise<AnalyticsResponse>;
  foreignHistory(): Promise<ForeignHistoryListing>;
  foreignHistoryConversation(id: string): Promise<ImportedConversationDetail>;
  scratchPlan(limit?: number): Promise<ScratchPlanView[]>;
  scratchSweep(force?: boolean): Promise<ScratchSweepView>;
  list(): Promise<SessionView[]>;
  suggestNames(count?: number): Promise<string[]>;
  get(id: string, signal?: AbortSignal): Promise<SessionView>;
  start(input: StartSessionRequestInput, requestId?: string, boardCapability?: string): Promise<SessionView>;
  /**
   * `requestId` is the LOGICAL identity of one message — the daemon's send id. Supply the same one to
   * retry a send whose answer was lost and it is applied once. Omitted, the client reuses the id of
   * an identical send to the same session that failed in the last ten minutes, so a person pressing
   * Send again after an error cannot make the agent read the message twice.
   */
  send(id: string, input: SendRequest, requestId?: string): Promise<SendResult>;
  /** Every send this session's ledger holds, newest first, each with the fate the daemon has proven. */
  sends(id: string): Promise<SendRecord[]>;
  /** One send, by its id: how a sender learns where its message settled. */
  sendStatus(id: string, sendId: string): Promise<SendRecord>;
  /**
   * Re-attempts one send under its ORIGINAL id. Allowed while the daemon has proven it absent; `force`
   * re-sends an unconfirmed one, whose original may still have landed.
   */
  retrySend(id: string, sendId: string, force?: boolean): Promise<SendRecord>;
  /**
   * Takes back one send that was not proven delivered, erasing it from the agent's composer when it
   * is sitting typed there. The record's `cancelEffect` says what happened on the agent's screen.
   */
  cancelSend(id: string, sendId: string): Promise<SendRecord>;
  /** Presses Enter once for a send that is sitting typed, and not sent, in the agent's composer. */
  submitSend(id: string, sendId: string): Promise<SendRecord>;
  /**
   * Presses Enter on, or erases, the person's own draft in the agent's composer — the text a
   * `composer_occupied` refusal quoted back — and only while the composer still holds exactly that.
   */
  resolveComposerDraft(id: string, request: ComposerDraftRequest): Promise<ComposerDraftResult>;
  answer(
    id: string,
    toolUseId: string,
    labels: string[],
    other?: string,
    responses?: string[],
    answers?: StructuredQuestionAnswer[],
    requestId?: string,
  ): Promise<SessionView>;
  interrupt(id: string): Promise<SessionView>;
  stop(id: string, reason?: string): Promise<SessionView>;
  resume(id: string, message?: string): Promise<SessionView>;
  /**
   * Change a running harness's native runtime settings. The daemon returns the
   * fresh session view so callers can replace stale launch preferences with
   * whatever the harness has actually reported.
   */
  runtime(id: string, request: RuntimeControlRequest, requestId?: string): Promise<SessionView>;
  /**
   * `requestId` is the LOGICAL identity of one migration, and it is what makes this route safe to
   * retry. A migration is destructive — the pane is killed and relaunched — and `request()` retries
   * a POST up to three times on transport failure, so without a stable id a lost response would
   * relaunch the session a second time. Omitted, one is minted per call, which is correct for a
   * caller that never retries and wrong for one that does.
   */
  migrate(
    id: string,
    agent: string,
    model?: string,
    allowContextDowngrade?: boolean,
    requestId?: string,
    forceInflight?: boolean,
    /** Omitted, the daemon resumes the bound conversation or refuses; see `MigrationConversation`. */
    conversation?: MigrationConversation,
  ): Promise<SessionView>;
  /**
   * What a cross-harness move onto `agent` (`conversation: 'convert'`) would carry, or why it cannot be
   * made. A read: nothing is written and no request id is needed.
   */
  conversionPreview(id: string, agent: string, model?: string): Promise<ConversionPreview>;
  /**
   * Start a cross-harness handover of a top-level session. Returns the durable receipt at its current
   * phase (HTTP 202); poll it with `handoverReceipt`. `requestId` is the LOGICAL identity of one handover
   * and is what makes the POST safe to retry — it travels on FY_REQUEST_ID_HEADER, supplied when the caller
   * retries and minted per call otherwise.
   */
  handover(id: string, request: SessionHandoverRequestInput, requestId?: string): Promise<SessionHandoverReceipt>;
  /** Read the durable handover receipt for a session at any phase, terminal included. */
  handoverReceipt(id: string): Promise<SessionHandoverReceipt>;
  /** Cancel an in-flight handover; returns the receipt in its resulting terminal phase. */
  cancelHandover(id: string, requestId?: string): Promise<SessionHandoverReceipt>;
  /**
   * Fork one session's conversation, through an exact durable message, into a fresh session.
   *
   * `input` is passed WHOLE rather than as four arguments, because every field is a decision the
   * caller made — which message, which agent, which model, which effort — and a positional list of
   * three optional strings is the shape a caller silently gets wrong.
   *
   * `requestId` is the LOGICAL identity of one fork. `request()` retries a POST up to three times on
   * transport failure, so without a stable id a lost response would leave a second forked session
   * behind — an outcome no reader can distinguish from having asked twice.
   */
  fork(id: string, input: ForkSessionRequest, requestId?: string): Promise<ForkSessionOutcome>;
  rename(id: string, name?: string, teammate?: string, clearParent?: boolean): Promise<SessionView>;
  signal(id: string, kind: SignalKind, message?: string, options?: SignalOptions): Promise<SessionView>;
  remove(id: string, purge?: boolean, force?: boolean): Promise<void>;
  attachTarget(id: string): Promise<SessionAttachTarget>;
  snapshot(id: string, scope?: SnapshotScope): Promise<string>;
  logs(id: string, turn?: number): Promise<string>;
  /**
   * Read one session's durable conversation as rows a caller can fork through. This is NOT `logs`
   * with structure: the cursor and each row's binding are OPAQUE DAEMON-ISSUED BYTES, stored and sent
   * back unchanged — never trimmed, parsed, derived, normalized, hashed or re-signed. The daemon owns
   * the default page size, so an omitted `limit` stays absent rather than gaining a client-side default.
   */
  messages(id: string, cursor?: string, limit?: number, signal?: AbortSignal): Promise<SessionTranscriptPage>;
  /** What the person sent in one hand-off (`turn-008`, `queued-<send id>`): the message behind the pointer a transcript records. */
  handoff(id: string, name: string): Promise<SessionHandoff>;
  events(id: string, after?: number, limit?: number, signal?: AbortSignal): Promise<FyEvent[]>;
  history(id: string, after?: number, limit?: number): Promise<FyEvent[]>;
  upload(id: string, file: string | Blob, filename?: string): Promise<AttachmentView>;
  stream(
    sessionId: string | undefined,
    after: number,
    onEvent: (event: FyEvent) => void,
    signal?: AbortSignal,
    onIdle?: (idle: FyEventStreamIdle) => void,
    /**
     * Asks a per-session stream for its working turn's live readout (`?live=1`) and receives each
     * sample. Ignored for a fleet stream, which has no one turn to read.
     */
    onLive?: (live: SessionLiveActivity) => void,
  ): Promise<void>;
  /**
   * The configuration stream (`/v1/events?topic=config`): the revision in effect first, then every
   * change as it happens — which kinds of configuration moved. Resolves when the daemon ends it.
   */
  configChanges(onFrame: (frame: ConfigChangeFrame) => void, signal?: AbortSignal): Promise<void>;
}
