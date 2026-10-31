/**
 * Every time the Warden needs the owner, as exactly one plain NOTIFICATION per subject, from "Warden" —
 * sent once, kept quiet while the subject stands, and cleared the moment it no longer does.
 *
 * ═══ ONE PLACE TO LOOK ═══
 *
 * A Warden notification is an Agenda item marked `notice` (and `ping`, so the phone buzzes): it lands
 * in the owner's Inbox with every machine's, opens the flagged ferret's chat when tapped, and has no
 * answers — reading it is acting on it. It is written through the one Agenda service every other
 * caller uses, and nothing else lists the Warden's asks: the Warden page links to the Inbox.
 *
 * ═══ WHAT MAY INTERRUPT A PERSON ═══
 *
 * The subject must be anomalous RIGHT NOW, in this sweep's detector output. A status transition is not
 * evidence; an Agenda row the session already has is not evidence either. Then ONE of two reasons
 * must hold for it:
 *
 * 1. A warden wrote an EXPLICIT `Verdict: NEEDS_HUMAN` marker for that exact node and anomaly class,
 *    ABOUT THE EPISODE HAPPENING NOW (`verdictCoversEpisode`). Prose that merely sounds worried never
 *    interrupts anyone.
 * 2. The Warden's own state says the flag is the owner's to decide (`owner-routes.ts`): a confident act
 *    held for the owner's yes, an investigation that failed, or a flag Jev handed on with no
 *    investigation able to follow.
 *
 * A third gate stands in front of both: a safe remedy must be unavailable or have failed. This daemon
 * holds no automatic repair policy that would settle a subject before a person is asked — see
 * `planWardenRemedy`, which states that rather than pretending a repair ran.
 *
 * ═══ ONE NOTIFICATION PER SUBJECT, ONCE PER EPISODE ═══
 *
 * A subject is one ferret and one anomaly class — `warden:ask:<kind>` on that ferret's own board — or,
 * for a fault that names several ferrets (a provider outage, a daemon or liveness monitor that watches
 * none), ONE machine subject, `warden:ask:fleet:<kind>:<key>`, on one of their boards. Keying on the
 * subject alone, never on the reason or the report, is what makes a standing situation REFRESH one item
 * rather than add one each sweep, and keeps fifteen ferrets that lost their monitor at fifteen items — or
 * one, when the fault is the machine's.
 *
 * Reading a notification resolves it, so the board cannot say whether a subject was already told: the
 * sweep keeps that itself (`WardenRuntimeState.notified`). A subject is notified once; while it keeps a
 * reason it is not notified again, however often the owner clears the item; once it has no reason it is
 * forgotten, so when it recurs it notifies again.
 *
 * ═══ THE OLD ITEMS ═══
 *
 * Before notifications, an explicit NEEDS_HUMAN verdict wrote a durable item under `warden:<kind>`. Any
 * such item still open is resolved with a note on the next sweep: the Warden has one channel now.
 *
 * ═══ THIS MODULE NEVER FEEDS DETECTION ═══
 *
 * Attention is read here after the detector has already run, and the only output is a plan of raises and
 * resolutions. Nothing read here reaches the detector, the anomaly set, or a warden prompt.
 *
 * Pure: every input arrives through the arguments, including the clock's work already done for it.
 */

import {
  AGENDA_PUSH_BODY_LENGTH,
  AGENDA_PUSH_TITLE_LENGTH,
  type AgendaBy,
  type AgendaSource,
  type AgendaTerm,
  MAX_AGENDA_DETAIL_LENGTH,
  MAX_AGENDA_REASON_LENGTH,
  type WardenJevPathStep,
  type WardenLayerStatus,
} from '@ferretry/protocol';
import { type WardenAnomaly, type WardenAnomalyKind, wardenAnomalySubject } from './detect.ts';
import { jevNodeQuestion, jevPathFacts, jevPathLine } from './jev-tree.ts';
import type { WardenOwnerRoute } from './owner-routes.ts';
import { wardenTeammateToken } from './prompt.ts';
import type { WardenVerdictSpawn } from './reports.ts';
import { instantMs } from './time.ts';
import { isTerminalStatus, type WardenSessionConfig, type WardenSessionStatus } from './types.ts';
import {
  parseWardenAnomalyKind,
  parseWardenVerdictSourceRef,
  type WardenRecommendation,
  type WardenVerdict,
} from './verdicts.ts';

/**
 * The board source a Warden notification is written to.
 *
 * `agent-raised` is the only source the state machine lets a stable `sourceRef` ride on, and a non-null
 * `sourceRef` is reserved for a daemon actor — which is precisely the dedupe key this module turns on.
 */
export const WARDEN_ESCALATION_SOURCE: AgendaSource = 'agent-raised';

/** A parsed report row as the escalation reads it: the verdict, plus the daemon-owned sidecar naming
 *  which account and model actually judged it. */
export type WardenEscalationVerdict = WardenVerdict & { readonly spawn?: WardenVerdictSpawn };

/** The node an escalation is about, as the escalation reads it. */
export interface WardenEscalationNode {
  readonly config: Pick<WardenSessionConfig, 'id' | 'teammate' | 'label' | 'agent' | 'model' | 'modelHint'>;
  readonly state: { readonly status: WardenSessionStatus };
}

/** One active board row, as the escalation reads it. */
export interface WardenEscalationBoardItem {
  readonly source: AgendaSource;
  readonly sourceRef: string | null;
  readonly raisedBy: AgendaBy;
}

/** One session's board. An `AgendaSnapshot` satisfies it as read. */
export interface WardenEscalationBoard {
  readonly sessionId: string;
  readonly items: readonly WardenEscalationBoardItem[];
}

/** What the daemon was allowed to do about a suspicious node, and what came of it. `applied` is the
 *  only disposition that withholds an escalation. */
export type WardenRemedyDisposition = 'forbidden' | 'failed' | 'applied';

export interface WardenRemedyOutcome {
  readonly disposition: WardenRemedyDisposition;
  /** Written for the person who will read it, not for a log. */
  readonly why: string;
}

/** The authority facts this daemon actually holds over a session today. */
export interface WardenRemedyAuthority {
  /** Whether a warden's own credential lets it act on the fleet at all. */
  readonly mayAct: boolean;
}

/**
 * What may be done about a suspicious node before a person is interrupted.
 *
 * BOTH ANSWERS ARE `forbidden`, and that is the honest state of this daemon rather than a stub. A warden
 * here holds no credential over any session; and the daemon has no recovery policy naming a remedy that
 * would settle a node before a person is asked. Reporting an attempt that never happened would be the one
 * failure worse than escalating.
 */
export function planWardenRemedy(authority: WardenRemedyAuthority): WardenRemedyOutcome {
  if (!authority.mayAct) {
    return {
      disposition: 'forbidden',
      why: 'No automatic repair was attempted, and none was possible: a warden on this daemon holds no credential over any session, so nudging, resuming, migrating and stopping are all forbidden to it.',
    };
  }
  return {
    disposition: 'forbidden',
    why: 'No automatic repair was attempted: this daemon has no configured warden recovery policy, so no remedy is allowed against this node.',
  };
}

/** Whether the remedy record leaves an escalation open: a repair that was applied and held fixed it. */
export function remedyPermitsEscalation(outcome: WardenRemedyOutcome): boolean {
  return outcome.disposition !== 'applied';
}

// ── Identity ─────────────────────────────────────────────────────────────────────────────────────────

/** The two identities a Warden notification can have, parsed back from its source reference. */
export type WardenEscalationIdentity =
  | { readonly scope: 'session'; readonly kind: WardenAnomalyKind }
  | { readonly scope: 'fleet'; readonly kind: WardenAnomalyKind; readonly key: string };

const ASK_PREFIX = 'warden:ask:';
const FLEET_PREFIX = `${ASK_PREFIX}fleet:`;

/** The stable identity of a ferret's notification for one class. */
export function wardenEscalationSourceRef(kind: WardenAnomalyKind): string {
  return `${ASK_PREFIX}${kind}`;
}

/** The identity of a machine-wide subject: one notification for every ferret the fault names. */
export function wardenFleetEscalationSourceRef(kind: WardenAnomalyKind, key: string): string {
  return `${FLEET_PREFIX}${kind}:${key}`;
}

/** The identity a source reference carries, or nothing when it is not a Warden notification's. */
export function parseWardenEscalationSourceRef(
  sourceRef: string | null | undefined,
): WardenEscalationIdentity | undefined {
  if (sourceRef === null || sourceRef === undefined || !sourceRef.startsWith(ASK_PREFIX)) return undefined;
  if (sourceRef.startsWith(FLEET_PREFIX)) {
    const rest = sourceRef.slice(FLEET_PREFIX.length);
    const separator = rest.indexOf(':');
    const kind = parseWardenAnomalyKind(rest.slice(0, Math.max(0, separator)));
    const key = rest.slice(separator + 1);
    return separator > 0 && kind !== undefined && key !== '' ? { scope: 'fleet', kind, key } : undefined;
  }
  const kind = parseWardenAnomalyKind(sourceRef.slice(ASK_PREFIX.length));
  return kind === undefined ? undefined : { scope: 'session', kind };
}

/** Whether a row was raised by the daemon on the escalation source — the only rows this module touches.
 *  Resolving somebody else's row because its reference happened to parse would be a silent theft. */
const daemonRow = (item: WardenEscalationBoardItem): boolean =>
  item.raisedBy === 'daemon' && item.source === WARDEN_ESCALATION_SOURCE;

/** Whether a board row is a Warden notification. */
export function isWardenEscalationItem(item: WardenEscalationBoardItem): boolean {
  return daemonRow(item) && parseWardenEscalationSourceRef(item.sourceRef) !== undefined;
}

/** The class an OLD escalation item (`warden:<kind>`, before notifications) is about, if it is one. */
function legacyKindOf(item: WardenEscalationBoardItem): WardenAnomalyKind | undefined {
  if (!daemonRow(item) || item.sourceRef === null || item.sourceRef.startsWith(ASK_PREFIX)) return undefined;
  const identity = parseWardenVerdictSourceRef(item.sourceRef);
  // The bare-class form only: `warden:<report>#<kind>` named one report block and was never ours.
  return identity?.reportPath === undefined ? identity?.anomalyKind : undefined;
}

/** One thing the Warden can need the owner about this sweep. */
interface Subject {
  /** Its identity across sweeps: what `notified` remembers. */
  readonly key: string;
  readonly sourceRef: string;
  readonly anomaly: WardenAnomaly;
  /** Every ferret it is about: one for a ferret's own subject, several for a machine one. */
  readonly targets: readonly string[];
  readonly fleet: boolean;
}

/** Whether a flag is about several ferrets rather than one. */
const isFleetAnomaly = (anomaly: WardenAnomaly): boolean =>
  anomaly.fleetKey !== undefined || anomaly.affectedSessionIds !== undefined;

function subjectOf(anomaly: WardenAnomaly): Subject {
  if (!isFleetAnomaly(anomaly)) {
    const sourceRef = wardenEscalationSourceRef(anomaly.kind);
    return { key: `${anomaly.sessionId}|${sourceRef}`, sourceRef, anomaly, targets: [anomaly.sessionId], fleet: false };
  }
  const targets = [...new Set([anomaly.sessionId, ...(anomaly.affectedSessionIds ?? [])])].filter(id => id !== '');
  const sourceRef = wardenFleetEscalationSourceRef(
    anomaly.kind,
    anomaly.fleetKey ?? anomaly.provider ?? anomaly.sessionId,
  );
  return { key: sourceRef, sourceRef, anomaly, targets, fleet: true };
}

/** Composite map keys, JSON-encoded so no separator inside a part can make two keys collide. */
const anomalyKey = (sessionId: string, kind: WardenAnomalyKind): string => JSON.stringify([sessionId, kind]);
const flagKey = (anomaly: WardenAnomaly): string =>
  JSON.stringify([anomaly.kind, anomaly.fleetKey ?? anomaly.sessionId]);

// ── The plan ─────────────────────────────────────────────────────────────────────────────────────────

/** One notification to raise, or to refresh while it is still open. */
export interface WardenEscalationRaise {
  readonly sessionId: string;
  readonly anomalyKind: WardenAnomalyKind;
  /** Its subject's identity across sweeps (`WardenRuntimeState.notified`). */
  readonly subjectKey: string;
  readonly source: AgendaSource;
  readonly sourceRef: string;
  /** A few words: the notification's title. */
  readonly title: string;
  /** One line: the push body and the Inbox summary. */
  readonly subject: string;
  readonly why: string;
  readonly premise: string;
  readonly context: string;
  readonly howToResolve: string;
  readonly terms?: readonly AgendaTerm[];
  readonly waitingSince: string;
  /** A plain notification, not an agenda item, and one that buzzes the phone. */
  readonly notice: true;
  readonly ping: true;
  /** Journal evidence: the report an escalating verdict was read from, when one was. */
  readonly reportPath?: string;
  /** Journal evidence: which reason raised it. */
  readonly reason: WardenEscalationReasonKind;
}

/** Why a notification was raised: an investigation's explicit verdict, or one of `owner-routes.ts`'s. */
export type WardenEscalationReasonKind = 'needs_human' | WardenOwnerRoute['reason']['kind'];

/** One open item whose reason has gone away, or an old escalation item being retired. */
export interface WardenEscalationResolution {
  readonly sessionId: string;
  readonly anomalyKind: WardenAnomalyKind;
  readonly source: AgendaSource;
  readonly sourceRef: string;
  /** Kept as the resolution note, so the audit trail says why it cleared. */
  readonly note: string;
}

export interface WardenEscalationPlan {
  readonly raise: readonly WardenEscalationRaise[];
  readonly resolve: readonly WardenEscalationResolution[];
  /** Every subject that has a reason this sweep: what `notified` may keep remembering. */
  readonly standing: readonly string[];
}

export interface WardenEscalationInput {
  /** THIS sweep's anomaly set — the only admissible evidence of suspicion. */
  readonly anomalies: readonly WardenAnomaly[];
  readonly nodes: readonly WardenEscalationNode[];
  readonly verdicts: readonly WardenEscalationVerdict[];
  readonly boards: readonly WardenEscalationBoard[];
  readonly remedy: WardenRemedyOutcome;
  /** The CLI a human actually types, so the named action is one they can run. */
  readonly clientName: string;
  /** Why each standing flag is the owner's, from the Warden's own state (`owner-routes.ts`). */
  readonly routes?: readonly WardenOwnerRoute[];
  /** Subjects already notified that have not cleared since: not notified again. */
  readonly notified?: ReadonlySet<string>;
  /** This machine's name, so a notification read among every machine's says which one it is about. */
  readonly machine?: string;
  /** The sweep's instant: the wait of a notification nothing else dates. */
  readonly at?: string;
}

/** The note an old escalation item is resolved with. */
export const LEGACY_ESCALATION_NOTE =
  'Cleared by the Warden: it now tells you this as a notification from "Warden" instead of an item here.';

const flatten = (value: string): string => value.replaceAll(/\s+/gu, ' ').trim();

/** Fit a field to what the board accepts. A refusal at the write is a lost interruption. */
function clamp(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, Math.max(0, maximum - 1)).trimEnd()}…`;
}

const bullets = (lines: readonly (string | undefined)[], maximum: number): string =>
  clamp(
    lines
      .filter((line): line is string => line !== undefined && line.trim() !== '')
      .map(line => `- ${flatten(line)}`)
      .join('\n'),
    maximum,
  );

const pct = (confidence: number): string => `${Math.round(confidence * 100)}%`;

/** The newest EXPLICIT needs-human verdict per (node, class). Heuristic verdicts never reach here. */
function explicitNeedsHumanVerdicts(
  verdicts: readonly WardenEscalationVerdict[],
): ReadonlyMap<string, WardenEscalationVerdict> {
  const newest = new Map<string, WardenEscalationVerdict>();
  for (const verdict of verdicts) {
    if (verdict.verdict !== 'needs_human' || verdict.explicitNeedsHuman !== true) continue;
    if (verdict.targetSession === undefined || verdict.anomalyKind === undefined) continue;
    const key = anomalyKey(verdict.targetSession, verdict.anomalyKind);
    const previous = newest.get(key);
    if (previous === undefined || (instantMs(verdict.at) ?? 0) > (instantMs(previous.at) ?? 0))
      newest.set(key, verdict);
  }
  return newest;
}

/**
 * Whether this verdict judged the episode happening NOW. FAILS CLOSED on an anchor it cannot read; an
 * anomaly with no anchor at all (`dead_monitor` is a state, not an episode) is let through.
 */
function verdictCoversEpisode(verdict: WardenEscalationVerdict, anomaly: WardenAnomaly): boolean {
  if (anomaly.since === undefined) return true;
  const episodeMs = instantMs(anomaly.since);
  const verdictMs = instantMs(verdict.at);
  if (episodeMs === undefined || verdictMs === undefined) return false;
  return verdictMs >= episodeMs;
}

/** The node as a reference a reader's client can prove and link: its callsign, else its bare id. */
function nodeReference(node: WardenEscalationNode): string {
  return node.config.teammate === undefined ? node.config.id : wardenTeammateToken(node.config.teammate);
}

/** The node's name in plain words, for a title: no reference sigil. */
const nodeName = (node: WardenEscalationNode): string => node.config.teammate ?? node.config.id;

/** Who ran the check, from the daemon's own sidecar — never from the report's prose. */
function judgedByLine(spawn: WardenVerdictSpawn | undefined): string | undefined {
  if (spawn === undefined) return undefined;
  return `Judged by: ${spawn.agent} running ${spawn.model} on the ${spawn.harness} harness (warden session ${spawn.wardenSessionId}).`;
}

/** The node's CLI and model from SESSION METADATA, never from a model's guess about itself. */
function nodeFactsLine(node: WardenEscalationNode, machine: string | undefined): string {
  const cli = node.config.agent ?? 'not recorded';
  const model = node.config.model ?? node.config.modelHint ?? 'not recorded';
  const where = machine === undefined ? '' : ` on ${machine}`;
  return `Ferret: ${nodeReference(node)}${where} — session ${node.config.id}, CLI ${cli}, model ${model}, status ${node.state.status}.`;
}

function detectorLine(anomaly: WardenAnomaly): string {
  const since = anomaly.since === undefined ? '' : ` Anomalous since ${anomaly.since}.`;
  const idle = anomaly.idleMinutes === undefined ? '' : ` Idle ${anomaly.idleMinutes}m.`;
  return `Seen (${anomaly.kind}): ${flatten(anomaly.detail)}.${since}${idle}`;
}

/** The title's predicate per class: "atlas may be stuck thinking". */
const PREDICATE: Readonly<Record<WardenAnomalyKind, string>> = {
  dead_monitor: 'is not being watched',
  unattended_question: 'has a question waiting',
  abandoned_wreckage: 'left wreckage behind',
  quota_reset_passed: 'can resume now',
  declared_wait_overdue: 'is past its declared wait',
  peer_wait_unanswerable: 'waits on a peer that can’t answer',
  sus_thinking: 'may be stuck thinking',
  sus_subprocess: 'is stuck in a command',
  agent_frozen: 'is frozen',
  provider_unavailable: 'can’t reach its provider',
  owner_request: 'was not investigated',
  orphaned_card: 'left a card with nobody on it',
  report_overdue: 'has not answered its parent',
};

/** Why a layer is not running, in words. */
function layerOff(layer: WardenLayerStatus, name: 'investigations' | 'Jev'): string {
  switch (layer.reason) {
    case 'disabled':
      return 'the Warden is off';
    case 'jev_cap':
      return 'today’s Jev budget is spent (until midnight UTC)';
    case 'investigation_cap':
      return 'today’s investigation budget is spent (until midnight UTC)';
    case 'no_login':
      return 'no investigation login is set up';
    default:
      return `${name === 'Jev' ? 'Jev is' : 'investigations are'} ${layer.configured ? 'not running' : 'switched off'}`;
  }
}

/** Jev's hand-on, as the sentence the owner reads. */
function jevLine(handoff: {
  readonly why: string;
  readonly confidence: number;
  readonly recommends?: string;
  readonly failure?: string;
  readonly node?: string;
}): string {
  const sure = pct(handoff.confidence);
  const question = handoff.node === undefined ? undefined : jevNodeQuestion(handoff.node);
  switch (handoff.why) {
    case 'unsure':
      return `Jev looked and was not sure what to do (${sure} sure).`;
    case 'not_sure_enough':
      // The decision tree names the ONE question Jev could not answer surely: that is the owner's to answer.
      return question === undefined
        ? `Jev leaned one way but was only ${sure} sure, below your bar.`
        : `Jev could not answer “${question}” surely enough (${sure} sure, below your bar).`;
    case 'never_alone':
    case 'not_allowed':
      return `Jev would ${handoff.recommends ?? 'act on'} it (${sure} sure), but the Warden may not do that alone.`;
    case 'no_message':
      return `Jev would nudge it but had no message it was sure of (${sure} sure).`;
    case 'cannot_choose_login':
      return `Jev thinks it needs another login (${sure} sure) and cannot choose which.`;
    case 'not_offered':
      return 'Jev chose an act that does not fit this flag, so it was not carried out.';
    case 'failed':
      return `Jev could not answer${handoff.failure === undefined ? '' : ` (${handoff.failure.replaceAll('_', ' ')})`}.`;
    case 'already_acted':
      return 'Jev already acted on this once and it is still flagged.';
    case 'not_judgeable':
      return 'Jev does not judge this kind of flag.';
    default:
      return `Jev handed it on (${handoff.why.replaceAll('_', ' ')}).`;
  }
}

/** What the daemon saw and how Jev's questions were answered, for a card that must stand on its own. */
function jevPathLines(path: readonly WardenJevPathStep[] | undefined): readonly string[] {
  if (path === undefined || path.length === 0) return [];
  const facts = jevPathFacts(path);
  return [...(facts === '' ? [] : [`What the daemon saw: ${facts}.`]), `Jev’s questions: ${jevPathLine(path)}.`];
}

const JEV_TERM: AgendaTerm = {
  term: 'Jev',
  meaning:
    'The Warden’s quick first look at a flag: a small model asked a few yes/no questions, each with how sure it is.',
};

/** The reason a notification is raised, with everything its text needs. */
type Reason =
  | { readonly kind: 'needs_human'; readonly verdict: WardenEscalationVerdict; readonly evidenceAt: string }
  | (WardenOwnerRoute['reason'] & { readonly evidenceAt?: string });

/** The context, as its lines, and the one-sentence `why`. */
function whyNow(
  reason: Reason,
  remedy: WardenRemedyOutcome,
): { readonly why: string; readonly lines: readonly (string | undefined)[] } {
  switch (reason.kind) {
    case 'needs_human': {
      const why = reason.verdict.reason ?? 'A warden judged this node and asked for a human.';
      return {
        why,
        lines: [
          `A Warden investigation asked for you: explicit NEEDS_HUMAN recorded ${reason.verdict.at}, from report ${reason.verdict.reportPath}.`,
          judgedByLine(reason.verdict.spawn),
          `Remedy: ${remedy.why}`,
        ],
      };
    }
    case 'held':
      return {
        why: reason.action.detail,
        lines: [
          reason.action.detail,
          'The Warden may not do this alone; Settings › Warden › “Act alone” decides that.',
          reason.action.reportPath === undefined ? undefined : `Report: ${reason.action.reportPath}`,
        ],
      };
    case 'investigation_failed': {
      const record = reason.record;
      const ran =
        record.agent === undefined ? '' : `, ${record.agent}${record.model === undefined ? '' : ` / ${record.model}`}`;
      const why = 'The Warden’s investigation finished without a verdict it could read.';
      return {
        why,
        lines: [
          `${why} Warden session ${record.id}${ran}, finished ${record.finishedAt ?? 'unknown'}.`,
          `Report: ${record.reportPath}`,
        ],
      };
    }
    case 'jev': {
      const why = jevLine(reason.handoff);
      return {
        why,
        lines: [
          why,
          ...jevPathLines(reason.handoff.path),
          reason.handoff.reason === undefined ? undefined : `Jev said: “${flatten(reason.handoff.reason)}”`,
          `No investigation follows: ${layerOff(reason.layers.llm, 'investigations')}.`,
        ],
      };
    }
    case 'untriaged': {
      const why = `Nothing could look at it: ${layerOff(reason.layers.llm, 'investigations')}, and ${layerOff(reason.layers.jev, 'Jev')}.`;
      return { why, lines: [why] };
    }
  }
}

/** What the Warden recommends, in plain words, for each act it can name. */
const RECOMMENDS: Readonly<Record<string, string>> = {
  leave: 'The Warden thinks it can be left alone.',
  bless: 'The Warden thinks it can be left alone.',
  nudge: 'The Warden recommends a nudge.',
  resume: 'The Warden recommends resuming it.',
  restart: 'The Warden recommends restarting it, with its conversation intact.',
  stop: 'The Warden recommends stopping it.',
  failover: 'The Warden recommends moving it to another login.',
  migrate: 'The Warden recommends moving it to another login.',
};

/** The remedy a reason recommends, as one sentence, or the honest fallback when it names none. */
function recommendedRemedy(reason: Reason): string {
  const act =
    reason.kind === 'needs_human'
      ? reason.verdict.recommendation?.action
      : reason.kind === 'held'
        ? reason.action.action
        : reason.kind === 'jev'
          ? reason.handoff.recommends
          : undefined;
  if (act === 'migrate' && reason.kind === 'needs_human' && reason.verdict.recommendation?.agent !== undefined)
    return `The Warden recommends moving it to ${reason.verdict.recommendation.agent}.`;
  return (act === undefined ? undefined : RECOMMENDS[act]) ?? 'Open it and decide what it needs.';
}

/** The recommended action as a sentence, for an investigation that named one. */
function recommendationLine(recommendation: WardenRecommendation | undefined): string {
  if (recommendation === undefined) return 'The warden named no single next step, so decide from the evidence above.';
  const target = recommendation.agent === undefined ? '' : ` (${recommendation.agent})`;
  return `The warden recommends ${recommendation.action.toUpperCase()}${target}: ${flatten(recommendation.reason)}`;
}

type Notice = Omit<WardenEscalationRaise, 'sessionId' | 'subjectKey' | 'source' | 'sourceRef' | 'anomalyKind'>;

/** The notification for one ferret's own subject. */
function ferretNotice(input: {
  readonly subject: Subject;
  readonly node: WardenEscalationNode;
  readonly reason: Reason;
  readonly remedy: WardenRemedyOutcome;
  readonly clientName: string;
  readonly machine: string | undefined;
  readonly waitingSince: string;
}): Notice {
  const { subject, node, reason } = input;
  const kind = subject.anomaly.kind;
  const now = whyNow(reason, input.remedy);
  const remedy = recommendedRemedy(reason);
  const id = node.config.id;
  const cli = input.clientName;
  const usesJev = reason.kind === 'jev' || (reason.kind === 'held' && reason.action.by === 'jev');
  return {
    title: clamp(`${nodeName(node)} ${PREDICATE[kind]}`, AGENDA_PUSH_TITLE_LENGTH),
    subject: clamp(flatten(`${nodeReference(node)} ${PREDICATE[kind]}. ${remedy}`), AGENDA_PUSH_BODY_LENGTH),
    why: clamp(flatten(now.why), MAX_AGENDA_DETAIL_LENGTH),
    premise: bullets([nodeFactsLine(node, input.machine), detectorLine(subject.anomaly)], MAX_AGENDA_REASON_LENGTH),
    context: bullets([...now.lines, remedy], MAX_AGENDA_DETAIL_LENGTH),
    howToResolve: clamp(
      [
        `Open ${nodeReference(node)} (session ${id}) and read its last turn. ${remedy}`,
        ...(reason.kind === 'needs_human' ? [recommendationLine(reason.verdict.recommendation)] : []),
        `From a terminal: \`${cli} send ${id} <message>\`, \`${cli} resume ${id}\` or \`${cli} stop ${id}\`.`,
        'This notification clears itself once the ferret stops being flagged.',
      ].join('\n'),
      MAX_AGENDA_DETAIL_LENGTH,
    ),
    ...(usesJev ? { terms: [JEV_TERM] } : {}),
    waitingSince: input.waitingSince,
    notice: true,
    ping: true,
    ...(reason.kind === 'needs_human' ? { reportPath: reason.verdict.reportPath } : {}),
    reason: reason.kind,
  };
}

/** The notification for a fault that names several ferrets: something to know about the machine. */
function fleetNotice(input: {
  readonly subject: Subject;
  readonly nodes: ReadonlyMap<string, WardenEscalationNode>;
  readonly reason: Reason;
  readonly remedy: WardenRemedyOutcome;
  readonly machine: string | undefined;
  readonly waitingSince: string;
}): Notice {
  const { subject } = input;
  const kind = subject.anomaly.kind;
  const count = subject.targets.length;
  const ferrets = `${count} ferret${count === 1 ? '' : 's'}`;
  const named = subject.targets
    .slice(0, 6)
    .map(id => {
      const node = input.nodes.get(id);
      return node === undefined ? id : nodeReference(node);
    })
    .join(', ');
  const more = count > 6 ? ` and ${count - 6} more` : '';
  const where = input.machine === undefined ? 'this machine' : input.machine;
  const now = whyNow(input.reason, input.remedy);
  const title =
    kind === 'dead_monitor'
      ? `${ferrets} are not being watched`
      : kind === 'provider_unavailable' && subject.anomaly.provider !== undefined
        ? `${ferrets} can’t reach ${subject.anomaly.provider}`
        : `${ferrets}: ${wardenAnomalySubject(kind)}`;
  return {
    title: clamp(title, AGENDA_PUSH_TITLE_LENGTH),
    subject: clamp(
      flatten(`${wardenAnomalySubject(kind)} on ${where}, for ${ferrets}. Check the machine.`),
      AGENDA_PUSH_BODY_LENGTH,
    ),
    why: clamp(flatten(now.why), MAX_AGENDA_DETAIL_LENGTH),
    premise: bullets(
      [`Ferrets on ${where}: ${named}${more}.`, detectorLine(subject.anomaly)],
      MAX_AGENDA_REASON_LENGTH,
    ),
    context: bullets(now.lines, MAX_AGENDA_DETAIL_LENGTH),
    howToResolve: clamp(
      'This is about the machine, not one ferret: look at its daemon, its provider and its logins. It clears itself once the fault does.',
      MAX_AGENDA_DETAIL_LENGTH,
    ),
    ...(input.reason.kind === 'jev' ? { terms: [JEV_TERM] } : {}),
    waitingSince: input.waitingSince,
    notice: true,
    ping: true,
    ...(input.reason.kind === 'needs_human' ? { reportPath: input.reason.verdict.reportPath } : {}),
    reason: input.reason.kind,
  };
}

/** The live node that should hold a subject's notification, or nothing when none of its ferrets can. */
function homeOf(
  subject: Subject,
  nodes: ReadonlyMap<string, WardenEscalationNode>,
  openOn: readonly string[],
): string | undefined {
  const live = (id: string): boolean => {
    const node = nodes.get(id);
    return node !== undefined && !isTerminalStatus(node.state.status);
  };
  // Sticky: one already open stays where the owner first saw it while that ferret still qualifies.
  const sticky = openOn.find(id => subject.targets.includes(id) && live(id));
  if (sticky !== undefined) return sticky;
  return subject.targets.find(live);
}

/**
 * The strongest reason a subject is the owner's: an explicit investigation verdict about this episode,
 * else the Warden's own state. A machine subject takes the newest explicit verdict on any ferret it names.
 */
function reasonFor(
  subject: Subject,
  verdicts: ReadonlyMap<string, WardenEscalationVerdict>,
  routes: ReadonlyMap<string, WardenOwnerRoute>,
): Reason | undefined {
  let verdict: WardenEscalationVerdict | undefined;
  for (const id of subject.targets) {
    const candidate = verdicts.get(anomalyKey(id, subject.anomaly.kind));
    if (candidate === undefined || !verdictCoversEpisode(candidate, subject.anomaly)) continue;
    if (verdict === undefined || (instantMs(candidate.at) ?? 0) > (instantMs(verdict.at) ?? 0)) verdict = candidate;
  }
  if (verdict !== undefined) return { kind: 'needs_human', verdict, evidenceAt: verdict.at };
  const route = routes.get(flagKey(subject.anomaly));
  if (route === undefined) return undefined;
  return { ...route.reason, ...(route.evidenceAt === undefined ? {} : { evidenceAt: route.evidenceAt }) };
}

/**
 * The raises and resolutions this sweep's evidence supports, and the subjects that still stand.
 *
 * Deterministic: the same inputs always yield the same plan in the same order.
 */
export function planWardenEscalations(input: WardenEscalationInput): WardenEscalationPlan {
  const nodesById = new Map(input.nodes.map(node => [node.config.id, node]));
  const boardsById = new Map(input.boards.map(board => [board.sessionId, board]));
  const verdicts = explicitNeedsHumanVerdicts(input.verdicts);
  const routes = new Map((input.routes ?? []).map(route => [flagKey(route.anomaly), route]));
  const notified = input.notified ?? new Set<string>();

  // Where each of our notifications is open, by source reference.
  const openOn = new Map<string, string[]>();
  for (const board of input.boards)
    for (const item of board.items)
      if (isWardenEscalationItem(item) && item.sourceRef !== null)
        openOn.set(item.sourceRef, [...(openOn.get(item.sourceRef) ?? []), board.sessionId]);

  // One subject per ferret and class, or per machine fault: the first record of it this sweep wins.
  const subjects = new Map<string, Subject>();
  for (const anomaly of input.anomalies) {
    const subject = subjectOf(anomaly);
    if (!subjects.has(subject.key)) subjects.set(subject.key, subject);
  }

  const raise: WardenEscalationRaise[] = [];
  const standing: string[] = [];
  /** `[board, sourceRef]` pairs a notification stays open on this sweep. */
  const kept = new Set<string>();
  if (remedyPermitsEscalation(input.remedy)) {
    for (const subject of subjects.values()) {
      const reason = reasonFor(subject, verdicts, routes);
      if (reason === undefined) continue;
      standing.push(subject.key);
      const open = openOn.get(subject.sourceRef) ?? [];
      const home = homeOf(subject, nodesById, open);
      if (home === undefined) continue;
      const node = nodesById.get(home);
      if (node === undefined) continue;
      const isOpen = open.includes(home);
      // ALREADY TOLD. The owner was notified about this subject and it has not cleared since: reading the
      // notification closed it, and a new one every sweep would make the Inbox unusable.
      if (!isOpen && notified.has(subject.key)) continue;
      // A ferret waiting on a question its board already asks the owner: a second notification would ask
      // the same thing twice. An investigation that asked for a human is still its own.
      if (
        !isOpen &&
        reason.kind !== 'needs_human' &&
        subject.anomaly.kind === 'unattended_question' &&
        (boardsById.get(home)?.items ?? []).some(item => !isWardenEscalationItem(item))
      )
        continue;
      kept.add(JSON.stringify([home, subject.sourceRef]));
      const waitingSince = subject.anomaly.since ?? reason.evidenceAt ?? input.at ?? new Date(0).toISOString();
      const notice = subject.fleet
        ? fleetNotice({ subject, nodes: nodesById, reason, remedy: input.remedy, machine: input.machine, waitingSince })
        : ferretNotice({
            subject,
            node,
            reason,
            remedy: input.remedy,
            clientName: input.clientName,
            machine: input.machine,
            waitingSince,
          });
      raise.push({
        sessionId: home,
        anomalyKind: subject.anomaly.kind,
        subjectKey: subject.key,
        source: WARDEN_ESCALATION_SOURCE,
        // NEVER clamped: the reference is the dedupe key, and a truncated key would create a second row.
        sourceRef: subject.sourceRef,
        ...notice,
      });
    }
  }

  // Clearing is driven by the BOARD, because the row that has to go is the one somebody actually wrote.
  const resolve: WardenEscalationResolution[] = [];
  for (const board of input.boards) {
    for (const item of board.items) {
      if (item.sourceRef === null) continue;
      const legacy = legacyKindOf(item);
      if (legacy !== undefined) {
        resolve.push({
          sessionId: board.sessionId,
          anomalyKind: legacy,
          source: item.source,
          sourceRef: item.sourceRef,
          note: LEGACY_ESCALATION_NOTE,
        });
        continue;
      }
      if (!isWardenEscalationItem(item) || kept.has(JSON.stringify([board.sessionId, item.sourceRef]))) continue;
      const identity = parseWardenEscalationSourceRef(item.sourceRef) as WardenEscalationIdentity;
      const node = nodesById.get(board.sessionId);
      const current = [...subjects.values()].some(
        subject =>
          subject.sourceRef === item.sourceRef && (subject.fleet || subject.anomaly.sessionId === board.sessionId),
      );
      const note =
        node === undefined
          ? 'Cleared by the daemon: this node is no longer in the fleet.'
          : isTerminalStatus(node.state.status)
            ? `Cleared by the daemon: this node is ${node.state.status} and is no longer running.`
            : !current
              ? `Cleared by the daemon: the node recovered — ${identity.kind} is no longer detected.`
              : 'Cleared by the Warden: this no longer waits on you — it was left alone, cleared, or is being looked at again.';
      resolve.push({
        sessionId: board.sessionId,
        anomalyKind: identity.kind,
        source: WARDEN_ESCALATION_SOURCE,
        sourceRef: item.sourceRef,
        note,
      });
    }
  }

  return {
    raise: raise.toSorted(byNodeThenRef),
    resolve: resolve.toSorted(byNodeThenRef),
    standing: standing.toSorted(),
  };
}

function byNodeThenRef(
  left: { readonly sessionId: string; readonly sourceRef: string },
  right: { readonly sessionId: string; readonly sourceRef: string },
): number {
  return left.sessionId.localeCompare(right.sessionId) || left.sourceRef.localeCompare(right.sourceRef);
}
