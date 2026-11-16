/**
 * `ferretWardenView`: what a FERRET caller reads of the Warden, built from an allowlist.
 *
 * The owner and a person read the whole fleet. A ferret reads its own lineage (itself and its helpers, Ferrets'
 * `mayTouch`) and plain states, and nothing about any other lineage: no identity, no figure, no activity. Every Warden
 * route a ferret can call (`status`, `verdicts`, `agenda`, `run`) answers through the one projection here; `report` is
 * refused at the route (a ferret is never served a report).
 *
 * NO MODEL-WRITTEN PROSE. A Warden report is an LLM's text and whose subject each sentence is cannot be proved, so a
 * ferret never receives any of it, in any form. A row a ferret reads carries only the target id (in its lineage), a
 * validated classification (an enum) and times; every free-text field a model wrote (a name, label, reason,
 * recommendation, why, context, remedy, an action's detail) is dropped and replaced by the one fixed sentence for that
 * classification (`ferret-sentences.ts`).
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
import { actionSentence, anomalySentence, escalationSentences, verdictSentence } from './ferret-sentences.ts';
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
type ActionKind = Parameters<typeof actionSentence>[0];
type ActionOutcome = Parameters<typeof actionSentence>[1];
type AnomalyKind = NonNullable<Parameters<typeof escalationSentences>[0]>;

/** Copy only the named keys of a row that are present; the allowlist IS the list below. */
const pick = <T extends object>(row: T, keys: readonly string[]): Record<string, unknown> => {
  const source = row as Record<string, unknown>;
  return Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
};

// ─── flags ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A flag's classification and identity. Not here, on purpose: `detail`. The detector writes it as a sentence about the
 * flag, and some of them name ANOTHER session and its state (`peer_wait_unanswerable`: the peer, and that it is
 * terminal; the stuck inbox/input kinds name who sent; an orphaned card names the card and its ferret). Whose facts a
 * sentence holds cannot be proved, so a ferret reads the one fixed sentence for the flag's kind instead
 * (`anomalySentence`); the owner keeps the detail.
 */
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
    return scope.mayRead(flag.ferret)
      ? WardenFlagSchema.parse({ ...pick(flag, FLAG_FIELDS), detail: anomalySentence(flag.kind) })
      : undefined;
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
  'verdict',
  'costUsd',
  'agent',
  'model',
  'wardenName',
] as const;
const ACTION_FIELDS = ['at', 'ferret', 'action', 'outcome', 'by', 'anomalyKind'] as const;
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
/**
 * A verdict row's classification and times. Not here, on purpose: `name`, `label`, `reason`, `recommendation` (all lifted
 * from a model's report) and `spawn` (the launch facts of the investigator, not the caller's).
 */
const VERDICT_FIELDS = ['at', 'target', 'anomalyKind', 'verdict', 'explicitNeedsHuman', 'reportPath'] as const;
/**
 * An agenda item's identity, classification and time. Not here: `name`, `label`, `subject`, `why`, `context`,
 * `howToResolve`, `recommendation` — each built from a report's verdict or a held action's reason, so each is replaced.
 */
const AGENDA_ITEM_FIELDS = [
  'ferret',
  'id',
  'source',
  'waitingSince',
  'raisedBy',
  'raisedByName',
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
 * `GET /v1/warden/status` for a ferret. There is no `lastReport`: a report's head is a model's text, and a ferret is
 * never shown one. `lastSweepAt` arrives already narrowed to the latest sweep that scanned the lineage (`scanned.ts`),
 * and every row is narrowed here.
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
    ...(failover === undefined ? {} : { failover }),
    ...(login === undefined ? {} : { login }),
    // Capped or paused is a STATE; the amounts behind it are the owner's.
    triage: { jev: pick(owner.triage.jev, LAYER_FIELDS), llm: pick(owner.triage.llm, LAYER_FIELDS) },
    investigations,
    actions: lineageRows(owner.actions, 'ferret', ACTION_FIELDS, scope).map(row => ({
      ...row,
      // The detail the Warden or Jev wrote is prose over a report or a model's reasoning: the fixed sentence for the act.
      detail: actionSentence(row.action as ActionKind, row.outcome as ActionOutcome),
    })),
    blessings: lineageRows(owner.blessings, 'ferret', BLESSING_FIELDS, scope),
    ...(jevChecks === undefined ? {} : { jevChecks }),
  });
}

/** `POST /v1/warden/run` for a ferret: when it looked and what it found about the lineage, no spawn and no sentence. */
export function ferretRunView(owner: Run, scope: WardenReadScope): Run {
  return WardenRunViewSchema.parse({ sweptAt: owner.sweptAt, flags: ferretFlags(owner.flags, scope) });
}

/** `GET /v1/warden/verdicts` for a ferret: the lineage's verdicts as target, classification and times, with a fixed sentence. */
export function ferretVerdictsView(owner: Verdicts, scope: WardenReadScope): Verdicts {
  return WardenVerdictsViewSchema.parse(
    owner.flatMap(verdict =>
      verdict.target !== undefined && scope.mayRead(verdict.target)
        ? [{ ...pick(verdict, VERDICT_FIELDS), reason: verdictSentence(verdict.verdict) }]
        : [],
    ),
  );
}

/**
 * `GET /v1/warden/agenda` for a ferret: the notifications about the lineage. An agenda with none reads as an all-clear
 * (or degraded), never as "items", so an empty list is not a hint that others have some.
 */
export function ferretAgendaView(owner: Agenda, scope: WardenReadScope): Agenda {
  const items = lineageRows(owner.items, 'ferret', AGENDA_ITEM_FIELDS, scope).map(row => ({
    ...row,
    // Built from a report's verdict or a held action's reason on the owner's side: the fixed sentences for the class.
    ...escalationSentences(row.anomalyKind as AnomalyKind | undefined),
  }));
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
    // The plain state and its sentence; never `since`: that is the instant of an investigation failure somewhere in the
    // fleet (the global failover's `exhaustedSince`), which is activity of whichever lineage it happened to.
    ...(owner.wardenDegraded === undefined ? {} : { wardenDegraded: pick(owner.wardenDegraded, ['reason']) }),
    items,
    verdictCoverage: pick(owner.verdictCoverage, ['limit', 'truncated']),
  });
}
