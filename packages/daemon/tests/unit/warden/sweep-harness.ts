import type { WardenJevCheck } from '@ferretry/protocol';
import type { TriageDecision, TriageSnapshot } from '../../../src/lib/speedups/jev.ts';
import {
  type AgendaBoardInput,
  defaultWardenConfig,
  type WardenAnomalyKind,
  type WardenAgendaWrite,
  type WardenConfig,
  type WardenEscalationBoardItem,
  type WardenEscalationRaise,
  type WardenEscalationVerdict,
  type WardenFleetSession,
  type WardenRuntimeState,
  type WardenSpawnFacts,
  type WardenSpawnProvenance,
  type WardenSpawnRequest,
  type WardenSweepPorts,
  WardenSweepService,
  type WardenSweepSettings,
  wardenEscalationSourceRef,
} from '../../../src/lib/warden/index.ts';

/**
 * The sweep, over fakes for every port: shared by the sweep's own tests and the triage tests.
 */

export const NOW = Date.parse('2026-07-31T12:00:00.000Z');

/** Jev, sure the ferret is healthy. */
export const JEV_SKIP: TriageDecision = {
  verdict: 'leave',
  confidence: 0.96,
  model: 'jev-latest',
  inputTokens: 500,
  latencyMs: 90,
  costUsd: 0.001,
};
/** Jev, unsure: the flag is handed on. */
export const JEV_INVESTIGATE: TriageDecision = { ...JEV_SKIP, verdict: 'unsure', confidence: 0.9 };
export const at = (minutes: number): string => new Date(NOW + minutes * 60_000).toISOString();

const settings = (overrides: Partial<WardenSweepSettings> = {}): WardenSweepSettings => ({
  clientName: 'fy',
  wardenCwd: '/state',
  supervisesMonitors: true,
  mayAct: false,
  ...overrides,
});

export const session = (overrides: {
  readonly id: string;
  readonly status?: WardenFleetSession['state']['status'];
  readonly label?: string;
  readonly mode?: 'auto' | 'interactive';
  readonly state?: Partial<WardenFleetSession['state']>;
  readonly hasLiveMonitor?: boolean;
}): WardenFleetSession => ({
  config: {
    id: overrides.id,
    mode: overrides.mode ?? 'auto',
    agent: 'claude-auto-a',
    intervalSeconds: 30,
    ...(overrides.label === undefined ? {} : { label: overrides.label }),
  },
  state: { status: overrides.status ?? 'running', ...overrides.state },
  directory: `/state/sessions/${overrides.id}`,
  cwd: '/home/dev/repo',
  turn: 1,
  hasLiveMonitor: overrides.hasLiveMonitor ?? true,
});

/** A session the detector will flag as an unanswered question: waiting, idle, no declared wait. */
export const unattended = (id: string): WardenFleetSession =>
  session({ id, status: 'awaiting_user', state: { lastActivityAt: at(-600) } });

/**
 * A session the detector will flag for the shared fleet triage rather than an assigned warden.
 *
 * A rate-limited session whose reset time has passed and which was never resumed. It is used instead
 * of the more obvious `abandoned_wreckage` because that class is unreachable from a sweep in both
 * this daemon and kteam: the sweep scans only `WARDEN_SCANNABLE_STATUSES`, which excludes the very
 * `failed` and `stalled` statuses wreckage is made of.
 */
export const triageable = (id: string): WardenFleetSession =>
  session({ id, status: 'rate_limited', state: { quota: { resetAt: NOW - 60_000 } } });

export interface Harness {
  readonly service: WardenSweepService;
  readonly journal: { readonly type: string; readonly data: Record<string, unknown> }[];
  readonly spawns: WardenSpawnRequest[];
  readonly provenance: Map<string, WardenSpawnProvenance>;
  /** Every escalation write the sweep attempted, in order. */
  readonly raises: { readonly sessionId: string; readonly request: WardenEscalationRaise }[];
  readonly resolved: { readonly sessionId: string; readonly sourceRef: string; readonly note: string }[];
  /** Every snapshot the Jev guard was shown, after redaction. */
  readonly guarded: readonly TriageSnapshot[];
  readonly guardSettings: readonly unknown[];
  /** Every Jev check the sweep wrote down, oldest first. */
  readonly jevChecks: readonly WardenJevCheck[];
  /** Every act a verdict carried out. */
  readonly remedies: readonly { readonly action: string; readonly sessionId: string; readonly detail: string }[];
  /** The live rows of one node's board, as the fake store now holds them. */
  board(sessionId: string): readonly WardenEscalationBoardItem[];
  seedBoard(sessionId: string, items: readonly WardenEscalationBoardItem[]): void;
  state(): WardenRuntimeState;
  setState(value: unknown): void;
  setFleet(fleet: readonly WardenFleetSession[]): void;
  storedConfig(): unknown;
}

/** A live warden escalation already on a node's board. */
export const escalated = (kind: WardenAnomalyKind): WardenEscalationBoardItem => ({
  source: 'agent-raised',
  sourceRef: wardenEscalationSourceRef(kind),
  raisedBy: 'daemon',
});

export function harness(
  options: {
    readonly config?: unknown;
    readonly state?: unknown;
    readonly fleet?: readonly WardenFleetSession[];
    readonly settings?: Partial<WardenSweepSettings>;
    readonly installed?: () => Promise<readonly string[]>;
    readonly currentName?: (reference: string) => Promise<string | undefined>;
    /** The machine's default runtime; `claude-default`, which is installed, unless a test says otherwise. */
    readonly defaultRuntime?: () => Promise<string | undefined>;
    readonly usage?: () => Promise<readonly { readonly agent: string; readonly atLimit?: boolean }[]>;
    readonly spawn?: (request: WardenSpawnRequest, call: number) => Promise<WardenSpawnFacts>;
    readonly reports?: Readonly<Record<string, string | undefined>>;
    readonly latest?: () => Promise<{ readonly reportId: string; readonly head: string } | undefined>;
    readonly writeProvenance?: () => Promise<void>;
    readonly verdicts?: () => Promise<readonly WardenEscalationVerdict[] | undefined>;
    /** Nodes whose agenda board cannot be read this sweep. */
    readonly unreadableBoards?: readonly string[];
    /** Force every raise to one outcome, for the paths a real store reaches rarely. */
    readonly raiseWrite?: WardenAgendaWrite;
    /** The Jev guard's answer to each snapshot, in order; the last one repeats. */
    readonly guard?: readonly (TriageDecision | Error)[];
    readonly evidence?: (
      sessionId: string,
    ) => Promise<{ readonly recentTurns: readonly string[]; readonly paneTail?: string }>;
    readonly redact?: (text: string) => string;
    /** Make one remedy throw. */
    readonly remedyFails?: string;
    /** How many leftover browsers a close finds; one by default. */
    readonly closeLeftoverBrowsers?: (sessionId: string) => Promise<number>;
    readonly cost?: (wardenId: string) => Promise<number | undefined>;
    readonly feedBoards?: Readonly<Record<string, AgendaBoardInput | undefined>>;
    /** The clock, for the tests that let time pass. Fixed at noon otherwise. */
    readonly now?: () => number;
    /** Make the Jev check record refuse writes, or reads. */
    readonly jevChecksFail?: 'append' | 'recent';
    /** Whether the liveness monitor has stopped seeing. The port is absent unless a test sets it. */
    readonly monitorStalled?: () => boolean;
  } = {},
): Harness {
  let configDocument: unknown = options.config ?? defaultWardenConfig;
  let stateDocument: unknown = options.state ?? {};
  let fleet: readonly WardenFleetSession[] = options.fleet ?? [];
  const journal: { readonly type: string; readonly data: Record<string, unknown> }[] = [];
  const spawns: WardenSpawnRequest[] = [];
  const provenance = new Map<string, WardenSpawnProvenance>();
  const boards = new Map<string, readonly WardenEscalationBoardItem[]>();
  const raises: { readonly sessionId: string; readonly request: WardenEscalationRaise }[] = [];
  /** The newest card text raised per `[sessionId, sourceRef]`. */
  const cards = new Map<string, WardenEscalationRaise>();
  const resolved: { readonly sessionId: string; readonly sourceRef: string; readonly note: string }[] = [];
  let spawnCall = 0;
  let capability = 0;
  const guarded: TriageSnapshot[] = [];
  const guardSettings: unknown[] = [];
  const jevChecks: WardenJevCheck[] = [];
  const remedies: { readonly action: string; readonly sessionId: string; readonly detail: string }[] = [];
  let guardCall = 0;
  const remedy = (action: string, sessionId: string, detail: string): void => {
    if (options.remedyFails === action) throw new Error(`${action} refused`);
    remedies.push({ action, sessionId, detail });
  };

  const ports: WardenSweepPorts = {
    guard: settings => {
      guardSettings.push(settings);
      return {
        decide: async snapshot => {
          guarded.push(snapshot);
          const script = options.guard ?? [JEV_SKIP];
          const next = script[Math.min(guardCall, script.length - 1)] as TriageDecision | Error;
          guardCall += 1;
          if (next instanceof Error) throw next;
          return next;
        },
      };
    },
    evidence: {
      evidence: async sessionId =>
        await (options.evidence?.(sessionId) ?? Promise.resolve({ recentTurns: ['turn one'], paneTail: 'screen' })),
    },
    redactor: { batch: async work => work({ text: options.redact ?? (text => text) }) },
    remedies: {
      nudge: async (sessionId, message) => remedy('nudge', sessionId, message),
      resume: async sessionId => remedy('resume', sessionId, ''),
      restart: async sessionId => remedy('restart', sessionId, ''),
      stop: async (sessionId, reason) => remedy('stop', sessionId, reason),
      failover: async (sessionId, agent) => remedy('failover', sessionId, agent),
      closeLeftoverBrowsers: async sessionId => {
        remedy('close_leftover', sessionId, '');
        return await (options.closeLeftoverBrowsers?.(sessionId) ?? Promise.resolve(1));
      },
    },
    costs: { costUsd: async wardenId => await (options.cost?.(wardenId) ?? Promise.resolve(undefined)) },
    // By default the feed reads the SAME fake board the escalation writes: the Warden page is a thin read
    // of the Warden's own cards.
    feed: {
      board: async sessionId =>
        options.feedBoards === undefined
          ? {
              sessionId,
              parseErrors: 0,
              items: (boards.get(sessionId) ?? []).map((item, index) => {
                const card =
                  item.sourceRef === null ? undefined : cards.get(JSON.stringify([sessionId, item.sourceRef]));
                return {
                  id: `A${index + 1}`,
                  source: item.source,
                  raisedBy: item.raisedBy,
                  ...(item.sourceRef === null ? {} : { sourceRef: item.sourceRef }),
                  subject: card?.subject ?? 'A seeded card',
                  why: card?.why ?? 'seeded',
                  waitingSince: card?.waitingSince ?? at(0),
                  howToResolve: card?.howToResolve ?? 'seeded',
                };
              }),
            }
          : options.feedBoards[sessionId],
    },
    fleet: {
      fleet: async () => fleet,
      ...(options.monitorStalled === undefined ? {} : { monitorStalled: options.monitorStalled }),
    },
    spawner: {
      spawn: async request => {
        spawns.push(request);
        const call = spawnCall;
        spawnCall += 1;
        return await (options.spawn?.(request, call) ??
          Promise.resolve({
            sessionId: `w${call}`,
            createdAt: at(0),
            agent: request.agent,
            harness: 'claude' as const,
            model: request.model ?? 'glm-5.2',
            modelSource: 'configured' as const,
          }));
      },
    },
    artifacts: {
      writeProvenance: async (path, value) => {
        if (options.writeProvenance !== undefined) return await options.writeProvenance();
        provenance.set(path, value);
      },
      readReport: async path => (options.reports ?? {})[path],
      latest: async () => await (options.latest?.() ?? Promise.resolve(undefined)),
      reportPath: (instant, targetId) =>
        `/state/warden/reports/${instant.replaceAll(/[:.]/gu, '-')}${targetId === undefined ? '' : `-${targetId}`}.md`,
    },
    state: {
      read: async () => stateDocument,
      write: async value => {
        stateDocument = JSON.parse(JSON.stringify(value));
      },
    },
    config: {
      read: async () => configDocument,
      write: async value => {
        configDocument = JSON.parse(JSON.stringify(value));
      },
    },
    agents: {
      installed: async () => await (options.installed?.() ?? Promise.resolve(['claude-default'])),
      currentName: async reference => await (options.currentName?.(reference) ?? Promise.resolve(undefined)),
      defaultRuntime: async () => await (options.defaultRuntime ?? (async () => 'claude-default'))(),
    },
    usage: { accounts: async () => await (options.usage?.() ?? Promise.resolve([])) },
    verdicts: { recent: async () => await (options.verdicts?.() ?? Promise.resolve([])) },
    attention: {
      board: async sessionId => {
        if (options.unreadableBoards?.includes(sessionId) === true) return undefined;
        return { sessionId, items: boards.get(sessionId) ?? [] };
      },
      raise: async (sessionId, request) => {
        raises.push({ sessionId, request });
        if (options.raiseWrite !== undefined) return options.raiseWrite;
        cards.set(JSON.stringify([sessionId, request.sourceRef]), request);
        const existing = boards.get(sessionId) ?? [];
        if (existing.some(item => item.sourceRef === request.sourceRef)) return 'unchanged';
        boards.set(sessionId, [
          ...existing,
          { source: request.source, sourceRef: request.sourceRef, raisedBy: 'daemon' as const },
        ]);
        return 'created';
      },
      resolveSource: async (sessionId, _source, sourceRef, note) => {
        resolved.push({ sessionId, sourceRef, note });
        const existing = boards.get(sessionId) ?? [];
        const remaining = existing.filter(item => item.sourceRef !== sourceRef);
        boards.set(sessionId, remaining);
        return remaining.length !== existing.length;
      },
    },
    journal: { record: (type, data) => void journal.push({ type, data: { ...data } }) },
    jevChecks: {
      append: async check => {
        if (options.jevChecksFail === 'append') throw new Error('disk full');
        jevChecks.push(check);
      },
      recent: async limit => {
        if (options.jevChecksFail === 'recent') throw new Error('unreadable');
        return jevChecks.toReversed().slice(0, limit);
      },
    },
    nowMs: () => options.now?.() ?? NOW,
    capabilities: () => {
      capability += 1;
      return `capability-${capability}`;
    },
  };

  return {
    service: new WardenSweepService(ports, settings(options.settings)),
    journal,
    spawns,
    provenance,
    raises,
    resolved,
    guarded,
    guardSettings,
    jevChecks,
    remedies,
    board: sessionId => boards.get(sessionId) ?? [],
    seedBoard: (sessionId, items) => void boards.set(sessionId, items),
    state: () => stateDocument as WardenRuntimeState,
    setState: value => {
      stateDocument = value;
    },
    setFleet: value => {
      fleet = value;
    },
    storedConfig: () => configDocument,
  };
}

/** The Warden on with the LLM layer alone — kteam's behaviour, which is what every "escalation on" test here pins. */
export const enabled = (overrides: Partial<WardenConfig> = {}): WardenConfig => ({
  ...defaultWardenConfig,
  enabled: true,
  layers: { jev: false, llm: true },
  minSpawnGapMinutes: 0,
  ...overrides,
});

export const journalTypes = (subject: Harness): string[] => subject.journal.map(entry => entry.type);
