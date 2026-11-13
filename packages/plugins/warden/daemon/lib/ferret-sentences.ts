/**
 * The only words a FERRET is ever given about a Warden finding: one fixed plain sentence per classification.
 *
 * Why this module exists. A Warden report is LLM-written text, and proving whose subject a sentence of it is about cannot
 * be done reliably (a name, an amount, a cause can each refer to another ferret). So nothing a model wrote reaches a
 * ferret, in any form: not the report, not a verdict's reason or recommendation, not an escalation's why or remedy, not
 * the nudge or stop reason typed into its own session. What a ferret learns is a validated classification (an enum:
 * the anomaly kind, the verdict kind, the action and its outcome), the target id the caller's lineage owns and times, and
 * the sentence here for that classification. The owner and a paired device read everything, as before.
 *
 * Every table is a TOTAL record over its enum, so a classification added later without a sentence is a compile error
 * rather than a silent hole. Pure: no inputs but the classification.
 */
import { FERRET_NOTICE_SENTENCES } from '@ferretry/core-asks/contract';
import type { WardenActionKindSchema, WardenAnomalyKindSchema, WardenVerdictKindSchema } from '../../contract/index.ts';
import type { z } from 'zod';

type AnomalyKind = z.infer<typeof WardenAnomalyKindSchema>;
type VerdictKind = z.infer<typeof WardenVerdictKindSchema>;
type ActionKind = z.infer<typeof WardenActionKindSchema>;
type Outcome = 'done' | 'held' | 'failed';

/** What each flag class means, as a clause that follows "the Warden flagged this ferret:". */
const ANOMALY_CLAUSE: Readonly<Record<AnomalyKind, string>> = {
  dead_monitor: 'nothing is watching its pane',
  unattended_question: 'it asked a question and nobody has answered',
  abandoned_wreckage: 'it left work or processes behind',
  quota_reset_passed: 'its login quota has reset and it is still waiting',
  declared_wait_overdue: 'a wait it declared has run past its time',
  peer_wait_unanswerable: 'it is waiting on a peer that cannot answer',
  sus_thinking: 'it has been thinking for an unusually long time',
  sus_subprocess: 'a process it started has run for an unusually long time',
  agent_frozen: 'it stopped making progress',
  bootstrap_degraded: 'it started in a degraded state',
  provider_unavailable: 'its model provider could not be reached',
  owner_request: 'the owner asked for a look at it',
  orphaned_card: 'a card is left with no ferret on it',
  report_overdue: 'a report asked of it is overdue',
  input_stuck: 'a message typed to it was not sent',
  inbox_stuck: 'a message queued for it has not been delivered',
};

/** What the Warden concluded, as a sentence about this ferret. */
const VERDICT_SENTENCE: Readonly<Record<VerdictKind, string>> = {
  killed: 'The Warden judged that this ferret should be stopped.',
  revived: 'The Warden judged that this ferret should be started again.',
  nudged: 'The Warden judged that this ferret needed a nudge.',
  cleared: 'The Warden looked at this ferret and found it healthy.',
  needs_human: 'The Warden judged that this needs the owner.',
  unknown: 'The Warden looked at this ferret and reached no verdict that can be shown here.',
};

const ACTION_DID: Readonly<Record<ActionKind, string>> = {
  bless: 'left this ferret alone',
  nudge: 'nudged this ferret',
  resume: 'resumed this ferret',
  restart: 'restarted this ferret',
  stop: 'stopped this ferret',
  failover: 'moved this ferret to another login',
  close_leftover: 'closed what this ferret left running',
  revive: 'started this ferret again',
};

const ACTION_ASKS: Readonly<Record<ActionKind, string>> = {
  bless: 'leave this ferret alone',
  nudge: 'nudge this ferret',
  resume: 'resume this ferret',
  restart: 'restart this ferret',
  stop: 'stop this ferret',
  failover: 'move this ferret to another login',
  close_leftover: 'close what this ferret left running',
  revive: 'start this ferret again',
};

const WHY_PRIVATE = 'The Warden’s reasons are the owner’s to read.';

/** The flag class as one sentence. */
export const anomalySentence = (kind: AnomalyKind): string =>
  `The Warden flagged this ferret: ${ANOMALY_CLAUSE[kind]}.`;

/** The flag class as words that fit after "you" (`you are flagged for …`): used where a sentence is typed to the ferret. */
const anomalyClause = (kind: AnomalyKind | undefined): string =>
  kind === undefined ? 'a flag on your work' : ANOMALY_CLAUSE[kind];

/** What a verdict row reads as, in place of the model's reason. */
export const verdictSentence = (verdict: VerdictKind): string => VERDICT_SENTENCE[verdict];

/** What an action row reads as, in place of the detail the Warden or Jev wrote. */
export const actionSentence = (action: ActionKind, outcome: Outcome): string =>
  outcome === 'done'
    ? `The Warden ${ACTION_DID[action]}. ${WHY_PRIVATE}`
    : outcome === 'held'
      ? `The Warden asked the owner to ${ACTION_ASKS[action]}, and it waits for them. ${WHY_PRIVATE}`
      : `The Warden tried to ${ACTION_ASKS[action]} and it did not take. ${WHY_PRIVATE}`;

/** An agenda item's three sentences (what is flagged, why it is on the list, what happens next), by flag class. */
export function escalationSentences(kind: AnomalyKind | undefined): {
  readonly subject: string;
  readonly why: string;
  readonly howToResolve: string;
} {
  return {
    // The no-class case and the two shared sentences are the contract's: Asks says the same ones when a ferret reads a
    // Warden notice off a board.
    subject: kind === undefined ? FERRET_NOTICE_SENTENCES.subject : anomalySentence(kind),
    why: FERRET_NOTICE_SENTENCES.why,
    howToResolve: FERRET_NOTICE_SENTENCES.howToResolve,
  };
}

// ─── what is typed into the ferret's own session ──────────────────────────────────────────────────────────────────

/** The nudge typed into a ferret for an investigation's verdict: the flag class, no model-written reason. */
export const wardenFixedNudge = (kind: AnomalyKind | undefined): string =>
  `The Warden checked on you (${anomalyClause(kind)}). If you are blocked, say exactly what you need; otherwise carry on and post a short status.`;

/** The reason a verdict-driven stop leaves, in place of the model's. */
export const wardenFixedStopReason = (kind: AnomalyKind | undefined): string =>
  `Warden verdict (${anomalyClause(kind)})`;

/** The reason a verdict-driven resume or restart hands the ferret, in place of the model's. */
export const wardenFixedResumeReason = (kind: AnomalyKind | undefined): string => anomalyClause(kind);
