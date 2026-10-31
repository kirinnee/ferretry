/**
 * Jev's decision TREE: a short chain of yes/no questions, facts first, that ends in one action.
 *
 * WHY. Jev used to pick one answer from seven (leave, nudge, resume, restart, failover, stop, unsure)
 * with one confidence. Seven options spread its confidence so thin that it was rarely sure of any of
 * them, and almost every flag went on to an investigation or to the owner. A yes/no question puts all
 * of Jev's confidence on one of two answers, and the questions the daemon can answer itself — is the
 * program running, did its output change, is a dialog on screen — are never asked of Jev at all.
 *
 * THE TREE (the owner approved it, !A120):
 *
 * ```text
 * running? (fact)
 * ├─ no ─ finished on purpose? (Jev)
 * │       ├─ yes ─ LEAVE
 * │       └─ no ── out of quota or provider down? (fact)
 * │               ├─ yes ─ RESUME after the reset, or FAILOVER to another login
 * │               └─ no ── RESTART
 * └─ yes ─ output changed lately? (fact)
 *         ├─ yes ─ doing new things, not repeating itself? (Jev)
 *         │       ├─ yes ─ LEAVE
 *         │       └─ no ── already nudged about this? (fact)
 *         │               ├─ no ── NUDGE: you seem to be looping
 *         │               └─ yes ─ STOP
 *         └─ no ── waiting on something real? (Jev, shown the facts)
 *                 ├─ yes ─ is the wait still reasonable? (Jev)
 *                 │       ├─ yes ─ LEAVE
 *                 │       └─ no ── NUDGE: check on the wait
 *                 └─ no ── prompt or dialog on screen? (fact)
 *                         ├─ yes ─ NUDGE or answer the dialog — the owner's, never alone
 *                         └─ no ── RESTART
 * ```
 *
 * ONE CALL PER FLAG. The daemon answers every fact before Jev is called, so the only branches left
 * open are Jev's: one or two judgement questions ({@link reachableJudgements}), plus — when the open
 * branches can end in a nudge Jev may send — which message. They go in ONE request, each its own
 * question with its own answer: the second is phrased to stand alone ("if it is waiting, is the wait
 * still reasonable?"), so no answer depends on another, and the bill is one call, as before.
 *
 * ACTING. An act is carried out only when EVERY Jev answer on the path is at least as sure as the bar
 * for the leaf it reaches — the act's own `jevActs` bar, or `guard.threshold` for a leave (and for an
 * act the owner keeps for themselves, which is then only a recommendation). The first answer below the
 * bar is the one the owner is asked ({@link treeResponse}): "Is it doing new things, not repeating
 * itself?", with the facts the daemon saw — never a vague "Jev was unsure".
 *
 * Every other gate of the first responder still applies, unchanged (`triage.ts` {@link firstResponse}):
 * the acts the flag offers, `mayActAlone`, never-alone, the nudge message's own confidence, Jev's one
 * try, the daily and hourly caps and the provider back-off.
 *
 * Pure: no IO, no clock, no globals.
 */

import type { WardenAction, WardenJevPathStep } from '@ferretry/protocol';
import type { JevJudgement, JevYesNo, NudgeMessageId, TriageActVerdict, TriageDecision } from '../speedups/jev.ts';
import type { WardenAnomaly } from './detect.ts';
import { instantMs, latestInstantMs } from './time.ts';
import { firstResponse, type JevResponderPolicy, type WardenGuardOutcome } from './triage.ts';
import { isTerminalStatus, type WardenSessionView } from './types.ts';

// ── The tree ─────────────────────────────────────────────────────────────────────────────────────

/** The questions the daemon answers itself, from what it already observes. Never put to Jev. */
export const JEV_FACT_NODES = [
  'running',
  'quota_or_provider',
  'output_changed',
  'already_nudged',
  'dialog_on_screen',
] as const;
export type JevFactNode = (typeof JEV_FACT_NODES)[number];

/** The questions Jev answers, each a yes or a no with its own confidence. */
export const JEV_JUDGEMENT_NODES = [
  'finished_on_purpose',
  'doing_new_things',
  'waiting_on_real',
  'wait_reasonable',
] as const;
export type JevJudgementNode = (typeof JEV_JUDGEMENT_NODES)[number];

export type JevNode = JevFactNode | JevJudgementNode;

/** Where the tree ends. Each leaf is one action. */
export const JEV_LEAVES = [
  'leave_finished',
  'quota_or_provider',
  'restart_dead',
  'leave_progressing',
  'nudge_looping',
  'stop_looping',
  'leave_waiting',
  'nudge_wait',
  'dialog_owner',
  'restart_stuck',
] as const;
export type JevLeaf = (typeof JEV_LEAVES)[number];

interface JevBranch {
  readonly question: string;
  readonly yes: JevNode | { readonly leaf: JevLeaf };
  readonly no: JevNode | { readonly leaf: JevLeaf };
}

/** The tree as data: every node's question and where each answer goes. The root is `running`. */
export const JEV_TREE: Readonly<Record<JevNode, JevBranch>> = {
  running: {
    question: 'Is the agent program running?',
    yes: 'output_changed',
    no: 'finished_on_purpose',
  },
  finished_on_purpose: {
    question: 'Did it finish on purpose?',
    yes: { leaf: 'leave_finished' },
    no: 'quota_or_provider',
  },
  quota_or_provider: {
    question: 'Is it out of quota, or is its provider down?',
    yes: { leaf: 'quota_or_provider' },
    no: { leaf: 'restart_dead' },
  },
  output_changed: {
    question: 'Has its output changed lately?',
    yes: 'doing_new_things',
    no: 'waiting_on_real',
  },
  doing_new_things: {
    question: 'Is it doing new things, not repeating itself?',
    yes: { leaf: 'leave_progressing' },
    no: 'already_nudged',
  },
  already_nudged: {
    question: 'Was it already nudged about this?',
    yes: { leaf: 'stop_looping' },
    no: { leaf: 'nudge_looping' },
  },
  waiting_on_real: {
    question: 'Is it waiting on something real — a build, tests, a reply, the owner?',
    yes: 'wait_reasonable',
    no: 'dialog_on_screen',
  },
  wait_reasonable: {
    question: 'Is the wait still reasonable?',
    yes: { leaf: 'leave_waiting' },
    no: { leaf: 'nudge_wait' },
  },
  dialog_on_screen: {
    question: 'Is a prompt or dialog open on its screen?',
    yes: { leaf: 'dialog_owner' },
    no: { leaf: 'restart_stuck' },
  },
};

export const JEV_TREE_ROOT: JevNode = 'running';

const FACT_SET: ReadonlySet<string> = new Set(JEV_FACT_NODES);

export const isJevFactNode = (node: string): node is JevFactNode => FACT_SET.has(node);

/** The question a node asks, as the owner reads it. `undefined` for an id this tree does not have. */
export function jevNodeQuestion(node: string): string | undefined {
  return Object.hasOwn(JEV_TREE, node) ? JEV_TREE[node as JevNode].question : undefined;
}

/**
 * What Jev is told each judgement question means. Each stands alone: the questions go in one request,
 * and an answer must never lean on another one's.
 */
export const JEV_JUDGEMENT_QUESTIONS: Readonly<
  Record<JevJudgementNode, { readonly question: string; readonly yes: string; readonly no: string }>
> = {
  finished_on_purpose: {
    question:
      'The ferret is not working right now. Did it stop because it finished its task, or deliberately handed it back, on purpose?',
    yes: 'It finished or deliberately stopped: the work is done or it handed back on purpose.',
    no: 'It stopped part-way, crashed, or was cut off with work still left to do.',
  },
  doing_new_things: {
    question: 'The ferret is producing output. Is it making new progress, rather than repeating the same steps?',
    yes: 'Its recent steps are different from each other and move the task forward.',
    no: 'It is repeating the same steps, errors or messages in a loop without progress.',
  },
  waiting_on_real: {
    question:
      'The ferret has produced no new output lately. Is it waiting on something real — a build, tests, a command, a reply from another ferret, or the owner?',
    yes: 'It is waiting on a specific thing that exists and will finish or answer.',
    no: 'Nothing it could be waiting on is visible: it is stuck, idle or lost.',
  },
  wait_reasonable: {
    question:
      'Suppose the ferret is waiting on something. Judging by what it waits on and how long it has waited, is the wait still reasonable?',
    yes: 'A wait of this length is normal for what it waits on.',
    no: 'It has waited far longer than that should take, or the thing it waits on cannot finish.',
  },
};

/** Every leaf: the act it asks for, the reason recorded, and — for a nudge — the messages that fit. */
interface JevLeafSpec {
  readonly verdict: 'leave' | TriageActVerdict;
  readonly reason: string;
  /** The nudge messages Jev may choose from on this leaf. */
  readonly messages?: readonly NudgeMessageId[];
  /** The owner's act, whoever answered: a recommendation, never carried out alone. */
  readonly ownerOnly?: true;
}

const LEAF: Readonly<Record<Exclude<JevLeaf, 'quota_or_provider'>, JevLeafSpec>> = {
  leave_finished: { verdict: 'leave', reason: 'It finished on purpose; leave it alone.' },
  restart_dead: {
    verdict: 'restart',
    reason: 'Its program is not running, it did not finish on purpose and nothing outside it is in the way.',
  },
  leave_progressing: { verdict: 'leave', reason: 'Its output keeps changing and it is making new progress.' },
  nudge_looping: {
    verdict: 'nudge',
    reason: 'It seems to be repeating itself, and has not been nudged about it yet.',
    messages: ['poll_loop', 'lost_track', 'retry_error'],
  },
  stop_looping: {
    verdict: 'stop',
    reason: 'It keeps repeating itself after it was already nudged about it.',
  },
  leave_waiting: { verdict: 'leave', reason: 'It is waiting on something real, and the wait is still reasonable.' },
  nudge_wait: {
    verdict: 'nudge',
    reason: 'It is waiting on something real, and has waited longer than is reasonable.',
    messages: ['stuck_command', 'wait_overdue', 'peer_gone', 'poll_loop'],
  },
  dialog_owner: {
    verdict: 'nudge',
    reason: 'A prompt or dialog is open on its screen: answer it, or nudge it to.',
    ownerOnly: true,
  },
  restart_stuck: {
    verdict: 'restart',
    reason: 'Its program is running but silent, waiting on nothing, with no dialog on screen.',
  },
};

// ── The facts ────────────────────────────────────────────────────────────────────────────────────

/** Every fact the tree needs, answered by the daemon. */
export interface JevFacts {
  readonly running: boolean;
  readonly quota_or_provider: boolean;
  readonly output_changed: boolean;
  readonly already_nudged: boolean;
  readonly dialog_on_screen: boolean;
  /** On the quota branch: the quota reset has passed, so the ferret resumes rather than moves. */
  readonly quotaResetPassed: boolean;
}

/** What the daemon reads the facts from: what the sweep already holds about the flagged ferret. */
export interface JevFactsInput {
  readonly anomaly: Pick<WardenAnomaly, 'kind' | 'sessionId' | 'provider' | 'ledger'>;
  readonly view: Pick<WardenSessionView, 'state' | 'hasLiveMonitor'>;
  /** The Warden's recent actions (`state.actions`). */
  readonly actions: readonly Pick<WardenAction, 'at' | 'sessionId' | 'action' | 'outcome' | 'anomalyKind'>[];
  /** How recent output must be to count as "changed lately": the sus-thinking window. */
  readonly windowMs: number;
  readonly nowMs: number;
}

/** A turn the harness itself cut off: the program sits at the prompt, but its work is not running. */
const NOT_WORKING = new Set(['interrupted', 'rate_limited']);

/** How far back a nudge still counts as "already nudged about this". */
export const ALREADY_NUDGED_WINDOW_MS = 24 * 60 * 60_000;

/**
 * The facts, each from one thing the daemon already observes:
 *
 * - `running`: the daemon holds a live monitor on the ferret's pane, and its status is neither
 *   terminal nor a turn the harness cut off (`interrupted`, `rate_limited`);
 * - `quota_or_provider`: `rate_limited`, a recorded quota reset, a quota-reset or provider flag, or a
 *   flag that names the provider;
 * - `output_changed`: the transcript, the token counter or the meaningful pane moved within the window;
 * - `already_nudged`: a nudge that took — by Jev or an investigation — on this ferret for this kind of
 *   flag within a day (`state.actions`);
 * - `dialog_on_screen`: the ferret is parked on a question or permission prompt (`needs-input`, or an
 *   `awaiting_*` status).
 */
export function jevFactsOf(input: JevFactsInput): JevFacts {
  const { anomaly, view, nowMs } = input;
  const state = view.state;
  const resetAt = state.quota?.resetAt;
  const ledger = anomaly.ledger;
  const latestOutput = latestInstantMs(
    ledger?.lastTranscriptAt ?? state.lastTranscriptAt,
    ledger?.lastTokenAdvanceAt ?? state.lastTokenAdvanceAt,
    ledger?.lastMeaningfulPaneAt ?? state.lastMeaningfulPaneAt,
  );
  const alreadyNudged = input.actions.some(action => {
    const at = instantMs(action.at);
    return (
      action.sessionId === anomaly.sessionId &&
      action.action === 'nudge' &&
      action.outcome === 'done' &&
      action.anomalyKind === anomaly.kind &&
      at !== undefined &&
      nowMs - at < ALREADY_NUDGED_WINDOW_MS
    );
  });
  return {
    running: view.hasLiveMonitor && !isTerminalStatus(state.status) && !NOT_WORKING.has(state.status),
    quota_or_provider:
      state.status === 'rate_limited' ||
      resetAt !== undefined ||
      anomaly.kind === 'quota_reset_passed' ||
      anomaly.kind === 'provider_unavailable' ||
      anomaly.provider !== undefined,
    output_changed: latestOutput !== undefined && nowMs - latestOutput <= input.windowMs,
    already_nudged: alreadyNudged,
    dialog_on_screen:
      state.turnState === 'needs-input' || state.status === 'awaiting_question' || state.status === 'awaiting_user',
    quotaResetPassed: anomaly.kind === 'quota_reset_passed' || (resetAt !== undefined && resetAt <= nowMs),
  };
}

/** The facts as the scalars Jev is shown beside its question, so "waiting on something real" is judged on them. */
export function jevFactScalars(
  facts: JevFacts,
  view: Pick<WardenSessionView, 'state' | 'hasDoneMarker'>,
  nowMs: number,
): Readonly<Record<string, string | number | boolean>> {
  const state = view.state;
  const subprocessSince = instantMs(state.subprocessSince);
  const waitUntil = instantMs(state.waiting?.until);
  return {
    programRunning: facts.running,
    outputChangedLately: facts.output_changed,
    outOfQuotaOrProviderDown: facts.quota_or_provider,
    dialogOnScreen: facts.dialog_on_screen,
    alreadyNudged: facts.already_nudged,
    ...(view.hasDoneMarker === undefined ? {} : { declaredDone: view.hasDoneMarker }),
    ...(state.turnState === undefined ? {} : { turnState: state.turnState }),
    ...(subprocessSince === undefined
      ? {}
      : { subprocessRunningMinutes: Math.max(0, Math.floor((nowMs - subprocessSince) / 60_000)) }),
    ...(state.waiting === undefined ? {} : { declaredWait: true }),
    ...(state.waiting?.condition === undefined ? {} : { waitCondition: state.waiting.condition }),
    ...(waitUntil === undefined ? {} : { waitOverdue: waitUntil < nowMs }),
    ...(state.waiting?.peerName === undefined ? {} : { waitingOnPeer: state.waiting.peerName }),
  };
}

// ── Walking it ───────────────────────────────────────────────────────────────────────────────────

type Target = JevNode | { readonly leaf: JevLeaf };

const isLeaf = (target: Target): target is { readonly leaf: JevLeaf } => typeof target !== 'string';

/** What Jev must be asked for these facts: the judgement nodes left open, and the nudge messages that fit. */
export interface JevQuestionPlan {
  readonly judgements: readonly JevJudgementNode[];
  /** The messages of the one nudge leaf the open branches can reach, when that nudge may be sent. */
  readonly nudgeMessages?: readonly NudgeMessageId[];
}

/**
 * The questions to put to Jev: every judgement node reachable once the facts are answered — following a
 * fact's one branch, and BOTH branches of a judgement — and the nudge messages of a reachable nudge leaf.
 * Fact nodes are never in it. Deterministic, in tree order.
 */
export function reachableJudgements(facts: JevFacts): JevQuestionPlan {
  const judgements: JevJudgementNode[] = [];
  const messages: NudgeMessageId[] = [];
  const visit = (target: Target): void => {
    if (isLeaf(target)) {
      const spec = target.leaf === 'quota_or_provider' ? undefined : LEAF[target.leaf];
      if (spec?.messages !== undefined && spec.ownerOnly !== true)
        for (const id of spec.messages) if (!messages.includes(id)) messages.push(id);
      return;
    }
    const branch = JEV_TREE[target];
    if (isJevFactNode(target)) {
      visit(facts[target] ? branch.yes : branch.no);
      return;
    }
    if (!judgements.includes(target)) judgements.push(target);
    visit(branch.yes);
    visit(branch.no);
  };
  visit(JEV_TREE_ROOT);
  return { judgements, ...(messages.length === 0 ? {} : { nudgeMessages: messages }) };
}

/** The walk of one flag: the path taken and the leaf it reached. */
export interface JevWalk {
  readonly path: readonly WardenJevPathStep[];
  readonly leaf: JevLeaf;
  /** The act the leaf asks for. */
  readonly verdict: 'leave' | TriageActVerdict;
  readonly reason: string;
  readonly ownerOnly: boolean;
}

/**
 * Walk the tree: facts from the daemon, judgements from Jev's answers. `undefined` when an answer the
 * path needs is missing — the reply did not answer a question it was asked, so nothing is decided.
 */
export function walkJevTree(
  facts: JevFacts,
  answers: Readonly<Partial<Record<JevJudgementNode, JevYesNo>>>,
): JevWalk | undefined {
  const path: WardenJevPathStep[] = [];
  let target: Target = JEV_TREE_ROOT;
  while (!isLeaf(target)) {
    const node: JevNode = target;
    const branch: JevBranch = JEV_TREE[node];
    if (isJevFactNode(node)) {
      const yes: boolean = facts[node];
      path.push({ node, kind: 'fact', answer: yes ? 'yes' : 'no' });
      target = yes ? branch.yes : branch.no;
      continue;
    }
    const answer = answers[node];
    if (answer === undefined) return undefined;
    path.push({ node, kind: 'judgement', answer: answer.answer, confidence: answer.confidence });
    target = answer.answer === 'yes' ? branch.yes : branch.no;
  }
  const leaf = target.leaf;
  if (leaf === 'quota_or_provider') {
    const verdict = facts.quotaResetPassed ? 'resume' : 'failover';
    return {
      path,
      leaf,
      verdict,
      reason:
        verdict === 'resume'
          ? 'It stopped on its quota and the reset has passed; resume it.'
          : 'It cannot go on with its current login: out of quota or its provider is down.',
      ownerOnly: false,
    };
  }
  const spec = LEAF[leaf];
  return { path, leaf, verdict: spec.verdict, reason: spec.reason, ownerOnly: spec.ownerOnly === true };
}

/** What the tree means for one flag: the first responder's outcome, and the path that led there. */
export interface JevTreeResponse {
  readonly outcome: WardenGuardOutcome;
  /** The walk's path; absent when no answer came back to walk with. */
  readonly path?: readonly WardenJevPathStep[];
  /** The leaf reached. */
  readonly leaf?: JevLeaf;
  /**
   * `not_sure_enough`: the first Jev answer on the path below the bar — the question the owner is asked.
   */
  readonly node?: JevJudgementNode;
  /** The tree's answer as one decision, for the counters and the records that take one. */
  readonly decision: TriageDecision;
}

/** The bar every Jev answer on a path to this verdict must meet: the act's, or the leave bar for leave and never-alone. */
function barFor(verdict: 'leave' | TriageActVerdict, ownerOnly: boolean, policy: JevResponderPolicy): number {
  if (verdict === 'leave' || verdict === 'failover' || ownerOnly) return policy.leaveThreshold;
  const bar = policy.acts[verdict];
  return bar >= 1 ? policy.leaveThreshold : bar;
}

/**
 * The first responder's decision table for the tree. Total and pure.
 *
 * A failure is `failed`, as before. A reply that did not answer a question the path needs is
 * `malformed`. Otherwise the walk's leaf is judged: the FIRST Jev answer on the path below the leaf's
 * bar escalates `not_sure_enough`, naming that node; when every answer clears it, the leaf goes through
 * {@link firstResponse} with the weakest answer's confidence, so the offered acts, the owner's bars,
 * `mayActAlone`, never-alone and the nudge message are all still checked there. The dialog leaf is the
 * owner's: sure enough, it is a recommendation (`never_alone`), never an act.
 */
export function treeResponse(facts: JevFacts, judgement: JevJudgement, policy: JevResponderPolicy): JevTreeResponse {
  const base = {
    model: judgement.model,
    inputTokens: judgement.inputTokens,
    latencyMs: judgement.latencyMs,
    ...(judgement.costUsd === undefined ? {} : { costUsd: judgement.costUsd }),
  };
  const failed = (failure: NonNullable<TriageDecision['failure']>): JevTreeResponse => {
    const decision: TriageDecision = { ...base, verdict: 'unsure', confidence: 0, failure };
    return { decision, outcome: firstResponse(decision, policy) };
  };
  if (judgement.failure !== undefined) return failed(judgement.failure);
  const walk = walkJevTree(facts, judgement.answers);
  if (walk === undefined) return failed({ code: 'malformed' });

  const judged = walk.path.filter(step => step.kind === 'judgement');
  const confidence = Math.min(1, ...judged.map(step => step.confidence ?? 0));
  const decision: TriageDecision = {
    ...base,
    verdict: walk.verdict,
    confidence,
    reason: walk.reason,
    ...(walk.verdict === 'nudge' && !walk.ownerOnly && judgement.nudge !== undefined ? { nudge: judgement.nudge } : {}),
  };
  const traced = { path: walk.path, leaf: walk.leaf, decision };
  const bar = barFor(walk.verdict, walk.ownerOnly, policy);
  const weak = judged.find(step => (step.confidence ?? 0) < bar);
  if (weak !== undefined)
    return {
      ...traced,
      node: weak.node as JevJudgementNode,
      outcome: { kind: 'escalate', why: 'not_sure_enough', confidence: weak.confidence ?? 0, reason: walk.reason },
    };
  if (walk.ownerOnly) {
    if (walk.verdict !== 'leave' && !policy.offered.includes(walk.verdict))
      return {
        ...traced,
        outcome: { kind: 'escalate', why: 'not_offered', confidence, reason: walk.reason },
      };
    return {
      ...traced,
      outcome: {
        kind: 'escalate',
        why: 'never_alone',
        confidence,
        reason: walk.reason,
        ...(walk.verdict === 'leave' ? {} : { recommends: walk.verdict }),
      },
    };
  }
  return { ...traced, outcome: firstResponse(decision, policy) };
}

/** The path as one line the owner reads: "Running: yes → Output changed lately: no → … (62%)". */
export function jevPathLine(path: readonly WardenJevPathStep[]): string {
  return path
    .map(step => {
      const question = (jevNodeQuestion(step.node) ?? step.node).replace(/\?$/u, '');
      const sure = step.confidence === undefined ? '' : ` (${Math.round(step.confidence * 100)}% sure)`;
      return `${question}: ${step.answer}${step.kind === 'fact' ? '' : sure}`;
    })
    .join(' → ');
}

/** The facts on a path, as plain sentences: what the daemon saw for itself. */
export function jevPathFacts(path: readonly WardenJevPathStep[]): string {
  const facts = path.filter(step => step.kind === 'fact');
  return facts
    .map(step => `${(jevNodeQuestion(step.node) ?? step.node).replace(/\?$/u, '')}: ${step.answer}`)
    .join('; ');
}

/** The reason a leaf records, in the words the owner reads. */
export function jevLeafReason(leaf: Exclude<JevLeaf, 'quota_or_provider'>): string {
  return LEAF[leaf].reason;
}
