/**
 * `ferretWardenView`: what a FERRET caller reads of the Warden, built from an allowlist.
 *
 * The owner and a person read the whole fleet. A ferret reads its own lineage (itself and its helpers, Ferrets'
 * `mayTouch`) and plain states, and nothing about any other lineage: no identity, no figure, no activity. Every Warden
 * route a ferret can call (`status`, `verdicts`, `report`, `agenda`, `run`) answers through the one projection here.
 *
 * DENY BY DEFAULT. Each projection BUILDS the ferret's answer from named fields, each one either a lineage-filtered
 * row (kept only when its target is in the lineage) or a plain state. It never starts from the owner's view and takes
 * leaky fields away, so a field added to the owner's view later is absent for a ferret until someone adds it below.
 * (`tests/unit/ferret-view.test.ts` plants an unknown field at every level and proves it.)
 *
 * What the data layer filters BEFORE a cut (newest-N investigations, actions, verdicts, reports) it does with the same
 * scope, so an unrelated record can never evict the caller's own; the projection filters again, so a row the source
 * forgot to narrow still cannot leave. Pure: every input is a value.
 */
import {
  type WardenFlag,
  WardenFlagSchema,
  WardenRunViewSchema,
  WardenStatusViewSchema,
  WardenVerdictsViewSchema,
  WardenAgendaViewSchema,
} from '../../contract/index.ts';
import type { z } from 'zod';

/** Whose records a ferret may read: Ferrets' `mayTouch` for the caller. Absent means the owner or a person. */
export interface WardenReadScope {
  mayRead(session: string): boolean;
}

type Status = z.infer<typeof WardenStatusViewSchema>;
type Run = z.infer<typeof WardenRunViewSchema>;
type Verdicts = z.infer<typeof WardenVerdictsViewSchema>;
type Agenda = z.infer<typeof WardenAgendaViewSchema>;
type Row = Record<string, unknown>;

/** Copy only the named keys of a row that are present; the allowlist IS the list below. */
const pick = <T extends object>(row: T, keys: readonly string[]): Record<string, unknown> => {
  const source = row as Record<string, unknown>;
  return Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
};

// ─── flags ────────────────────────────────────────────────────────────────────────────────────────────────────────

const FLAG_FIELDS = [
  'kind',
  'ferret',
  'generation',
  'provider',
  'failureClasses',
  'models',
  'name',
  'label',
  'state',
  'detail',
  'since',
  'idleMinutes',
  'assignedWarden',
  'ledger',
  'subject',
  'card',
] as const;

/**
 * One flag for a ferret, or none. A flag about ONE ferret is kept when that ferret is in the lineage. A fleet-wide
 * flag (it names `affectedFerrets`) is kept only when it touches the lineage, and then says no more than that: its
 * own sentence counts and names every ferret it affects, so it is replaced by a generic one over the lineage's share.
 */
function ferretFlag(flag: WardenFlag, scope: WardenReadScope): WardenFlag | undefined {
  if (flag.affectedFerrets === undefined)
    return scope.mayRead(flag.ferret) ? WardenFlagSchema.parse(pick(flag, FLAG_FIELDS)) : undefined;
  const mine = flag.affectedFerrets.filter(id => scope.mayRead(id));
  const anchor = mine[0];
  if (anchor === undefined) return undefined;
  return WardenFlagSchema.parse({
    ...pick(flag, ['kind', 'provider', 'since']),
    ferret: anchor,
    affectedFerrets: mine,
    // The anchor's own state is only known when it is in the lineage; a fleet flag is about ferrets that are running.
    state: flag.ferret === anchor ? flag.state : 'working',
    detail: `A fleet-wide problem (${flag.kind.replaceAll('_', ' ')}) affects ${mine.length} of your ferrets.`,
  });
}

const ferretFlags = (flags: readonly WardenFlag[], scope: WardenReadScope): WardenFlag[] =>
  flags.flatMap(flag => {
    const kept = ferretFlag(flag, scope);
    return kept === undefined ? [] : [kept];
  });

// ─── rows ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const INVESTIGATION_FIELDS = [
  'id',
  'state',
  'scope',
  'origin',
  'target',
  'anomalyKind',
  'warden',
  'queuedAt',
  'startedAt',
  'finishedAt',
  'reportPath',
  'verdict',
  'costUsd',
  'agent',
  'model',
  'wardenName',
] as const;
const ACTION_FIELDS = ['at', 'ferret', 'action', 'outcome', 'by', 'anomalyKind', 'detail'] as const;
const BLESSING_FIELDS = ['ferret', 'kinds', 'expiresAt', 'by', 'streak', 'untilChange'] as const;
const JEV_CHECK_FIELDS = [
  'at',
  'ferret',
  'anomalyKind',
  'verdict',
  'act',
  'why',
  'route',
  'confidence',
  'costUsd',
  'path',
  'node',
] as const;
const LAYER_FIELDS = ['configured', 'active', 'reason'] as const;
const VERDICT_FIELDS = [
  'at',
  'target',
  'name',
  'label',
  'anomalyKind',
  'verdict',
  'explicitNeedsHuman',
  'recommendation',
  'reason',
  'reportPath',
] as const;
/** The launch facts of a report the caller may read. The accounts the daemon passed over are the owner's. */
const SPAWN_FIELDS = [
  'agent',
  'model',
  'modelSource',
  'harness',
  'failedOver',
  'configuredFirst',
  'failoverReason',
  'policy',
  'selection',
] as const;
const AGENDA_ITEM_FIELDS = [
  'ferret',
  'name',
  'label',
  'ferretState',
  'id',
  'source',
  'subject',
  'why',
  'context',
  'waitingSince',
  'howToResolve',
  'recommendation',
  'raisedBy',
  'raisedByName',
  'fromFlag',
  'provider',
  'anomalyKind',
] as const;

/** The rows whose `key` ferret is in the lineage, each rebuilt from its allowlist. */
const lineageRows = (
  rows: readonly Row[] | undefined,
  key: string,
  fields: readonly string[],
  scope: WardenReadScope,
): Row[] =>
  (rows ?? []).flatMap(row => {
    const ferret = row[key];
    return typeof ferret === 'string' && scope.mayRead(ferret) ? [pick(row, fields)] : [];
  });

// ─── the routes ───────────────────────────────────────────────────────────────────────────────────────────────────

/** The failover block a ferret reads: the owner's static settings and whether each login is usable, no activity. */
function ferretFailover(failover: unknown): unknown {
  if (typeof failover !== 'object' || failover === null) return undefined;
  const source = failover as Row;
  const accounts = Array.isArray(source.accounts) ? (source.accounts as Row[]) : [];
  return {
    ...pick(source, ['policy', 'failureThreshold', 'cooldownMinutes']),
    accounts: accounts.map(account => pick(account, ['agent', 'model', 'eligible'])),
  };
}

/** The investigation login in effect: a name and where it came from, as the owner set it. */
const ferretLogin = (login: unknown): unknown =>
  typeof login === 'object' && login !== null ? pick(login, ['source', 'unknown', 'available']) : undefined;

/**
 * `GET /v1/warden/status` for a ferret. `lastReport` arrives already narrowed to a report about the lineage (a
 * report's targets live in its text, which only the reader can parse); every other row is narrowed here.
 */
export function ferretStatusView(owner: Status, scope: WardenReadScope): Status {
  const investigations = lineageRows(owner.investigations, 'target', INVESTIGATION_FIELDS, scope);
  // A live Warden's id is the lineage's only when it is investigating one of the lineage's own; otherwise it is
  // fleet activity and the ferret learns no more than that one is running.
  const liveWarden =
    owner.liveWarden !== undefined && investigations.some(entry => entry.warden === owner.liveWarden)
      ? owner.liveWarden
      : undefined;
  const failover = ferretFailover((owner as Row).failover);
  const login = ferretLogin((owner as Row).login);
  const jevChecks =
    owner.jevChecks === undefined ? undefined : lineageRows(owner.jevChecks, 'ferret', JEV_CHECK_FIELDS, scope);
  return WardenStatusViewSchema.parse({
    config: owner.config,
    ...pick(owner, ['lastSweepAt', 'nextSweepAt']),
    flags: ferretFlags(owner.flags, scope),
    // A fingerprint can carry target identities and any change in it is fleet activity: a ferret reads none.
    fingerprint: '',
    ...(liveWarden === undefined ? {} : { liveWarden }),
    wardenRunning: owner.liveWarden !== undefined,
    ...(owner.lastReport === undefined ? {} : { lastReport: pick(owner.lastReport, ['reportId', 'head']) }),
    ...(failover === undefined ? {} : { failover }),
    ...(login === undefined ? {} : { login }),
    // Capped or paused is a STATE; the amounts behind it are the owner's.
    triage: { jev: pick(owner.triage.jev, LAYER_FIELDS), llm: pick(owner.triage.llm, LAYER_FIELDS) },
    investigations,
    actions: lineageRows(owner.actions, 'ferret', ACTION_FIELDS, scope),
    blessings: lineageRows(owner.blessings, 'ferret', BLESSING_FIELDS, scope),
    ...(jevChecks === undefined ? {} : { jevChecks }),
  });
}

/** `POST /v1/warden/run` for a ferret: when it looked and what it found about the lineage, no spawn and no sentence. */
export function ferretRunView(owner: Run, scope: WardenReadScope): Run {
  return WardenRunViewSchema.parse({ sweptAt: owner.sweptAt, flags: ferretFlags(owner.flags, scope) });
}

/** `GET /v1/warden/verdicts` for a ferret: the verdicts about the lineage only. */
export function ferretVerdictsView(owner: Verdicts, scope: WardenReadScope): Verdicts {
  return WardenVerdictsViewSchema.parse(
    owner.flatMap(verdict =>
      verdict.target !== undefined && scope.mayRead(verdict.target)
        ? [
            {
              ...pick(verdict, VERDICT_FIELDS),
              ...(verdict.spawn === undefined ? {} : { spawn: pick(verdict.spawn, SPAWN_FIELDS) }),
            },
          ]
        : [],
    ),
  );
}

/**
 * `GET /v1/warden/agenda` for a ferret: the notifications about the lineage. An agenda with none reads as an all-clear
 * (or degraded), never as "items", so an empty list is not a hint that others have some.
 */
export function ferretAgendaView(owner: Agenda, scope: WardenReadScope): Agenda {
  const items = lineageRows(owner.items, 'ferret', AGENDA_ITEM_FIELDS, scope);
  const outcome =
    items.length > 0
      ? 'items'
      : owner.wardenDegraded !== undefined
        ? 'degraded'
        : owner.lastSweepAt === undefined
          ? 'no-sweep'
          : 'clean-sweep';
  return WardenAgendaViewSchema.parse({
    generatedAt: owner.generatedAt,
    ...pick(owner, ['lastSweepAt']),
    outcome,
    ...(owner.wardenDegraded === undefined ? {} : { wardenDegraded: pick(owner.wardenDegraded, ['since', 'reason']) }),
    items,
    verdictCoverage: pick(owner.verdictCoverage, ['limit', 'truncated']),
  });
}

/**
 * Whether a report may be read by the scope: it has at least one entry, and EVERY entry names a target in the lineage.
 * A pack report (no target) and a sweep report that also covers a stranger belong to no one caller, so they are not
 * found. `targets` are the sessions its verdict entries are about, `undefined` for an entry that names none.
 */
export function reportReadableBy(targets: readonly (string | undefined)[], scope: WardenReadScope): boolean {
  return targets.length > 0 && targets.every(target => target !== undefined && scope.mayRead(target));
}
