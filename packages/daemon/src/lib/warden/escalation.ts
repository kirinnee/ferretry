/**
 * Turning a warden's explicit NEEDS_HUMAN verdict into exactly one durable,
 * node-scoped Attention item — and clearing it again when the node recovers.
 *
 * ═══ WHAT MAY INTERRUPT A PERSON ═══
 *
 * Two facts, BOTH required, and neither sufficient alone:
 *
 * 1. The node is anomalous RIGHT NOW, in this sweep's detector output. A status
 *    transition is not evidence. An Attention row the session already has is not
 *    evidence — it is the very thing that must never escalate itself. A report
 *    about a situation nobody can still observe is not evidence either: a
 *    verdict that lands after the node recovered resolves the item instead of
 *    raising one.
 * 2. A warden wrote an EXPLICIT `Verdict: NEEDS_HUMAN` marker for that exact
 *    node and that exact anomaly class, ABOUT THE EPISODE HAPPENING NOW.
 *    `explicitNeedsHuman` is what separates the marker from prose that merely
 *    sounds worried; the verdict parser's heuristics stay report history and can
 *    never become a durable human interruption on their own. And a marker
 *    written before the current episode began judged a different situation — see
 *    `verdictCoversEpisode`, without which one old report re-interrupts a person
 *    at every later recurrence of the same class.
 *
 * A third gate stands in front of both: a safe remedy must be unavailable or
 * have failed. This daemon's answer today is that no remedy is permitted at all
 * — see `planWardenRemedy`, which states the prohibition rather than pretending
 * a repair ran.
 *
 * ═══ ONE ITEM PER NODE PER CLASS ═══
 *
 * The source reference is `warden:<anomalyKind>` on the flagged session's own
 * board. Keying on the class alone — rather than on the report that happened to
 * observe it — is what makes a recurring situation refresh one row instead of
 * growing a new one every sweep. The report that raised it is carried in the
 * item's context and in the journal, where a second row is not the price of
 * keeping it.
 *
 * ═══ THIS MODULE NEVER FEEDS DETECTION ═══
 *
 * Attention is read here, after the detector has already run, and the only
 * output is a plan of raises and resolutions. Nothing read here reaches the
 * detector, the anomaly set, or a warden prompt, so a board row cannot create,
 * suppress or alter an anomaly. The sweep calls it last for exactly that reason.
 *
 * Pure: every input arrives through the arguments, including the clock's work
 * already done for it — instants are compared, never read.
 */

import {
  MAX_ATTENTION_DETAIL_LENGTH,
  MAX_ATTENTION_SUBJECT_LENGTH,
  type AttentionBy,
  type AttentionSource,
} from '@ferretry/protocol';
import { wardenAnomalySubject, type WardenAnomaly, type WardenAnomalyKind } from './detect.ts';
import { wardenTeammateToken } from './prompt.ts';
import type { WardenVerdictSpawn } from './reports.ts';
import { instantMs } from './time.ts';
import { isTerminalStatus, type WardenSessionConfig, type WardenSessionStatus } from './types.ts';
import {
  parseWardenVerdictSourceRef,
  wardenVerdictSourceRef,
  type WardenRecommendation,
  type WardenVerdict,
} from './verdicts.ts';

/**
 * The board source a warden escalation is written to.
 *
 * `agent-raised` is the only source the state machine lets a stable
 * `sourceRef` ride on, and a non-null `sourceRef` is reserved for a daemon
 * actor — which is precisely the dedupe key this whole module turns on.
 */
export const WARDEN_ESCALATION_SOURCE: AttentionSource = 'agent-raised';

/** A parsed report row as the escalation reads it: the verdict, plus the
 *  daemon-owned sidecar naming which account and model actually judged it. */
export type WardenEscalationVerdict = WardenVerdict & { readonly spawn?: WardenVerdictSpawn };

/** The node an escalation is about, as the escalation reads it. The sweep's own
 *  fleet session satisfies this; the narrower shape is what keeps this module
 *  independent of how the fleet is assembled. */
export interface WardenEscalationNode {
  readonly config: Pick<WardenSessionConfig, 'id' | 'teammate' | 'label' | 'agent' | 'model' | 'modelHint'>;
  readonly state: { readonly status: WardenSessionStatus };
}

/** One active board row, as the escalation reads it. */
export interface WardenEscalationBoardItem {
  readonly source: AttentionSource;
  readonly sourceRef: string | null;
  readonly raisedBy: AttentionBy;
}

/** One addressed board row. The instant is the watermark that stops a verdict a
 *  human has already acted on from raising the same item again. */
export interface WardenEscalationBoardResolution {
  readonly source: AttentionSource;
  readonly sourceRef: string | null;
  readonly resolvedAt: string;
}

/** One session's board. An `AttentionSnapshot` satisfies it as read. */
export interface WardenEscalationBoard {
  readonly sessionId: string;
  readonly items: readonly WardenEscalationBoardItem[];
  readonly resolved: readonly WardenEscalationBoardResolution[];
}

/** What the daemon was allowed to do about a suspicious node, and what came of
 *  it. `applied` is the only disposition that withholds an escalation. */
export type WardenRemedyDisposition = 'forbidden' | 'failed' | 'applied';

export interface WardenRemedyOutcome {
  readonly disposition: WardenRemedyDisposition;
  /** Written for the person who will read it on the board, not for a log. */
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
 * BOTH ANSWERS ARE `forbidden`, and that is the honest state of this daemon
 * rather than a stub. A warden here holds no credential over any session, so
 * nudging, resuming, migrating and stopping are all unavailable to it; and the
 * daemon itself has no configured recovery policy naming which of those would be
 * permitted even if it did. Reporting an attempt that never happened would be
 * the one failure worse than escalating: a person would read "we tried" over a
 * node nothing has touched.
 *
 * The two branches say WHICH prohibition applies, because the remedies a future
 * policy unlocks are not the same set as the ones a credential would.
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

/**
 * Whether the remedy record leaves an escalation open.
 *
 * A repair that was applied and held fixed the node, so nobody needs waking. A
 * forbidden one and a failed one are the two cases the row names, and they are
 * the two that reach a person.
 */
export function remedyPermitsEscalation(outcome: WardenRemedyOutcome): boolean {
  return outcome.disposition !== 'applied';
}

/** One Attention item to raise or refresh on a node's own board. */
export interface WardenEscalationRaise {
  readonly sessionId: string;
  readonly anomalyKind: WardenAnomalyKind;
  readonly source: AttentionSource;
  readonly sourceRef: string;
  readonly subject: string;
  readonly why: string;
  readonly context: string;
  readonly howToResolve: string;
  readonly waitingSince: string;
  /** Journal evidence: the exact report the escalating verdict was read from. */
  readonly reportPath: string;
}

/** One live escalation whose reason has gone away. */
export interface WardenEscalationResolution {
  readonly sessionId: string;
  readonly anomalyKind: WardenAnomalyKind;
  readonly source: AttentionSource;
  readonly sourceRef: string;
  /** Kept as the resolution note, so the audit trail says why it cleared. */
  readonly note: string;
}

export interface WardenEscalationPlan {
  readonly raise: readonly WardenEscalationRaise[];
  readonly resolve: readonly WardenEscalationResolution[];
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
}

/** The stable, daemon-owned identity of a node's escalation for one class. */
export function wardenEscalationSourceRef(kind: WardenAnomalyKind): string {
  // Never undefined for a known kind; the fallback keeps this total rather than
  // asserting over a helper that is allowed to answer nothing.
  return wardenVerdictSourceRef(undefined, kind) ?? `warden:${kind}`;
}

/** The escalation identity a live board row carries, or nothing when the row is
 *  not one of ours. */
function escalatedIdentityOf(
  item: WardenEscalationBoardItem,
): { readonly kind: WardenAnomalyKind; readonly sourceRef: string } | undefined {
  // Only a DAEMON-raised row on the escalation source can be one of ours. The
  // state machine already reserves a stable `sourceRef` for a daemon actor, so
  // this is belt and braces — but resolving somebody else's row because its text
  // happened to parse would be a silent theft of their board entry.
  const sourceRef = item.sourceRef;
  if (item.raisedBy !== 'daemon' || item.source !== WARDEN_ESCALATION_SOURCE || sourceRef === null) return undefined;
  const identity = parseWardenVerdictSourceRef(sourceRef);
  // The bare-class form only. A `warden:<report>#<kind>` reference names one
  // exact report block and is not the node-scoped identity this module owns.
  if (identity?.reportPath !== undefined || identity?.anomalyKind === undefined) return undefined;
  return { kind: identity.anomalyKind, sourceRef };
}

/** Composite map keys. JSON-encoding the parts makes the key unambiguous by
 *  construction: a source reference may carry any character the report path it
 *  was derived from allows, so no separator is safe to concatenate on. */
const anomalyKey = (sessionId: string, kind: WardenAnomalyKind): string => JSON.stringify([sessionId, kind]);
const sourceKey = (sessionId: string, source: AttentionSource, sourceRef: string): string =>
  JSON.stringify([sessionId, source, sourceRef]);

/** Every session a single anomaly record speaks for. A fleet-wide anomaly is one
 *  record naming many nodes, and the node that is stuck owns the item. */
function anomalyTargets(anomaly: WardenAnomaly): readonly string[] {
  const targets = [anomaly.sessionId, ...(anomaly.affectedSessionIds ?? [])];
  return [...new Set(targets)].filter(sessionId => sessionId !== '');
}

const flatten = (value: string): string => value.replaceAll(/\s+/gu, ' ').trim();

/** Fit a field to what the board's own schema accepts. A refusal at the write is
 *  a lost interruption, so the text is trimmed here rather than gambled on. */
function clamp(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, Math.max(0, maximum - 1)).trimEnd()}…`;
}

/**
 * The newest EXPLICIT needs-human verdict per (node, class).
 *
 * Everything else in the report history is filtered out here, once, so no
 * downstream branch has to remember the rule. A verdict with no target or no
 * anomaly class cannot be attached to a node-scoped item at all.
 */
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

/** The node as a reference a reader's client can prove and link: the teammate
 *  callsign when the session has one, its bare id when it does not. */
function nodeReference(node: WardenEscalationNode): string {
  return node.config.teammate === undefined ? node.config.id : wardenTeammateToken(node.config.teammate);
}

/** Who ran the check, from the daemon's own sidecar. Never from the report's
 *  prose: a model that wrote its own provenance would be feeding the vocabulary
 *  the verdict parser reads back into the verdict. */
function judgedByLine(spawn: WardenVerdictSpawn | undefined): string | undefined {
  if (spawn === undefined) return undefined;
  return `Judged by: ${spawn.agent} running ${spawn.model} on the ${spawn.harness} harness (warden session ${spawn.wardenSessionId}).`;
}

/**
 * The node's own CLI and model, taken from SESSION METADATA.
 *
 * The warden's prompt forbids a report writing these, precisely so that a
 * model's guess about its own identity can never reach a person as fact. This is
 * where they come from instead.
 *
 * The model falls back to the start's resolved `modelHint`: a session whose
 * account pinned no model has nothing in `model` and is still, demonstrably,
 * running one. Reporting "not recorded" for it would be a blank the reader has
 * no way to fill.
 */
function nodeFactsLine(node: WardenEscalationNode): string {
  const cli = node.config.agent ?? 'not recorded';
  const model = node.config.model ?? node.config.modelHint ?? 'not recorded';
  return `Node: ${nodeReference(node)} — session ${node.config.id}, CLI ${cli}, model ${model}, status ${node.state.status}.`;
}

function detectorLine(anomaly: WardenAnomaly): string {
  const since = anomaly.since === undefined ? '' : ` Anomalous since ${anomaly.since}.`;
  const idle = anomaly.idleMinutes === undefined ? '' : ` Idle ${anomaly.idleMinutes}m.`;
  return `Detector evidence (${anomaly.kind}): ${flatten(anomaly.detail)}.${since}${idle}`;
}

function verdictLine(verdict: WardenEscalationVerdict): string {
  return `Warden verdict: explicit NEEDS_HUMAN recorded ${verdict.at}, from report ${verdict.reportPath}.`;
}

/**
 * Whether this verdict judged the episode that is happening NOW.
 *
 * A recurrence is a new situation, and a marker written about the LAST one is
 * not evidence about it. Without this, a needs-human verdict still inside the
 * report window resurrects itself against every later recurrence of the same
 * class — and the addressed-history watermark does not save it, because a board
 * write that was missed, unreadable, or simply predates this reconciliation
 * leaves no watermark to compare against. The warden must judge the current
 * episode before a person is interrupted about it.
 *
 * FAILS CLOSED on an anchor it cannot read. An instant that will not parse is
 * not permission to assume the verdict is current; it is a reason to wait for a
 * report whose instant does parse.
 *
 * An anomaly with NO anchor at all is a different case and is allowed through:
 * `dead_monitor` — and the collapsed daemon-level fault it becomes — carries no
 * episode start, because "no live monitor handle" is a state rather than an
 * episode. There is nothing to be stale relative to, and refusing would mean
 * that class could never reach a person at all. Repetition there is held by the
 * addressed-history watermark alone.
 */
function verdictCoversEpisode(verdict: WardenEscalationVerdict, anomaly: WardenAnomaly): boolean {
  if (anomaly.since === undefined) return true;
  const episodeMs = instantMs(anomaly.since);
  const verdictMs = instantMs(verdict.at);
  if (episodeMs === undefined || verdictMs === undefined) return false;
  return verdictMs >= episodeMs;
}

/** The recommended action as a sentence, when the report named one. */
function recommendationLine(recommendation: WardenRecommendation | undefined): string {
  if (recommendation === undefined) return 'The warden named no single next step, so decide from the evidence above.';
  const target = recommendation.agent === undefined ? '' : ` (${recommendation.agent})`;
  return `The warden recommends ${recommendation.action.toUpperCase()}${target}: ${flatten(recommendation.reason)}`;
}

function escalationContext(input: {
  readonly anomaly: WardenAnomaly;
  readonly verdict: WardenEscalationVerdict;
  readonly node: WardenEscalationNode;
  readonly remedy: WardenRemedyOutcome;
}): string {
  const lines = [
    detectorLine(input.anomaly),
    verdictLine(input.verdict),
    judgedByLine(input.verdict.spawn),
    nodeFactsLine(input.node),
    `Remedy: ${flatten(input.remedy.why)}`,
  ].filter((line): line is string => line !== undefined);
  return clamp(lines.join('\n'), MAX_ATTENTION_DETAIL_LENGTH);
}

function escalationHowToResolve(input: {
  readonly node: WardenEscalationNode;
  readonly verdict: WardenEscalationVerdict;
  readonly clientName: string;
}): string {
  const id = input.node.config.id;
  const cli = input.clientName;
  const lines = [
    `Open ${nodeReference(input.node)} (session ${id}) and read its last turn before deciding.`,
    recommendationLine(input.verdict.recommendation),
    `Then continue it with \`${cli} send ${id} <message>\`, restart its turn with \`${cli} resume ${id}\`, or end it with \`${cli} stop ${id}\`.`,
    'This item clears itself once the node stops being flagged; resolve it here when you have acted.',
  ];
  return clamp(lines.join('\n'), MAX_ATTENTION_DETAIL_LENGTH);
}

/**
 * The raises and resolutions this sweep's evidence supports.
 *
 * Deterministic: the same inputs always yield the same plan in the same order,
 * so a caller can compare two sweeps without sorting them first.
 */
export function planWardenEscalations(input: WardenEscalationInput): WardenEscalationPlan {
  const nodesById = new Map(input.nodes.map(node => [node.config.id, node]));
  const current = new Map<string, { readonly sessionId: string; readonly anomaly: WardenAnomaly }>();
  for (const anomaly of input.anomalies) {
    for (const sessionId of anomalyTargets(anomaly))
      current.set(anomalyKey(sessionId, anomaly.kind), { sessionId, anomaly });
  }

  const verdicts = explicitNeedsHumanVerdicts(input.verdicts);
  const resolvedWatermarks = new Map<string, number>();
  for (const board of input.boards) {
    for (const entry of board.resolved) {
      if (entry.sourceRef === null) continue;
      const key = sourceKey(board.sessionId, entry.source, entry.sourceRef);
      const at = instantMs(entry.resolvedAt) ?? 0;
      resolvedWatermarks.set(key, Math.max(resolvedWatermarks.get(key) ?? 0, at));
    }
  }

  const raise: WardenEscalationRaise[] = [];
  if (remedyPermitsEscalation(input.remedy)) {
    for (const [key, { sessionId, anomaly }] of current) {
      const node = nodesById.get(sessionId);
      // A node this daemon cannot see is a node whose CLI and model it cannot
      // derive and whose board it has no business writing to.
      if (node === undefined || isTerminalStatus(node.state.status)) continue;
      // The NEWEST verdict for this class, so if it does not cover the current
      // episode no older one can either.
      const verdict = verdicts.get(key);
      if (verdict === undefined || !verdictCoversEpisode(verdict, anomaly)) continue;

      const sourceRef = wardenEscalationSourceRef(anomaly.kind);
      // ALREADY ADDRESSED. A person who resolved or dismissed this exact item
      // after the verdict was written has answered it; resurrecting it every
      // five minutes would make the board unusable. A genuinely NEWER verdict
      // is past the watermark and raises again, which is the whole point of
      // comparing instants rather than keeping a second acknowledgement list.
      const watermark = resolvedWatermarks.get(sourceKey(sessionId, WARDEN_ESCALATION_SOURCE, sourceRef));
      if (watermark !== undefined && watermark >= (instantMs(verdict.at) ?? 0)) continue;

      raise.push({
        sessionId,
        anomalyKind: anomaly.kind,
        source: WARDEN_ESCALATION_SOURCE,
        // NEVER clamped: the reference is the dedupe key, and a truncated key
        // would create a second row rather than refresh the first.
        sourceRef,
        subject: clamp(
          flatten(`${nodeReference(node)} needs a human — ${wardenAnomalySubject(anomaly.kind)}`),
          MAX_ATTENTION_SUBJECT_LENGTH,
        ),
        why: clamp(
          flatten(verdict.reason ?? 'A warden judged this node and asked for a human.'),
          MAX_ATTENTION_DETAIL_LENGTH,
        ),
        context: escalationContext({ anomaly, verdict, node, remedy: input.remedy }),
        howToResolve: escalationHowToResolve({ node, verdict, clientName: input.clientName }),
        waitingSince: anomaly.since ?? verdict.at,
        reportPath: verdict.reportPath,
      });
    }
  }

  // Clearing is driven by the BOARD rather than by the node list, because the row
  // that has to go is the one somebody actually wrote, and only the board knows
  // which those are.
  //
  // THE FIRST BRANCH BELOW IS UNREACHABLE FROM THE SWEEP, and is still answered
  // because this is a total function over two independent inputs.
  // `reconcileEscalations` appends to its `boards` and its `nodes` in the same
  // step or to neither, so `boards` is always a subset of `nodes`; and the
  // composition root closes the other direction, because the reader that lists
  // the fleet and the directory that authorizes a board read resolve to the same
  // set of sessions. A session the registry has dropped therefore contributes no
  // board here at all — and its ledger lives inside its own session directory, so
  // a directory deleted outside this daemon takes the board and its resolution
  // audit with it. There is no removal moment at which an orphan board exists to
  // be read.
  //
  // What the branch is for is the caller that does not exist yet. Session removal
  // is currently an observation rather than an act: there is no delete route, and
  // the index drops a row only after the directory or its documents are already
  // gone or refused. A delete route must resolve these rows BEFORE it retires the
  // session, while the board is still authorized, and would be the one caller able
  // to hand this planner a board whose node has left. Answering `undefined` here
  // would silently retain that row forever, which is the outcome this whole
  // reconciliation exists to prevent.
  const resolve: WardenEscalationResolution[] = [];
  for (const board of input.boards) {
    for (const item of board.items) {
      const identity = escalatedIdentityOf(item);
      if (identity === undefined) continue;
      const node = nodesById.get(board.sessionId);
      const note =
        node === undefined
          ? 'Cleared by the daemon: this node is no longer in the fleet.'
          : isTerminalStatus(node.state.status)
            ? `Cleared by the daemon: this node is ${node.state.status} and is no longer running.`
            : current.has(anomalyKey(board.sessionId, identity.kind))
              ? undefined
              : `Cleared by the daemon: the node recovered — ${identity.kind} is no longer detected.`;
      if (note === undefined) continue;
      resolve.push({
        sessionId: board.sessionId,
        anomalyKind: identity.kind,
        source: WARDEN_ESCALATION_SOURCE,
        sourceRef: identity.sourceRef,
        note,
      });
    }
  }

  return { raise: raise.toSorted(byNodeThenKind), resolve: resolve.toSorted(byNodeThenKind) };
}

function byNodeThenKind(
  left: { readonly sessionId: string; readonly anomalyKind: WardenAnomalyKind },
  right: { readonly sessionId: string; readonly anomalyKind: WardenAnomalyKind },
): number {
  return left.sessionId.localeCompare(right.sessionId) || left.anomalyKind.localeCompare(right.anomalyKind);
}
