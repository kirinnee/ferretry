import type { z } from 'zod';
import type { AnalyticsResponse } from './analytics.ts';
import type { ProjectList, SessionSkills } from './catalog.ts';
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
  WardenConfigPatch,
  WardenConfigView,
  WardenRunView,
  WardenStatusView,
  WardenVerdictsView,
} from './service.ts';
import type {
  FyEvent,
  FyEventStreamIdle,
  RuntimeControlRequest,
  SendRequest,
  SendResult,
  SessionAttachTarget,
  SessionView,
  SignalKind,
  SignalOptions,
  StartSessionRequestInput,
} from './session.ts';
import type { VersionSkew } from './version-skew.ts';

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
  onVersionSkew?: (skew: VersionSkew) => void;
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
  cgroupConfig(): Promise<CgroupConfigView>;
  updateCgroupConfig(patch: CgroupConfigPatch): Promise<CgroupConfigView>;
  pwaConfig(): Promise<PwaConfigView>;
  updatePwaConfig(patch: PwaConfigPatch): Promise<PwaConfigView>;
  usage(): Promise<UsageFeedView>;
  projects(): Promise<ProjectList>;
  sessionSkills(id: string): Promise<SessionSkills>;
  analytics(query?: string): Promise<AnalyticsResponse>;
  scratchPlan(limit?: number): Promise<ScratchPlanView[]>;
  scratchSweep(force?: boolean): Promise<ScratchSweepView>;
  list(): Promise<SessionView[]>;
  suggestNames(count?: number): Promise<string[]>;
  get(id: string, signal?: AbortSignal): Promise<SessionView>;
  start(input: StartSessionRequestInput, requestId?: string, boardCapability?: string): Promise<SessionView>;
  send(id: string, input: SendRequest): Promise<SendResult>;
  answer(id: string, toolUseId: string, labels: string[], other?: string, responses?: string[]): Promise<SessionView>;
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
  ): Promise<SessionView>;
  rename(id: string, name?: string, teammate?: string, clearParent?: boolean): Promise<SessionView>;
  signal(id: string, kind: SignalKind, message?: string, options?: SignalOptions): Promise<SessionView>;
  remove(id: string, purge?: boolean, force?: boolean): Promise<void>;
  attachTarget(id: string): Promise<SessionAttachTarget>;
  snapshot(id: string): Promise<string>;
  logs(id: string, turn?: number): Promise<string>;
  events(id: string, after?: number, limit?: number, signal?: AbortSignal): Promise<FyEvent[]>;
  history(id: string, after?: number, limit?: number): Promise<FyEvent[]>;
  upload(id: string, file: string | Blob, filename?: string): Promise<AttachmentView>;
  stream(
    sessionId: string | undefined,
    after: number,
    onEvent: (event: FyEvent) => void,
    signal?: AbortSignal,
    onIdle?: (idle: FyEventStreamIdle) => void,
  ): Promise<void>;
}
