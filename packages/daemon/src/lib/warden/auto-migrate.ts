/**
 * Moving a ferret that hit a limit — the pure half: who is a candidate, which login it may go to, and the
 * per-ferret ledger that keeps the Warden from moving anyone too often.
 *
 * THE OWNER'S RULES, AND WHERE EACH ONE LIVES:
 *
 * - Off unless the owner switched it on, and only for the triggers they listed ({@link moveTriggers}).
 * - Only to a login of the SAME harness. A move is the migration `fy migrate` makes, and crossing harnesses
 *   would be a conversion nobody asked for ({@link chooseMoveTarget}).
 * - Only to a login that is ready: an agent runtime, its CLI installed, signed in, not switched off, not
 *   holding spend, not out of quota. That is `fy recommend`'s own readiness check (`runtimeRefusal`), so a
 *   login the Warden moves onto is one `fy new` would start.
 * - Only to a login with at least `minHeadroomPercent` of its tightest window left ({@link headroomRefusal}): a
 *   login 99% used is ready by `fy recommend`'s reading, and still not a place to send a ferret that just ran dry.
 * - Never onto the login that ran out — a second runtime on the same login shares its quota and its budget.
 * - Never to another provider unless the owner named that login: "any ready login" stays within the provider
 *   ({@link providerOf}).
 * - At most `maxMovesPerHour` moves of one ferret an hour ({@link movesInLastHour}).
 *
 * A verdict the LLM Warden wrote that NAMES a login is held to the same rules ({@link chooseFailoverTarget}): a named
 * login that is refused falls back to the best candidate, or is refused with the reason.
 *
 * When no login qualifies, every one that was tried is named with its reason, in one line ({@link triedLine}),
 * so the owner can see at a glance what to fix.
 *
 * Pure: no IO, no clock, no globals.
 */

import {
  type FleetRuntimeView,
  type WardenAutoMigrateTrigger,
  WardenAutoMigrateTriggerSchema,
  type WardenConfig,
} from '@ferretry/protocol';
import { z } from 'zod';
import { QUOTA_RANK, quotaOf } from '../pack/quota.ts';
import { type PackFleetFacts, runtimeRefusal } from '../pack/recommend.ts';
import { instantMs } from './time.ts';
import { WARDEN_LABEL, type WardenSessionView } from './types.ts';

type HarnessKind = FleetRuntimeView['harness'];

const HOUR_MS = 60 * 60_000;

/** The triggers in effect: none while the Warden is off or moving is. */
export function moveTriggers(config: WardenConfig): ReadonlySet<WardenAutoMigrateTrigger> {
  if (!config.enabled || !config.autoMigrate.enabled) return new Set();
  return new Set(config.autoMigrate.when);
}

/** One ferret the Warden may move, and why. */
export interface AutoMigrateSubject {
  readonly id: string;
  /** The login it is on: the runtime's wrapper, as the session records it. */
  readonly agent: string;
  readonly harness: HarnessKind;
  readonly mode: 'auto' | 'interactive';
  readonly trigger: WardenAutoMigrateTrigger;
}

/** A Warden, or anything a Warden started, is never moved: it is supervision, not work. */
function isWardenWork(view: WardenSessionView): boolean {
  return view.config.label?.trim() === WARDEN_LABEL || view.config.wardenLineage === true;
}

/** The ferrets sitting on a usage limit right now, when rate limits are a trigger. */
export function rateLimitedSubjects(
  fleet: readonly WardenSessionView[],
  config: WardenConfig,
): readonly AutoMigrateSubject[] {
  if (!moveTriggers(config).has('rate_limited')) return [];
  return fleet.flatMap(view => {
    if (view.state.status !== 'rate_limited' || isWardenWork(view)) return [];
    const subject = subjectOf(view, 'rate_limited');
    return subject === undefined ? [] : [subject];
  });
}

/** A session as a subject, or `undefined` when it records no login or harness to move from. */
export function subjectOf(view: WardenSessionView, trigger: WardenAutoMigrateTrigger): AutoMigrateSubject | undefined {
  const { agent, harness } = view.config;
  if (agent === undefined || harness === undefined) return undefined;
  return { id: view.config.id, agent, harness, mode: view.config.mode, trigger };
}

// ── Where to ─────────────────────────────────────────────────────────────────────────────────────

/** The provider a harness's own login talks to: the catalog id the same provider reads as when catalogued. */
const NATIVE_PROVIDER: Readonly<Record<HarnessKind, string>> = { claude: 'anthropic', codex: 'openai' };

/**
 * Who serves a runtime's models. A login that reads a model catalog is that catalog's provider; a login of the
 * harness's own (signed in on the machine or in Ferretry) is the harness's provider; an environment login made
 * by hand is a provider of its own, which no other login shares — the safe reading of "we cannot tell".
 */
export function providerOf(runtime: FleetRuntimeView): string {
  if (runtime.models !== undefined) return runtime.models.catalog.id;
  if (runtime.credential.store !== 'environment') return NATIVE_PROVIDER[runtime.harness];
  return `login:${runtime.credential.id}`;
}

/** A login that was considered and turned down, and why, in words the owner reads. */
export interface MoveTargetTried {
  readonly runtime: string;
  readonly why: string;
}

export type MoveTargetChoice =
  | { readonly kind: 'chosen'; readonly runtime: FleetRuntimeView; readonly tried: readonly MoveTargetTried[] }
  | { readonly kind: 'none'; readonly tried: readonly MoveTargetTried[] };

export interface MoveTargetInput {
  readonly source: { readonly agent: string; readonly harness: HarnessKind };
  readonly facts: PackFleetFacts;
  /** The owner's list, in order. Empty: any ready login of the same harness and provider. */
  readonly targets: readonly string[];
  /** The least share of its tightest window a target must have left, in percent. 0: no floor. */
  readonly minHeadroomPercent: number;
}

/** The logins a ferret may move to, most headroom first, and every one turned down with its reason. */
export interface MoveTargets {
  readonly ready: readonly FleetRuntimeView[];
  readonly tried: readonly MoveTargetTried[];
}

const named = (runtime: FleetRuntimeView, name: string): boolean => runtime.name === name || runtime.wrapper === name;

/**
 * The login a ferret moves to, or none and why. An owner's list is tried in its order; "any login" takes the
 * ready ones with the most headroom first — the order `fy recommend` ranks them in.
 *
 * "Any login" stays quiet about runtimes nobody would expect it to try — the ferret's own, other harnesses,
 * terminal-only runtimes — and names every other one it turned down. A named login is always accounted for.
 */
export function chooseMoveTarget(input: MoveTargetInput): MoveTargetChoice {
  const { ready, tried } = rankMoveTargets(input);
  const chosen = ready[0];
  return chosen === undefined ? { kind: 'none', tried } : { kind: 'chosen', runtime: chosen, tried };
}

/** Every login the ferret may move to, in the order {@link chooseMoveTarget} takes them. */
export function rankMoveTargets(input: MoveTargetInput): MoveTargets {
  const { source, facts, targets, minHeadroomPercent } = input;
  const own = facts.runtimes.find(runtime => named(runtime, source.agent));
  const explicit = targets.length > 0;
  // Not a runtime here: neither its provider nor its login can be told, so not even a named target is safe — it
  // might share the very login that ran out.
  if (own === undefined)
    return {
      ready: [],
      tried: [
        { runtime: source.agent, why: 'it is not a runtime on this machine, so its login and provider are unknown' },
      ],
    };
  const tried: MoveTargetTried[] = [];
  const ready: FleetRuntimeView[] = [];
  const candidates: readonly (FleetRuntimeView | string)[] = explicit
    ? targets.map(name => facts.runtimes.find(runtime => named(runtime, name)) ?? name)
    : facts.runtimes.filter(runtime => runtime !== own && runtime.agent && runtime.harness === source.harness);
  for (const candidate of candidates) {
    if (typeof candidate === 'string') {
      tried.push({ runtime: candidate, why: 'there is no runtime by that name on this machine' });
      continue;
    }
    const why = moveRefusal(candidate, { own, harness: source.harness, explicit, facts, minHeadroomPercent });
    if (why === undefined) ready.push(candidate);
    else tried.push({ runtime: candidate.name, why });
  }
  return { ready: explicit ? ready : ready.toSorted((left, right) => headroomOrder(left, right, facts)), tried };
}

/** A failover's choice: what {@link chooseMoveTarget} gives, and the login the verdict named when it was turned down. */
export type FailoverChoice =
  | (Extract<MoveTargetChoice, { kind: 'chosen' }> & { readonly refusedNamed?: MoveTargetTried })
  | Extract<MoveTargetChoice, { kind: 'none' }>;

/**
 * The login an LLM verdict's `MIGRATE (agent)` moves a ferret to. The named login goes through the rules every
 * automatic move goes through; if it is refused, the best login those rules allow takes its place, and if there is
 * none the move is refused with every reason. A verdict names a login on a belief about its quota; only the machine's
 * own facts say it is true.
 */
export function chooseFailoverTarget(input: MoveTargetInput & { readonly named: string }): FailoverChoice {
  const { named: name, ...rest } = input;
  const fallback = chooseMoveTarget(rest);
  const own = rest.facts.runtimes.find(runtime => named(runtime, rest.source.agent));
  if (own === undefined) return fallback;
  const runtime = rest.facts.runtimes.find(candidate => named(candidate, name));
  const why =
    runtime === undefined
      ? 'there is no runtime by that name on this machine'
      : moveRefusal(runtime, {
          own,
          harness: rest.source.harness,
          explicit: rest.targets.some(target => named(runtime, target)),
          facts: rest.facts,
          minHeadroomPercent: rest.minHeadroomPercent,
        });
  if (why === undefined) return { kind: 'chosen', runtime: runtime as FleetRuntimeView, tried: fallback.tried };
  const refused = { runtime: runtime?.name ?? name, why };
  const tried = [refused, ...fallback.tried.filter(entry => entry.runtime !== refused.runtime)];
  return fallback.kind === 'chosen'
    ? { kind: 'chosen', runtime: fallback.runtime, tried, refusedNamed: refused }
    : { kind: 'none', tried };
}

function moveRefusal(
  runtime: FleetRuntimeView,
  context: {
    readonly own: FleetRuntimeView;
    readonly harness: HarnessKind;
    readonly explicit: boolean;
    readonly facts: PackFleetFacts;
    readonly minHeadroomPercent: number;
  },
): string | undefined {
  const { own, harness, explicit, facts, minHeadroomPercent } = context;
  if (runtime === own) return 'it is the login the ferret is on';
  if (runtime.harness !== harness) return `it runs ${runtime.harness}, not ${harness}`;
  if (runtime.credential.id === own.credential.id)
    return `it shares the login ${own.credential.id}, the one that ran out`;
  if (!explicit && providerOf(runtime) !== providerOf(own))
    return `another provider (${providerOf(runtime)}), which only a named target may reach`;
  return runtimeRefusal(runtime, undefined, facts)?.message ?? headroomRefusal(runtime, facts, minHeadroomPercent);
}

/**
 * Why a ready login is still not a place to move to: less than `minHeadroomPercent` of its tightest window left.
 * A login whose usage was never measured has no share to be short of, as `fy recommend` reads it.
 */
export function headroomRefusal(
  runtime: FleetRuntimeView,
  facts: PackFleetFacts,
  minPercent: number,
): string | undefined {
  const { leftPercent, summary } = quotaOfRuntime(runtime, facts);
  if (minPercent <= 0 || leftPercent === undefined || leftPercent >= minPercent) return undefined;
  return `only ${leftPercent}% is left (${summary}), under the ${minPercent}% the Warden settings require (autoMigrate.minHeadroomPercent)`;
}

const quotaOfRuntime = (runtime: FleetRuntimeView, facts: PackFleetFacts) =>
  quotaOf(
    facts.credentials.find(credential => credential.id === runtime.credential.id),
    facts.now,
    facts.paneLimits?.get(runtime.credential.id),
  );

/** Most headroom first: the band, then the share left; unmeasured counts as all of it, as `fy recommend` reads it. */
function headroomOrder(left: FleetRuntimeView, right: FleetRuntimeView, facts: PackFleetFacts): number {
  const a = quotaOfRuntime(left, facts);
  const b = quotaOfRuntime(right, facts);
  return QUOTA_RANK[a.state] - QUOTA_RANK[b.state] || (b.leftPercent ?? 100) - (a.leftPercent ?? 100);
}

/** Every login tried and why, in one line: what the owner is told when there was nowhere to go. */
export function triedLine(tried: readonly MoveTargetTried[]): string {
  if (tried.length === 0) return 'No other login of the same harness is set up on this machine.';
  return `Tried ${tried.map(entry => `${entry.runtime} (${entry.why})`).join('; ')}.`;
}

// ── The ledger ───────────────────────────────────────────────────────────────────────────────────

/** What the Warden remembers about one ferret it moved, asked or held. */
export interface AutoMigrateSessionMemory {
  /** When it was moved, within the last hour. */
  readonly moves: readonly string[];
  /** It was asked to stop its background jobs, and is being given time to. */
  readonly asked?: {
    readonly at: string;
    readonly trigger: WardenAutoMigrateTrigger;
    readonly from: string;
  };
  /** The last reason it was held for the owner ({@link autoMigrateHoldKey}): a standing reason is told once. */
  readonly held?: string;
}

export interface AutoMigrateMemory {
  readonly sessions: Readonly<Record<string, AutoMigrateSessionMemory>>;
}

export const EMPTY_AUTO_MIGRATE_MEMORY: AutoMigrateMemory = { sessions: {} };

const memoryOf = (memory: AutoMigrateMemory, sessionId: string): AutoMigrateSessionMemory =>
  memory.sessions[sessionId] ?? { moves: [] };

export function withSession(
  memory: AutoMigrateMemory,
  sessionId: string,
  change: (session: AutoMigrateSessionMemory) => AutoMigrateSessionMemory,
): AutoMigrateMemory {
  return { sessions: { ...memory.sessions, [sessionId]: change(memoryOf(memory, sessionId)) } };
}

export function sessionMemory(memory: AutoMigrateMemory, sessionId: string): AutoMigrateSessionMemory {
  return memoryOf(memory, sessionId);
}

const recent = (moves: readonly string[], nowMs: number): readonly string[] =>
  moves.filter(at => nowMs - (instantMs(at) ?? 0) < HOUR_MS);

export function movesInLastHour(memory: AutoMigrateMemory, sessionId: string, nowMs: number): number {
  return recent(memoryOf(memory, sessionId).moves, nowMs).length;
}

/** A move made now: counted, and whatever it was waiting on or held for is over. */
export function recordMove(memory: AutoMigrateMemory, sessionId: string, nowMs: number): AutoMigrateMemory {
  return withSession(memory, sessionId, session => ({
    moves: [...recent(session.moves, nowMs), new Date(nowMs).toISOString()],
  }));
}

/** Forget ferrets that are gone and moves past the hour; an entry with nothing left in it goes too. */
export function pruneAutoMigrateMemory(
  memory: AutoMigrateMemory,
  live: ReadonlySet<string>,
  nowMs: number,
): AutoMigrateMemory {
  const sessions: Record<string, AutoMigrateSessionMemory> = {};
  for (const [id, session] of Object.entries(memory.sessions)) {
    if (!live.has(id)) continue;
    const moves = recent(session.moves, nowMs);
    if (moves.length === 0 && session.asked === undefined && session.held === undefined) continue;
    sessions[id] = { ...session, moves };
  }
  return { sessions };
}

/** Why a ferret was held, as a key: the same trigger, login and reason is one episode, told once. */
export function autoMigrateHoldKey(subject: Pick<AutoMigrateSubject, 'trigger' | 'agent'>, reason: string): string {
  return `${subject.trigger}|${subject.agent}|${reason}`;
}

/** Whether the ferret's ask to stop its jobs has had its time. */
export function askExpired(
  asked: NonNullable<AutoMigrateSessionMemory['asked']>,
  waitMinutes: number,
  nowMs: number,
): boolean {
  return nowMs - (instantMs(asked.at) ?? 0) >= waitMinutes * 60_000;
}

const Instant = z.string().min(1);

const AutoMigrateMemorySchema = z.object({
  sessions: z.record(
    z.string(),
    z.object({
      moves: z.array(Instant).default([]),
      asked: z.object({ at: Instant, trigger: WardenAutoMigrateTriggerSchema, from: z.string().min(1) }).optional(),
      held: z.string().min(1).optional(),
    }),
  ),
});

/**
 * The ledger a stored document means: absent is a fresh ledger, and anything that is not a ledger is `undefined`
 * — the caller says so out loud rather than silently forgetting who was moved.
 */
export function parseAutoMigrateMemory(value: unknown): AutoMigrateMemory | undefined {
  if (value === undefined || value === null) return EMPTY_AUTO_MIGRATE_MEMORY;
  const parsed = AutoMigrateMemorySchema.safeParse(value);
  return parsed.success ? (parsed.data as AutoMigrateMemory) : undefined;
}
