import { ferretryNotice, type SendEvidence } from '@ferretry/protocol';
import type { ObservedHumanInput } from '../../transcript/types.ts';
import type { SendRecord, SendSenderKind } from './types.ts';

/**
 * The pure half of knowing where a send went: matching ledger records against what the harness
 * transcript proves, and the deadlines by which an unproven send is looked at again.
 *
 * NOTHING HERE ASSUMES. A send is `delivered` only when a user record carrying its text appears in
 * the transcript after it was accepted; it is `queued` only when the harness wrote its own queue
 * record for it. Every other answer is "not proven yet", and the tracker decides what that means at
 * a deadline by looking at the pane as well.
 */

/** Every tunable the tracker owns, injected rather than hard-coded. */
export interface SendTrackerSettings {
  /** How soon after a transport the first look is taken — most sends are proven within a second. */
  readonly firstCheckMs: number;
  /**
   * The deadline of each attempt, measured from that attempt, by who sent it. The array's LENGTH is
   * the number of attempts the daemon makes: a person gets one automatic re-attempt and then a Retry
   * button; an agent has nobody to press one, so the daemon tries harder but briefly — re-attempts at
   * ~15 s, ~30 s and ~60 s after the send, the whole window about a minute; a daemon notice gets one.
   */
  readonly deadlinesMs: Readonly<Record<SendSenderKind, readonly number[]>>;
  /** How long a re-check is pushed out when the harness is still visibly holding the message. */
  readonly busyExtensionMs: number;
  /** The ceiling on waiting behind a busy agent, after which a held send is reported unconfirmed. */
  readonly holdLimitMs: number;
  /**
   * How long a REPAIRABLE send is still looked for — one settled unconfirmed only because its
   * transcript could not be read, or one a person cancelled — so a reading failure that has since been
   * fixed corrects the rows it wrongly settled, without a send ever being watched for good.
   */
  readonly repairLimitMs: number;
  /**
   * How long text must have sat in the composer, unsubmitted, before it is SAID to be "typed, not sent".
   * A harness takes a moment between Enter and its transcript record, and a pane read in that window
   * looks exactly like a stuck message — saying so then flips the row to delivered a second later.
   */
  readonly typedStableMs: number;
  /**
   * When the daemon presses Enter AGAIN for a pointer of its own still sitting typed in the composer,
   * measured from the attempt that typed it: one entry per extra Enter, so the LENGTH bounds them. A
   * pointer is only said to be "typed, not sent" once the last of these has had `typedStableMs` to
   * take, because until then the daemon is still finishing its own job.
   */
  readonly submitNudgesMs: readonly number[];
  /** Harness and daemon clocks disagree slightly; a proof this far before acceptance still counts. */
  readonly matchSlackMs: number;
}

export const defaultSendTrackerSettings: SendTrackerSettings = {
  firstCheckMs: 2_000,
  deadlinesMs: {
    human: [60_000, 60_000],
    agent: [15_000, 15_000, 30_000, 15_000],
    daemon: [60_000],
  },
  busyExtensionMs: 60_000,
  holdLimitMs: 2 * 60 * 60_000,
  repairLimitMs: 3 * 24 * 60 * 60_000,
  matchSlackMs: 5_000,
  typedStableMs: 4_000,
  submitNudgesMs: [4_000, 12_000, 30_000],
};

/** Fates still being looked for. */
export function isOpenSend(record: SendRecord): boolean {
  return (record.fate === 'accepted' || record.fate === 'queued') && record.held !== true;
}

/**
 * A settled send the transcript may still prove delivered: one unconfirmed only because the
 * transcript could not be read, or one a person cancelled — usually while it read as unconfirmed.
 */
export function isRepairableSend(record: SendRecord): boolean {
  return (
    record.fate === 'cancelled' ||
    (record.fate === 'unaccounted' && record.unaccountedReason === 'transcript_unreadable')
  );
}

/**
 * Judges every watched send, CANCELLED ONES LAST AND ONLY BY WHAT CAME BEFORE THE CANCEL.
 *
 * A cancelled send is proven delivered only by a record written before the person cancelled it —
 * then the cancel came too late, and the agent had it. A record written after is somebody's NEXT
 * message, and judging the cancelled send first would let it take that record from the live send
 * that is actually waiting for it.
 */
export function judgeWatchedSends(
  watched: readonly SendRecord[],
  claimed: ReadonlySet<string>,
  inputs: readonly ObservedHumanInput[],
  slackMs: number,
): ReadonlyMap<string, SendVerdict> {
  const live = watched.filter(record => record.fate !== 'cancelled');
  const verdicts = new Map(judgeSends(live, claimed, inputs, slackMs));
  const taken = new Set([
    ...claimed,
    ...[...verdicts.values()].flatMap(verdict => (verdict.delivered === undefined ? [] : [verdict.delivered.key])),
  ]);
  const cancelled = watched
    .filter(record => record.fate === 'cancelled')
    .sort((left, right) => Date.parse(left.acceptedAt) - Date.parse(right.acceptedAt));
  for (const record of cancelled) {
    const cancelledAt = Date.parse(record.fateAt ?? record.acceptedAt) + slackMs;
    const before = inputs.filter(input => Date.parse(input.observedAt) <= cancelledAt);
    const verdict = judgeSends([record], taken, before, slackMs).get(record.sendId);
    if (verdict?.delivered === undefined) continue;
    taken.add(verdict.delivered.key);
    verdicts.set(record.sendId, verdict);
  }
  return verdicts;
}

/** The attempts the daemon makes for this sender before settling the send. */
export function attemptsAllowed(record: SendRecord, settings: SendTrackerSettings): number {
  return settings.deadlinesMs[record.senderKind ?? 'human'].length;
}

/** The instant this send is next looked at, in epoch milliseconds. */
export function deadlineOf(record: SendRecord, settings: SendTrackerSettings): number {
  if (record.deadlineAt !== undefined) return Date.parse(record.deadlineAt);
  const schedule = settings.deadlinesMs[record.senderKind ?? 'human'];
  const attempt = Math.max(1, record.attempt ?? 1);
  const index = Math.min(attempt, schedule.length) - 1;
  return Date.parse(record.attemptAt ?? record.acceptedAt) + (schedule[index] as number);
}

/** What the transcript proves about one open send. */
export interface SendVerdict {
  /** The user record that proves it entered the conversation. */
  readonly delivered?: SendEvidence;
  /** When the harness first recorded holding it in its own queue. */
  readonly queuedAt?: string;
  /** The harness's last word on its queue entry for this text was "holding". */
  readonly holding: boolean;
  /** The harness held it and then let go of it, and no user record followed. */
  readonly released: boolean;
}

/** Whitespace-insensitive, case-sensitive: a soft-wrapped composer is not a different message. */
function normalized(text: string): string {
  return text.normalize('NFC').replace(/\s+/gu, ' ').trim();
}

/** Text shorter than this is matched exactly only: "ok" inside a longer record proves nothing. */
const CONTAINED_MATCH_MIN = 12;

function carries(observed: string, needle: string): boolean {
  if (observed === needle) return true;
  return needle.length >= CONTAINED_MATCH_MIN && observed.includes(needle);
}

const ENTERED = new Set(['normal-user-record', 'native-queue-drain']);

function tierOf(record: SendRecord): SendEvidence['tier'] {
  if (record.path === 'turn-file') return 'turn-instruction';
  if (record.path === 'native-file') return 'queue-file-id';
  return 'exact-text';
}

function kindOf(input: ObservedHumanInput): SendEvidence['kind'] {
  if (input.harness === 'codex') return 'response_item';
  return input.proof === 'native-queue-drain' ? 'queued_command' : 'chat.user';
}

/**
 * Judges every watched send against one reading of the transcript, ONE-TO-ONE.
 *
 * Sends are taken oldest first and each takes the EARLIEST unclaimed user record that carries its
 * text and was written no earlier than its acceptance, so five identical "continue"s are proven by
 * five records, in order, and an older identical message can never prove a newer send. A record a
 * delivered send already cites (`claimed`) is never offered again.
 */
export function judgeSends(
  watched: readonly SendRecord[],
  claimed: ReadonlySet<string>,
  inputs: readonly ObservedHumanInput[],
  slackMs: number,
): ReadonlyMap<string, SendVerdict> {
  const taken = new Set(claimed);
  const verdicts = new Map<string, SendVerdict>();
  const ordered = [...watched].sort((left, right) => Date.parse(left.acceptedAt) - Date.parse(right.acceptedAt));
  for (const record of ordered) {
    const needle = normalized(record.matchText ?? record.message);
    const since = Date.parse(record.acceptedAt) - slackMs;
    const after = (input: ObservedHumanInput): boolean => Date.parse(input.observedAt) >= since;
    const entered = inputs.find(
      input =>
        ENTERED.has(input.proof) &&
        !taken.has(input.proofKey) &&
        after(input) &&
        carries(normalized(input.text), needle),
    );
    const queue = inputs.filter(
      input => !ENTERED.has(input.proof) && after(input) && normalized(input.text) === needle,
    );
    const firstHold = queue.find(input => input.proof === 'native-queue-hold');
    const last = queue.at(-1);
    const holding = last?.proof === 'native-queue-hold';
    if (entered !== undefined) taken.add(entered.proofKey);
    verdicts.set(record.sendId, {
      ...(entered === undefined ? {} : { delivered: evidenceOf(entered, record, tierOf(record)) }),
      ...(firstHold === undefined ? {} : { queuedAt: firstHold.observedAt }),
      holding,
      released: firstHold !== undefined && !holding,
    });
  }
  judgeMerged(ordered, verdicts, taken, inputs, slackMs);
  return verdicts;
}

function evidenceOf(entered: ObservedHumanInput, record: SendRecord, tier: SendEvidence['tier']): SendEvidence {
  return {
    key: entered.proofKey,
    harness: entered.harness,
    kind: kindOf(entered),
    proof: entered.proof as SendEvidence['proof'],
    observedAt: entered.observedAt,
    ...(entered.originatedAt === undefined ? {} : { originatedAt: entered.originatedAt }),
    shapeVersion: entered.shapeVersion,
    matchedTurn: record.turn ?? record.acceptedTurn,
    tier,
  };
}

function squeezed(text: string): string {
  return text.normalize('NFC').replace(/\s+/gu, '');
}

/**
 * Proves sends that reached the conversation JOINED into one user record.
 *
 * A TUI submits whatever its composer holds, so a message typed onto one left sitting there unsent is
 * submitted with it as a single message — `hi` and `hello` arrived as `hihello`. No per-send match
 * can find either, and both rows then waited for proof that already existed. A record is offered here
 * only when it is EXACTLY two or more still-unproven sends, consecutive in acceptance order, written
 * after the first of them was accepted — never a looser containment, which would let one message
 * prove another.
 */
function judgeMerged(
  ordered: readonly SendRecord[],
  verdicts: Map<string, SendVerdict>,
  taken: Set<string>,
  inputs: readonly ObservedHumanInput[],
  slackMs: number,
): void {
  const pending = ordered.filter(record => verdicts.get(record.sendId)?.delivered === undefined);
  for (const input of inputs) {
    if (!ENTERED.has(input.proof) || taken.has(input.proofKey)) continue;
    const target = squeezed(input.text);
    const run = mergedRun(pending, target, Date.parse(input.observedAt), slackMs);
    if (run === undefined) continue;
    taken.add(input.proofKey);
    for (const record of run) {
      const verdict = verdicts.get(record.sendId) as SendVerdict;
      verdicts.set(record.sendId, { ...verdict, delivered: evidenceOf(input, record, 'merged-text') });
      pending.splice(pending.indexOf(record), 1);
    }
  }
}

function mergedRun(
  pending: readonly SendRecord[],
  target: string,
  observedAt: number,
  slackMs: number,
): readonly SendRecord[] | undefined {
  for (let start = 0; start < pending.length; start += 1) {
    let joined = '';
    for (let end = start; end < pending.length; end += 1) {
      const record = pending[end] as SendRecord;
      // Every part must have been accepted before the record that carries it was written.
      if (observedAt < Date.parse(record.acceptedAt) - slackMs) break;
      joined += squeezed(record.matchText ?? record.message);
      if (!target.startsWith(joined)) break;
      if (joined === target && end > start) return pending.slice(start, end + 1);
    }
  }
  return undefined;
}

/**
 * The note handed back to an agent whose message did not arrive.
 *
 * An agent has nobody watching a Retry button, so the daemon tells it directly — in its own session —
 * and leaves the decision with it: resend, choose another route, or give up.
 */
export function sendFailureNotice(recipient: string, record: SendRecord, clientName: string): string {
  // Its own sentence, because the generic one is wrong twice over here: the keys DID reach the
  // recipient's terminal, and "decide whether to send it again" invites the duplicate. What is
  // missing is the proof, and only a restart of the recipient can supply it.
  if (record.fate === 'unaccounted' && record.unaccountedReason === 'transcript_unbound')
    return ferretryNotice(
      `Your message to ${recipient} (send ${record.sendId}) was typed into ${recipient}’s terminal, but there is ` +
        `no transcript Ferretry can prove is ${recipient}’s, so whether ${recipient} read it cannot be confirmed. ` +
        `Do not send it again — it most likely arrived. Ask the owner to restart ${recipient}’s CLI, which gives ` +
        'it a transcript Ferretry can read.',
    );
  const resend = `Decide whether to send it again with \`${clientName} send ${recipient} …\`.`;
  // An unconfirmed message is not one that "did not reach it": it may be sitting in the recipient's
  // queue right now, and a sender told otherwise sends the copy the daemon itself refused to type.
  if (record.fate !== 'timed_out')
    return ferretryNotice(
      `Your message to ${recipient} (send ${record.sendId}) could not be confirmed ` +
        `(${(record.unaccountedReason ?? 'timeout').replaceAll('_', ' ')}) — it may still have landed, ` +
        `so sending it again may deliver it twice. ${resend}`,
    );
  return ferretryNotice(
    `Your message to ${recipient} (send ${record.sendId}) did not reach it: it was not delivered ` +
      `(${(record.unaccountedReason ?? 'not_delivered').replaceAll('_', ' ')}) after ${record.attempt ?? 1} attempt(s). ` +
      resend,
  );
}
