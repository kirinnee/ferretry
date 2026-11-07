/**
 * THE ONE SEAM to the app shell (GAP(app-shell)). Every file of this half takes what the shell owns — its UI kit and
 * hooks, the paired-daemon client, the router, the stores and the session, board and push shapes — from here and from
 * nowhere else. A plugin half may not import the app package (`context-imports`) and the shell offers a plugin half
 * none of this yet, so until it does the names below are placeholders that say so when used (the `missing` ones), plus a
 * few small pure helpers copied from the shell unchanged so the half's pure code runs and tests on its own. Names are
 * today's, unchanged: the shell fills them by re-exporting, and nothing else in this half changes.
 */

import { type AgendaId, AgendaIdSchema } from './wire/index.ts';

type Primitive = (...args: Opaque[]) => Opaque;

/**
 * A shell type this half only passes along or reads a field of. The shell's real types replace these when it exposes
 * them; until then a field read is unchecked, which is why each is named for what it stands for.
 */
// biome-ignore lint/suspicious/noExplicitAny: a placeholder for a shell-owned type, replaced when the shell exposes it
export type Opaque = any;

const missing =
  (name: string): Primitive =>
  () => {
    throw new Error(`The app shell does not provide ${name} to plugin halves yet.`);
  };

// ─── the clock ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The one clock this half reads and waits on (banned-globals: no bare `Date.now`, `setTimeout` or `setInterval` in a
 * half). The shell replaces it with its kernel clock; this stand-in uses no banned global: the wall clock from the
 * performance timeline, and timers from an abort signal's timeout.
 */
export interface ShellClock {
  /** Epoch milliseconds now. */
  readonly nowMs: () => number;
  /** Runs `run` once after `ms`; calling the answer cancels it. */
  readonly after: (run: () => void, ms: number) => () => void;
  /** Runs `run` every `ms` until the answer is called. */
  readonly every: (run: () => void, ms: number) => () => void;
}

const clockAfter = (run: () => void, ms: number): (() => void) => {
  const signal = AbortSignal.timeout(Math.max(0, ms));
  const fire = (): void => run();
  signal.addEventListener('abort', fire, { once: true });
  return () => signal.removeEventListener('abort', fire);
};

export const shellClock: ShellClock = {
  nowMs: () => Math.round(performance.timeOrigin + performance.now()),
  after: clockAfter,
  every: (run, ms) => {
    let cancel = (): void => undefined;
    const arm = (): void => {
      cancel = clockAfter(() => {
        run();
        arm();
      }, ms);
    };
    arm();
    return () => cancel();
  },
};

// ─── UI primitives, components and hooks ──────────────────────────────────────────────────────────────────────────

export const ActionsMenu: Primitive = missing('ActionsMenu');
export const AgendaCountBadge: Primitive = missing('AgendaCountBadge');
export const AppBar: Primitive = missing('AppBar');
export const AppShell: Primitive = missing('AppShell');
export const AppTabBar: Primitive = missing('AppTabBar');
export const BoardSendBack: Primitive = missing('BoardSendBack');
export const BottomSheet: Primitive = missing('BottomSheet');
export const Button: Primitive = missing('Button');
export const ChatProse: Primitive = missing('ChatProse');
export const Composer: Primitive = missing('Composer');
export const ContextFilterChips: Primitive = missing('ContextFilterChips');
export const CopyButton: Primitive = missing('CopyButton');
export const CopyPlanHost: Primitive = missing('CopyPlanHost');
export const DaemonTaskReferences: Primitive = missing('DaemonTaskReferences');
export const DEFAULT_LIST_FILTER: Primitive = missing('DEFAULT_LIST_FILTER');
export const DictationControl: Primitive = missing('DictationControl');
export const HowToTest: Primitive = missing('HowToTest');
export const InfoAbout: Primitive = missing('InfoAbout');
export const InfoPanel: Primitive = missing('InfoPanel');
export const InputCardHost: Primitive = missing('InputCardHost');
export const LiveMarkdownEditor: Primitive = missing('LiveMarkdownEditor');
export const Markdown: Primitive = missing('Markdown');
export const OwnMessageRow: Primitive = missing('OwnMessageRow');
export const PhoneApprovalHost: Primitive = missing('PhoneApprovalHost');
export const ReferenceSurfaceProvider: Primitive = missing('ReferenceSurfaceProvider');
export const RouteLink: Primitive = missing('RouteLink');
export const SessionsBarAgenda: Primitive = missing('SessionsBarAgenda');
export const SessionsBarNeedsYou: Primitive = missing('SessionsBarNeedsYou');
export const SignInRuleSuggestionHost: Primitive = missing('SignInRuleSuggestionHost');
export const Spinner: Primitive = missing('Spinner');
export const TaskPlanHost: Primitive = missing('TaskPlanHost');
export const Textarea: Primitive = missing('Textarea');
export const Transcript: Primitive = missing('Transcript');
export const TranscriptRow: Primitive = missing('TranscriptRow');
export const TranscriptTextRow: Primitive = missing('TranscriptTextRow');
export const TwoFactorSeedHost: Primitive = missing('TwoFactorSeedHost');
export const useAnsweredSuggestionSweep: Primitive = missing('useAnsweredSuggestionSweep');
export const useBoard: Primitive = missing('useBoard');
export const useBoardActions: Primitive = missing('useBoardActions');
export const useBoardProjects: Primitive = missing('useBoardProjects');
export const useBoardTask: Primitive = missing('useBoardTask');
export const useDaemonFetch: Primitive = missing('useDaemonFetch');
export const useDaemonHealth: Primitive = missing('useDaemonHealth');
export const useDialogFocus: Primitive = missing('useDialogFocus');
export const useLayoutMode: Primitive = missing('useLayoutMode');
export const useOptionalAppStore: Primitive = missing('useOptionalAppStore');
export const useOptionalRouter: Primitive = missing('useOptionalRouter');
export const useOptionalSessionQuota: Primitive = missing('useOptionalSessionQuota');
export const usePrefersReducedMotion: Primitive = missing('usePrefersReducedMotion');
export const useQuoteMenu: Primitive = missing('useQuoteMenu');
export const useReferenceSurface: Primitive = missing('useReferenceSurface');
export const useRouter: Primitive = missing('useRouter');
export const useSendBackFiles: Primitive = missing('useSendBackFiles');
export const useSettledBusy: Primitive = missing('useSettledBusy');
export const useTouchAffected: Primitive = missing('useTouchAffected');

// ─── shell data: the daemon client, paired daemons, router, stores, sessions, boards and pushes ──────────────────────

export const agendaOn: Primitive = missing('agendaOn');
export const askedByPerson: Primitive = missing('askedByPerson');
export const boardDone: Primitive = missing('boardDone');
export const boundDaemonId: Primitive = missing('boundDaemonId');
export const browserClipboardWriter: Primitive = missing('browserClipboardWriter');
export const cardProse: Primitive = missing('cardProse');
export const clockOfInstant: Primitive = missing('clockOfInstant');
export const composerQuoteTarget: Primitive = missing('composerQuoteTarget');
export const createAppStore: Primitive = missing('createAppStore');
export class DaemonBoardStore {
  constructor(..._args: Opaque[]) {
    throw new Error('The app shell does not provide DaemonBoardStore to plugin halves yet.');
  }
}
export const DaemonClientProvider: Primitive = missing('DaemonClientProvider');
export class DaemonPushDevices {
  constructor(..._args: Opaque[]) {
    throw new Error('The app shell does not provide DaemonPushDevices to plugin halves yet.');
  }
}
export const DEFAULT_STT_SETTINGS: Primitive = missing('DEFAULT_STT_SETTINGS');
export const disablePushDelivery: Primitive = missing('disablePushDelivery');
export const documentDraftStore: Primitive = missing('documentDraftStore');
export const doneLaneOf: Primitive = missing('doneLaneOf');
export const enablePushDelivery: Primitive = missing('enablePushDelivery');
export const escapeCloses: Primitive = missing('escapeCloses');
export const filteredPushNotification: Primitive = missing('filteredPushNotification');
/** The header a request's idempotency id travels on. */
export const FY_REQUEST_ID_HEADER = 'x-fy-request-id';
/** A refusal the daemon client raised: the status and, when the daemon gave one, its code. */
export class FyHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'FyHttpError';
  }
}
export const grantRefusalNotice: Primitive = missing('grantRefusalNotice');
export const IDLE_STORE: Primitive = missing('IDLE_STORE');
export const inputContextLines: Primitive = missing('inputContextLines');
export const isSubCard: Primitive = missing('isSubCard');
export const itemCardKind: Primitive = missing('itemCardKind');
export const itemWordsReceipt: Primitive = missing('itemWordsReceipt');
export const LANE_PROPOSAL_ANSWERS: Primitive = missing('LANE_PROPOSAL_ANSWERS');
export const laneEditDestination: Primitive = missing('laneEditDestination');
export const laneProposalReference: Primitive = missing('laneProposalReference');
export const machineNotification: Primitive = missing('machineNotification');
export const machinesOffEverywhere: Primitive = missing('machinesOffEverywhere');
export const marqueeOf: Primitive = missing('marqueeOf');
export const matchesMode: Primitive = missing('matchesMode');
export const nextDetailsTab: Primitive = missing('nextDetailsTab');
export const NO_BOARD_FILTERS: Primitive = missing('NO_BOARD_FILTERS');
export const notGoodLaneOf: Primitive = missing('notGoodLaneOf');
export const notificationTapUrl: Primitive = missing('notificationTapUrl');
export const notificationUrl: Primitive = missing('notificationUrl');
export const offEverywhereSentence: Primitive = missing('offEverywhereSentence');
export const permissionOptionWords: Primitive = missing('permissionOptionWords');
export const PermissionPromptGone: Primitive = missing('PermissionPromptGone');
export const permissionWords: Primitive = missing('permissionWords');
export const PUSH_INACTIVE_MESSAGE: Primitive = missing('PUSH_INACTIVE_MESSAGE');
export const PUSH_UNSUPPORTED_MESSAGE: Primitive = missing('PUSH_UNSUPPORTED_MESSAGE');
export const readPushDelivery: Primitive = missing('readPushDelivery');
export const readTouchAffected: Primitive = missing('readTouchAffected');
export const registerComposerQuoteTarget: Primitive = missing('registerComposerQuoteTarget');
export const revokePushDevice: Primitive = missing('revokePushDevice');
export const RouterProvider: Primitive = missing('RouterProvider');
export const serverTouchAffected: Primitive = missing('serverTouchAffected');
export const sessionActionSections: Primitive = missing('sessionActionSections');
export const sessionsBarNames: Primitive = missing('sessionsBarNames');
export const sessionsBarView: Primitive = missing('sessionsBarView');
export const sessionTask: Primitive = missing('sessionTask');
export const StoreProvider: Primitive = missing('StoreProvider');
export const subscribeToTouchAffected: Primitive = missing('subscribeToTouchAffected');
export const TABLE_VIEW_KEY: Primitive = missing('TABLE_VIEW_KEY');
export const TASK_CARD_KIND: Primitive = missing('TASK_CARD_KIND');
export const touchAffectedFrom: Primitive = missing('touchAffectedFrom');
export const turnOnAllTargets: Primitive = missing('turnOnAllTargets');
export const unverifiedNotification: Primitive = missing('unverifiedNotification');
export const wordCut: Primitive = missing('wordCut');

export type AppStore = Opaque;
export type BoardActions = Opaque;
export type BoardCardOf = Opaque;
export type BoardGroupOf = Opaque;
export type BoardMachine = Opaque;
export type BoardModel = Opaque;
export type BoardTaskState = Opaque;
export type CardKind = Opaque;
export type ClipboardWriter = Opaque;
export type ComposerProps = Opaque;
export type ComposerSent = Opaque;
export type DaemonConnectionRepository = Opaque;
export type DaemonControlsStore = Opaque;
export type DaemonFleetStore = Opaque;
export type DaemonPushService = Opaque;
export type DaemonUsageStore = Opaque;
export type FleetSnapshot = Opaque;
export type FyApiClient = Opaque;
export type FyEvent = Opaque;
export type IFyApiClient = Opaque;
export type InfoTab = Opaque;
export type Lane = Opaque;
export type LaneSet = Opaque;
export type LedgerSendRecord = Opaque;
export type MachineNotificationRow = Opaque;
export type MachinePushRegistrationLike = Opaque;
export type Marquee = Opaque;
export type MediaQueryListLike = Opaque;
export type ModeFilter = Opaque;
export type PermissionAnswerRequest = Opaque;
export type PermissionAnswerResult = Opaque;
export type PermissionRequest = Opaque;
export type PushDeliveryReport = Opaque;
export type PushDeliveryStatus = Opaque;
export type PushDeviceView = Opaque;
export type PushEnrolment = Opaque;
export type PushEnrolmentContext = Opaque;
export type PushNotificationKind = 'attention' | 'agenda' | 'question' | 'failed' | 'completed' | 'device-paired';
export type PushNotificationPayload = Opaque;
export type PushSubscriptionHandle = Opaque;
export type QueueView = Opaque;
export type ReleasedIn = Opaque;
export type RuleClient = Opaque;
export type SendBack = Opaque;
export type SendBackPorts = Opaque;
export type SessionActionContribution = Opaque;
export type SessionConfig = Opaque;
export type SessionState = Opaque;
export type SessionStatus = Opaque;
export type SessionTranscriptMessage = Opaque;
export type SessionView = Opaque;
export type TouchModalitySignals = Opaque;
export type TranscriptEntry = Opaque;

// ─── pure helpers, copied unchanged from the app shell so this half runs and tests on its own ─────────────────────
// Each is small, has no React and no network, and is the shell's own code. When the shell exposes them to plugin
// halves, delete the copy and re-export.

export type ClassValue = string | number | bigint | null | undefined | boolean | ClassValue[] | ClassDictionary;

interface ClassDictionary {
  readonly [key: string]: unknown;
}

const appendTo = (parts: string[], value: ClassValue): void => {
  if (value === null || value === undefined || value === false || value === true || value === '') return;

  if (typeof value === 'string') {
    parts.push(value);
    return;
  }

  if (typeof value === 'number' || typeof value === 'bigint') {
    // `0` is a real class name in Tailwind-adjacent code the same way `1` is,
    // so numbers are kept rather than treated as falsy.
    parts.push(String(value));
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) appendTo(parts, entry);
    return;
  }

  for (const [key, enabled] of Object.entries(value)) {
    if (enabled) parts.push(key);
  }
};

/** Joins every truthy class expression with a single space. */
export function cn(...values: readonly ClassValue[]): string {
  const parts: string[] = [];
  for (const value of values) appendTo(parts, value);
  return parts.join(' ');
}

// ─ daemon identity and scope
export type DaemonId = string & { readonly daemonId: unique symbol };

export interface DaemonConnection {
  readonly daemonId: DaemonId;
  readonly baseUrl: string;
  /** Which grant this browser holds on the daemon. An identity, not a credential. */
  readonly deviceId: string;
  readonly daemonName?: string;
  /** The daemon's published carrier set, cached in the order the protocol tries it. */
  readonly carriers: readonly unknown[];
}

export interface DaemonConnectionInput {
  daemonId: string;
  baseUrl: string;
  deviceId: string;
  daemonName?: string | undefined;
  carriers?: readonly unknown[] | undefined;
}

const requireNonEmpty = (value: string, name: string): string => {
  if (value.trim() === '') throw new Error(`${name} must not be empty`);
  return value;
};

/** Validates the durable daemon identity supplied by a successful pairing. */
export const daemonId = (value: string): DaemonId => requireNonEmpty(value, 'daemonId') as DaemonId;

/** Normalizes a daemon origin supplied at runtime: credentials, paths, queries and fragments are refused. */
export const daemonBaseUrl = (value: string): string => {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('daemon URL must be absolute');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('daemon URL must use http or https');
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('daemon URL may not include credentials, a query, or a fragment');
  }
  if (url.pathname !== '/') throw new Error('daemon URL must be an origin without a path');
  return url.origin;
};

/**
 * An immutable connection from runtime pairing output. The shell's own version also validates and orders the carrier
 * set; this one keeps the set as given, or the direct address when none was.
 */
export const daemonConnection = (input: DaemonConnectionInput): DaemonConnection => {
  const baseUrl = daemonBaseUrl(input.baseUrl);
  const name = input.daemonName?.trim() || undefined;
  const carriers =
    input.carriers === undefined || input.carriers.length === 0
      ? [{ kind: 'direct', daemonUrl: baseUrl }]
      : input.carriers;
  return {
    daemonId: daemonId(input.daemonId),
    baseUrl,
    deviceId: requireNonEmpty(input.deviceId, 'deviceId'),
    ...(name === undefined ? {} : { daemonName: name }),
    carriers,
  };
};

export interface DaemonSessionScope {
  readonly daemonId: DaemonId;
  readonly sessionId: string;
  /** The draft slot inside the ferret: the ask whose own composer this is. Absent is the ferret's chat. */
  readonly item?: AgendaId;
}

/** Creates the required `(daemonId, ferretId)` identity for UI state; `item` names an ask's own draft slot. */
export const daemonSessionScope = (
  daemon: Pick<DaemonConnection, 'daemonId'>,
  sessionId: string,
  item?: AgendaId,
): DaemonSessionScope => ({
  daemonId: daemon.daemonId,
  sessionId: requireNonEmpty(sessionId, 'sessionId'),
  ...(item === undefined ? {} : { item }),
});

/** A collision-safe key for persisted or in-memory ferret state. */
export const daemonSessionKey = (scope: DaemonSessionScope): string =>
  JSON.stringify(
    scope.item === undefined ? [scope.daemonId, scope.sessionId] : [scope.daemonId, scope.sessionId, scope.item],
  );

// ─ the transport the libs build requests with
export class DaemonResponseError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    /** The Ferretry version the answering daemon said it runs (`x-fy-version`), when the caller read it. */
    readonly daemonVersion?: string,
  ) {
    super(message);
    this.name = 'DaemonResponseError';
  }
}

export type DaemonFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

// Daemon reads must be supplied by the public @ferretry/app client/connect facility.
// This pending half has no browser-network default.

const requirePath = (value: string): string => {
  if (!value.startsWith('/') || value.startsWith('//')) throw new Error('daemon path must be an origin-relative path');
  return value;
};

/** Resolves a path against the paired daemon, never against the page origin. */
export const daemonUrl = (daemon: DaemonConnection, path: string): string => {
  const url = new URL(requirePath(path), `${daemon.baseUrl}/`);
  if (url.origin !== new URL(daemon.baseUrl).origin) throw new Error('daemon path must remain on the paired daemon');
  return url.toString();
};

const DAEMON_BINDING: unique symbol = Symbol('ferretry.daemon');
type DaemonBoundInit = RequestInit & { readonly [DAEMON_BINDING]?: DaemonId };

/** The request options, sent with the browser's credentials and bound to exactly one paired daemon. */
export const daemonBound = (daemon: DaemonConnection, init: RequestInit = {}): RequestInit => {
  const bound: DaemonBoundInit = { ...init, credentials: 'include', [DAEMON_BINDING]: daemon.daemonId };
  return bound;
};

export interface DaemonRequest {
  readonly url: string;
  readonly init: RequestInit;
}

/** Builds a browser request bound to one daemon. It carries no credential; the session it rides on does. */
export const daemonRequest = (daemon: DaemonConnection, path: string, init: RequestInit = {}): DaemonRequest => ({
  url: daemonUrl(daemon, path),
  init: daemonBound(daemon, init),
});

// ─ where a daemon's pages live
export const daemonHomePath = (id: DaemonId): string => `/d/${encodeURIComponent(id)}`;
export const daemonAgendaPath = (id: DaemonId): string => `${daemonHomePath(id)}/agenda`;
export const daemonBoardPath = (id: DaemonId): string => `${daemonHomePath(id)}/board`;
export const daemonBoardCardPath = (id: DaemonId, taskId: string): string =>
  `${daemonBoardPath(id)}/${encodeURIComponent(taskId)}`;
export const daemonSessionPath = (id: DaemonId, sessionId: string): string => {
  const scope = daemonSessionScope({ daemonId: id }, sessionId);
  return `${daemonHomePath(id)}/session/${encodeURIComponent(scope.sessionId)}`;
};

// ─ bounded concurrency, deadlines and refresh
/**
 * At most `limit` tasks run at once; the rest start in arrival order as earlier ones settle.
 *
 * For a surface that has many small reads to make of one daemon. Firing them all in one tick does not
 * make them arrive sooner — the daemon runs a session's requests sixteen at a time and every other panel
 * shares that session — it only makes everything else on the page wait behind them.
 */
export class ConcurrencyLimit {
  #running = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('a concurrency limit is a positive integer');
  }

  /** Run `task` once a slot is free. A task that throws frees its slot exactly as one that returns. */
  async run<Value>(task: () => Promise<Value>): Promise<Value> {
    if (this.#running >= this.limit) await new Promise<void>(start => this.#waiting.push(start));
    else this.#running += 1;
    try {
      return await task();
    } finally {
      // The slot passes straight to the next waiter, so `#running` never dips and lets a newcomer jump the queue.
      const next = this.#waiting.shift();
      if (next === undefined) this.#running -= 1;
      else next();
    }
  }
}

export type DeadlineSchedule = (run: () => void, delayMs: number) => () => void;

export const realSchedule: DeadlineSchedule = (run, delayMs) => shellClock.after(run, delayMs);

/** A machine-wide default: long enough for a cold relay dial, short enough that nobody waits on a corpse. */
export const MACHINE_READ_DEADLINE_MS = 20_000;

/** The reason a read gave up waiting. Its message is the plain one a status line can show. */
export class MachineDeadlineError extends Error {
  readonly deadlineMs: number;
  constructor(deadlineMs: number) {
    super(`did not answer within ${Math.round(deadlineMs / 1000)}s`);
    this.name = 'MachineDeadlineError';
    this.deadlineMs = deadlineMs;
  }
}

/**
 * `read`, or a {@link MachineDeadlineError} once `deadlineMs` has passed — whichever comes first. A late
 * settlement of `read` is swallowed here so it is never an unhandled rejection.


/** Whole-list reads share this budget, including reads asked for by different surfaces. */
export const LIST_REFRESH_MIN_MS = 10_000;

export interface ListRefreshEnvironment {
  readonly now: () => number;
  readonly schedule: DeadlineSchedule;
}

export const browserListRefreshEnvironment: ListRefreshEnvironment = {
  now: () => shellClock.nowMs(),
  schedule: realSchedule,
};

/** One in-flight read and one trailing read. The cooldown starts when the request starts. */
export class ListRefresh<T> {
  #active: Promise<T> | undefined;
  #queued:
    | { readonly promise: Promise<T>; readonly cancel: () => void; readonly reject: (error: Error) => void }
    | undefined;
  #last = Number.NEGATIVE_INFINITY;
  #dirty = false;
  #stopped = false;

  constructor(
    private readonly read: () => Promise<T>,
    private readonly environment: ListRefreshEnvironment = browserListRefreshEnvironment,
    private readonly minMs = LIST_REFRESH_MIN_MS,
  ) {}

  request(): Promise<T> {
    if (this.#stopped) return Promise.reject(new Error('List refresh was cleared'));
    if (this.#active !== undefined) return this.#active;
    if (this.#queued !== undefined) return this.#queued.promise;
    const delay = this.#last + this.minMs - this.environment.now();
    if (delay <= 0) return this.#run();
    let reject!: (error: Error) => void;
    let resolve!: (value: T | PromiseLike<T>) => void;
    const promise = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const cancel = this.environment.schedule(() => {
      this.#queued = undefined;
      resolve(this.#run());
    }, delay);
    this.#queued = { promise, cancel, reject };
    void promise.catch(() => undefined);
    return promise;
  }

  /** An event arriving during a read may describe a later write: read once more after it settles. */
  invalidate(): Promise<T> {
    if (this.#active !== undefined) this.#dirty = true;
    return this.request();
  }

  stop(): void {
    this.#stopped = true;
    this.#dirty = false;
    this.#queued?.cancel();
    this.#queued?.reject(new Error('List refresh was cleared'));
    this.#queued = undefined;
  }

  #run(): Promise<T> {
    this.#last = this.environment.now();
    const promise = new Promise<T>(resolve => resolve(this.read())).finally(() => {
      this.#active = undefined;
      if (this.#dirty) {
        this.#dirty = false;
        void this.request().catch(() => undefined);
      }
    });
    this.#active = promise;
    void promise.catch(() => undefined);
    return promise;
  }
}
export type BoardTaskId = Opaque;

// ─── what the views (app/views/*) read from the shell ─────────────────────────────────────────────────────────────

export const useAppStore: Primitive = missing('useAppStore');
export const useAgendaItemOpened: Primitive = missing('useAgendaItemOpened');
export const usePairedMachineNotifications: Primitive = missing('usePairedMachineNotifications');
export const useNotificationPreferences: Primitive = missing('useNotificationPreferences');
export const useFerretAgendaModel: Primitive = missing('useFerretAgendaModel');
export const useFerret: Primitive = missing('useFerret');
export const NotificationsOffBanner: Primitive = missing('NotificationsOffBanner');
export const MachineNotificationList: Primitive = missing('MachineNotificationList');

// ─ more pure helpers, copied unchanged from the app shell

/** Each ferret's root view by ferret id: a ferret with no parent in `sessions` is its own root. */
export const rootViews = (sessions: readonly SessionView[]): ReadonlyMap<string, SessionView> => {
  const byId = new Map(sessions.map(view => [view.config.id, view] as const));
  const roots = new Map<string, SessionView>();
  for (const view of sessions) {
    const seen = new Set<string>([view.config.id]);
    let root = view;
    for (;;) {
      const parent = root.config.parent === undefined ? undefined : byId.get(root.config.parent);
      if (parent === undefined || seen.has(parent.config.id)) break;
      seen.add(parent.config.id);
      root = parent;
    }
    roots.set(view.config.id, root);
  }
  return roots;
};

const DAEMON_ID_PATTERN = /^fy_daemon_[A-Za-z0-9_-]{43}$/u;

/**
 * The ask an `#agenda/<id>?session=<ferretId>&machine=<daemon id>` fragment names: `null` for any other fragment, an
 * id that is not one, or a machine that is not a daemon id. A fragment only picks which ask the app opens.
 */
export const agendaDeepLinkFromFragment = (
  fragment: string,
): { readonly id: AgendaId; readonly sessionId?: string; readonly machine?: DaemonId } | null => {
  const match = /^#?agenda\/([^?]+)(?:\?(.*))?$/u.exec(fragment);
  if (match === null) return null;
  let raw: string;
  try {
    raw = decodeURIComponent(match[1] ?? '');
  } catch {
    return null;
  }
  const id = AgendaIdSchema.safeParse(raw);
  if (!id.success) return null;
  const query = new URLSearchParams(match[2] ?? '');
  const session = query.get('session');
  const named = query.get('machine');
  if (named !== null && !DAEMON_ID_PATTERN.test(named)) return null;
  return {
    id: id.data,
    ...(session === null || session.trim() === '' ? {} : { sessionId: session }),
    ...(named === null ? {} : { machine: named as DaemonId }),
  };
};

/** A release or transcript replacement invalidated the caller's message evidence. */
export const staleMessageEvidence = (reason: unknown, code: 'message_cursor_stale' | 'selection_stale'): boolean =>
  reason instanceof FyHttpError && reason.status === 409 && reason.code === code;

/** Restart a whole paged read once, with fresh accumulators and no cursor from the failed attempt. */
export const withFreshMessageCursor = async <T>(read: () => Promise<T>): Promise<T> => {
  try {
    return await read();
  } catch (reason) {
    if (!staleMessageEvidence(reason, 'message_cursor_stale')) throw reason;
    return await read();
  }
};

/**
 * What a row's queue state is once the ledger has had its say: a delivered ledger fate means the agent has it,
 * whatever the queue has caught up to. `undefined` for a row the queue never saw.
 */
export const effectiveQueueState = (record: LedgerSendRecord): string | undefined => {
  const state = record.queue?.state;
  if (state === undefined) return undefined;
  if (record.fate === 'delivered' && state !== 'delivered' && state !== 'read') return 'delivered';
  return state;
};

const BRACKET_PREFIX = /^\[([^[\]]+)\]\s*(.*)$/s;

export interface ParsedTask {
  /** Bracketed prefix, when the value had one AND had a task after it. */
  readonly prefix: string | null;
  /** The task text. Empty only when the name itself was empty. */
  readonly task: string;
}

/** Splits a ferret's name into its teammate prefix and its task: `[Hayden] Fix the scroller`. */
export const parseTaskName = (name?: string | null): ParsedTask => {
  const raw = (name ?? '').trim();
  if (!raw) return { prefix: null, task: '' };
  const matched = BRACKET_PREFIX.exec(raw);
  if (!matched) return { prefix: null, task: raw };
  const prefix = (matched[1] ?? '').trim();
  const rest = (matched[2] ?? '').trim();
  if (!rest) return { prefix: null, task: prefix || raw };
  return { prefix: prefix || null, task: rest };
};

const SYSTEM_CALLSIGN_PATTERN = /^(warden|learning|pack)-([0-9a-f]{6})$/iu;

/** A callsign Ferretry gave a ferret it started itself (`warden-00002a`), shown as an identifier. */
const isSystemCallsign = (callsign: string): boolean => {
  const match = SYSTEM_CALLSIGN_PATTERN.exec(callsign.trim());
  return match?.[2] !== undefined && Number.parseInt(match[2], 16) !== 0;
};

/** Title-cases a callsign slug for display: `ms-98` → `Ms-98`; a system callsign shows its hex digits uppercase. */
export const displayCallsign = (raw: string | null | undefined): string => {
  const slug = (raw ?? '').trim();
  if (slug === '') return '';
  if (isSystemCallsign(slug)) {
    const match = SYSTEM_CALLSIGN_PATTERN.exec(slug);
    return `${(match?.[1] ?? '').toLowerCase()}-${(match?.[2] ?? '').toUpperCase()}`;
  }
  return slug
    .split('-')
    .map(segment => (segment === '' ? segment : `${segment[0]?.toUpperCase() ?? ''}${segment.slice(1)}`))
    .join('-');
};
