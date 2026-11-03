import {
  PEER_MESSAGE_LABELS,
  type PeerMessageLabel,
  PeerMessageLabelSchema,
  type QueueWaitReason,
  type SendDisposition,
  type SendRecord,
  type SendResult,
} from '@ferretry/protocol';
import { SessionCommandError } from './errors.ts';
import type { SessionEnvironment } from './ports.ts';

/** The `send` flags, already parsed out of argv by the composition root. */
export interface SendFlags {
  /** The message typed as arguments. */
  readonly message?: string;
  /** Text already read from `--message-file`, appended after the typed message. */
  readonly fileMessage?: string;
  readonly attachmentPaths?: readonly string[];
  readonly now?: boolean;
  readonly ask?: boolean;
  /** Mark it as wanting an answer without parking the sender (`--ask` does both). */
  readonly expectReply?: boolean;
  readonly until?: string;
  /** `--kind`, as typed: `blocker`, `action` or `fyi`. Parsed here, so an unknown word never reaches the wire. */
  readonly kind?: string;
}

export interface SendPlan {
  readonly message: string;
  readonly attachmentPaths: readonly string[];
  readonly now: boolean;
  readonly replyExpected: boolean;
  /** How soon the receiver is to get it; the daemon only holds a ferret's message for a label it can combine. */
  readonly label: PeerMessageLabel;
  /** Set when the caller asked to be parked: the session id to park and the deadline, if any. */
  readonly park?: { readonly callerSessionId: string; readonly until?: string };
}

/**
 * Validates and composes a send before anything is uploaded or sent.
 *
 * The order matters: the source uploaded every attachment first and only then discovered that
 * `--ask` was illegal outside a session, leaving orphaned uploads attached to a message it never
 * sent. Everything checkable is checked here, before the first upload.
 */
export function planSend(flags: SendFlags, environment: SessionEnvironment): SendPlan {
  const message = [flags.message?.trim() ?? '', flags.fileMessage?.trim() ?? '']
    .filter(part => part !== '')
    .join('\n\n');
  const attachmentPaths = [...(flags.attachmentPaths ?? [])];
  // The wire contract requires a message: an attachment with no words is a file the agent was never
  // told what to do with.
  if (message === '')
    throw new SessionCommandError('provide a message (arguments and/or --message-file) to send with the attachments');

  const caller = environment.callerSessionId?.trim();
  if (flags.ask === true && (caller === undefined || caller === ''))
    throw new SessionCommandError(
      '--ask parks the calling session, so it only works from inside a session (FY_SESSION_ID is unset)',
    );
  if (flags.until !== undefined && flags.ask !== true) throw new SessionCommandError('--until applies to `send --ask`');
  const label = planLabel(flags);

  return {
    message,
    attachmentPaths,
    now: flags.now === true,
    replyExpected: flags.ask === true || flags.expectReply === true,
    label,
    ...(flags.ask === true && caller !== undefined && caller !== ''
      ? { park: { callerSessionId: caller, ...(flags.until === undefined ? {} : { until: flags.until }) } }
      : {}),
  };
}

/**
 * The label a send carries. A question (`--ask`, `--expect-reply`) or an interrupt is a blocker by nature
 * (it is delivered at once, whatever `--kind` says), so those flags set it; the one thing they cannot be is an FYI, which is held for the receiver's next turn end.
 */
function planLabel(flags: SendFlags): PeerMessageLabel {
  const parsed = flags.kind === undefined ? undefined : PeerMessageLabelSchema.safeParse(flags.kind.trim());
  if (parsed !== undefined && !parsed.success)
    throw new SessionCommandError(`--kind must be one of ${PEER_MESSAGE_LABELS.join(' | ')} (got "${flags.kind}")`);
  const asked = parsed?.data;
  const urgent = flags.ask === true || flags.expectReply === true || flags.now === true;
  if (asked === 'fyi' && urgent)
    throw new SessionCommandError(
      'a question is never an FYI: --kind fyi cannot be combined with --ask, --expect-reply or --now',
    );
  return urgent ? 'blocker' : (asked ?? 'action');
}

const DISPOSITION_NOTES: Readonly<Record<SendDisposition, string>> = {
  delivered: 'delivered',
  queued: "queued in the agent's own queue (it auto-submits at the turn boundary)",
  sent: "typed into the busy agent's prompt; not yet proven queued — the daemon is watching where it lands",
  revived: 'revived the session with the message',
  'queued-for-revive': 'queued durably in the session inbox; an explicit resume remains available',
};

/** What actually happened to the message, as the daemon reported it. */
export function describeDisposition(disposition: SendDisposition): string {
  return DISPOSITION_NOTES[disposition];
}

/** Why a message is still in Ferretry's own queue, in the words a sender can act on. */
const WAIT_REASON_NOTES: Readonly<Record<QueueWaitReason, string>> = {
  launching: 'the agent is still starting',
  busy: 'the agent is busy',
  question: 'the agent is asking a question that must be answered first',
  dialog: 'a dialog is open on its screen',
  draft: 'its input box holds unsent text',
  unreadable: 'its screen cannot be read',
  stopped: 'it is not running',
};

/**
 * Whether the answer says the message is still in FERRETRY's queue: accepted there, never typed. A
 * `queued` disposition with a fate of `accepted` is exactly that — a message the agent's own queue holds
 * has the fate `queued` — and an older daemon that sends no wait reason says it the same way.
 */
export function waitingInFerretryQueue(
  result: Pick<SendResult, 'disposition' | 'fate' | 'waitReason' | 'heldUntil'>,
): boolean {
  return (
    result.waitReason !== undefined ||
    result.heldUntil !== undefined ||
    (result.disposition === 'queued' && result.fate === 'accepted')
  );
}

/**
 * The one line a sender reads about the send it just made (B144).
 *
 * "queued in the agent's own queue (it auto-submits at the turn boundary)" was printed for messages that
 * were never typed: they sat in Ferretry's queue behind an earlier send stuck unsubmitted in an idle
 * ferret's box, and the boundary never came. So a message not yet typed says so, says why, and — when
 * what it waits behind is an unconfirmed send of Ferretry's own — that a re-submit was attempted.
 */
export function describeSendResult(
  result: Pick<SendResult, 'disposition' | 'fate' | 'waitReason' | 'waitBehind' | 'label' | 'heldUntil'>,
): string {
  if (!waitingInFerretryQueue(result)) return describeDisposition(result.disposition);
  if (result.heldUntil !== undefined) return describeHold(result.label ?? 'action', result.heldUntil);
  if (result.waitBehind !== undefined)
    return (
      `NOT delivered yet: it is waiting in Ferretry's queue behind an unconfirmed earlier send (${result.waitBehind}) ` +
      "whose text sits unsubmitted in the agent's input box. Ferretry attempted a re-submit (pressed Enter) and it " +
      'did not take; the Warden flags the ferret as stuck. Do not resend — it is typed as soon as the box clears'
    );
  if (result.waitReason !== undefined)
    return (
      `NOT delivered yet: it is waiting in Ferretry's queue (not the agent's), because ${WAIT_REASON_NOTES[result.waitReason]}. ` +
      'It is typed as soon as that clears; do not resend'
    );
  return "accepted into Ferretry's queue and not typed into the agent yet; do not resend";
}

/** A time of day for a human, in their own zone: the queue's hold is minutes long, never a date. */
function clockTime(instant: string): string {
  const at = new Date(instant);
  return [at.getHours(), at.getMinutes(), at.getSeconds()].map(part => String(part).padStart(2, '0')).join(':');
}

/** A message the queue is holding on purpose, so the sender does not read the wait as a fault and resend. */
function describeHold(label: PeerMessageLabel, heldUntil: string): string {
  if (label === 'fyi')
    return (
      `held as an FYI (not typed yet): it is delivered when the agent's turn ends, or by ${clockTime(heldUntil)} at the latest, ` +
      'together with its other pending messages; do not resend'
    );
  return `held until ${clockTime(heldUntil)} to combine with other messages (${label}); not typed yet; do not resend`;
}

/** The stderr note that follows a successful park, or the refusal when no agent received it. */
export function describePark(input: { disposition: SendDisposition; peer: string; until?: string }): {
  readonly parked: boolean;
  readonly note: string;
} {
  // A park is only honest when something is running to answer it: a message merely queued for a
  // revive has no live peer, so the caller would sit blocked on a reply nobody was asked for.
  if (input.disposition === 'queued-for-revive')
    return {
      parked: false,
      note: 'the recipient was not revived, so this session was not parked — no running agent received the message',
    };
  const deadline =
    input.until === undefined ? ' (open-ended; the 4h backstop still applies)' : ` (until ${input.until})`;
  return {
    parked: true,
    note: `parked awaiting a reply from ${input.peer}${deadline} — the daemon wakes this session when the reply arrives`,
  };
}

/** The fates a `send --wait` stops at: where a send has SETTLED, one way or the other. */
export const SETTLED_SEND_FATES: ReadonlySet<SendRecord['fate']> = new Set([
  'delivered',
  'timed_out',
  'unaccounted',
  'cancelled',
]);

/** What cancelling did on the agent's screen, in words. */
const CANCEL_EFFECTS: Readonly<Record<NonNullable<SendRecord['cancelEffect']>, string>> = {
  cleared: 'it was erased from the agent’s composer',
  not_in_pane: 'it never reached the agent',
  left_in_queue: 'the agent was already holding it in its own queue and may still read it',
  left_in_composer: 'the agent’s composer held other text too, so it was left as it was',
};

/** Where a send settled, in words — and, for the two that did not land, what the sender may do. */
export function describeFate(record: SendRecord): string {
  const reason = (record.unaccountedReason ?? 'timeout').replaceAll('_', ' ');
  const attempts = record.attempt ?? 1;
  if (record.fate === 'delivered') return 'delivered — the agent’s transcript shows the message';
  if (record.fate === 'timed_out')
    return `not delivered (${reason}) after ${attempts} attempt(s); it is safe to send it again`;
  if (record.fate === 'unaccounted')
    return `unconfirmed (${reason}) — it may still have landed, so do not resend it blindly`;
  if (record.fate === 'cancelled')
    return `cancelled by a person — ${CANCEL_EFFECTS[record.cancelEffect ?? 'not_in_pane']}`;
  if (record.typedNotSent === true)
    return 'typed into the agent’s composer and not sent — press Enter on it in the ferret, or cancel it';
  return record.fate === 'queued'
    ? 'queued — the agent is holding it until its current turn ends'
    : 'accepted — not yet proven anywhere';
}
