import { type HandoffPointer, parseFerretryNotice, parseMessageAttachments } from '@ferretry/protocol';
import { markReplies } from './peer-delivery.ts';
import { isInstructionsNote } from './instructions-update.ts';
import { peerFrom } from './peer-message.ts';
import { EMPTY_SEND_VIEW, type SendViewState } from './send-dismissals.ts';
import { foldLedgerSendRecords, type LedgerSendRecord, RECORD_CLOCK_SLACK_MS } from './send-ledger.ts';
import type { SettledForm, TranscriptEntry } from './session-screens.ts';

/**
 * Where a durable send row sits relative to the transcript currently loaded, and the reading of it a
 * row must show so a reader never mistakes a boundary row for a chronological one.
 */
export type LedgerBlockPlacement = 'chronological' | 'before-loaded' | 'after-loaded' | 'unknown-time';

export const ledgerPlacementCopy = (placement: LedgerBlockPlacement): string | undefined => {
  if (placement === 'before-loaded') return 'older than the loaded transcript · shown at the history boundary';
  if (placement === 'after-loaded') return 'newer than the loaded transcript · shown at the history boundary';
  if (placement === 'unknown-time') return 'time position unavailable · shown at the loaded-history boundary';
  return undefined;
};

/** How long a send that settled without arriving keeps its row, before it retires from view. */
export const SETTLED_ROW_LIFETIME_MS = 24 * 60 * 60_000;

/**
 * How long a CANCELLED message keeps a row at all. The reader took it back themselves, so it is not news
 * for a day: a few minutes is long enough to see what the cancel did, and then it leaves. A note the
 * reader opened stays until they close it.
 */
export const CANCELLED_ROW_LIFETIME_MS = 10 * 60_000;

/**
 * How long a send that has just settled is drawn as the whole bubble — with its Retry, Copy and Dismiss —
 * before it folds to a one-line note. Long enough to read what happened, short enough that the note, not
 * the bubble, is what a conversation keeps.
 */
export const SETTLED_FRESH_MS = 10_000;

const instant = (value: string | undefined): number | undefined => {
  const at = Date.parse(value ?? '');
  return Number.isFinite(at) ? at : undefined;
};

/**
 * A TERMINAL send: one the reader took back, or that the daemon gave up on, and that nothing is still
 * trying to deliver. It is not part of the live conversation, so it never rides under it: it is placed
 * where it was SENT and drawn as a one-line note. A tombstone is not a row at all, and a send held for a
 * revive is kept deliberately (a cancelled one is terminal whatever it was held for).
 */
export const isSettledUndelivered = (record: LedgerSendRecord): boolean =>
  record.withdrawn !== true &&
  (record.fate === 'cancelled' ||
    ((record.fate === 'timed_out' || record.fate === 'unaccounted') && record.held !== true));

/** When a terminal send reached its fate: the daemon's word, else when it was sent. */
const settledSince = (record: LedgerSendRecord): number | undefined =>
  instant(record.fateAt) ?? instant(record.acceptedAt);

/**
 * Does this undelivered send still have a row? Sending and queued ones always do. One that settled keeps
 * it for a day; a cancelled one for {@link CANCELLED_ROW_LIFETIME_MS}, unless the reader opened it
 * (`expanded`).
 */
const keepsItsRow = (record: LedgerSendRecord, nowMs: number, expanded: ReadonlySet<string> = new Set()): boolean => {
  if (record.fate === 'delivered') return false;
  if (record.fate === 'accepted' || record.fate === 'queued') return true;
  if (record.fate === 'cancelled') {
    const since = settledSince(record);
    return since === undefined || expanded.has(record.sendId) || nowMs - since < CANCELLED_ROW_LIFETIME_MS;
  }
  const at = instant(record.acceptedAt);
  return at === undefined || nowMs - at < SETTLED_ROW_LIFETIME_MS;
};

/**
 * A STUCK send: one the reader can still see waiting, that nothing has proved arrived, that nobody has
 * taken back and that is not deliberately held for a revive. It is what "Clear stuck messages" takes
 * back, so the count in its question is the number of such rows on screen.
 */
export const isStuckSend = (record: LedgerSendRecord, nowMs: number = Date.now()): boolean =>
  record.withdrawn !== true && record.held !== true && record.fate !== 'cancelled' && keepsItsRow(record, nowMs);

/**
 * The terminal sends the reader can see right now — not dismissed, not yet retired — oldest first. These
 * are what "Dismiss all cancelled" and "Clear stuck messages" put away.
 */
export const visibleSettledSends = (
  records: readonly LedgerSendRecord[],
  nowMs: number,
  view: SendViewState = EMPTY_SEND_VIEW,
): LedgerSendRecord[] =>
  foldLedgerSendRecords(records)
    .filter(
      record =>
        isSettledUndelivered(record) && !view.dismissed.has(record.sendId) && keepsItsRow(record, nowMs, view.expanded),
    )
    .reverse();

/**
 * How a terminal send is drawn: the whole bubble while it is fresh, a one-line note after, and the whole
 * bubble again once the reader opened it.
 */
export const settledForm = (
  record: LedgerSendRecord,
  nowMs: number,
  expanded: ReadonlySet<string> = new Set(),
): SettledForm => {
  if (expanded.has(record.sendId)) return 'expanded';
  const since = settledSince(record);
  return since !== undefined && nowMs - since < SETTLED_FRESH_MS ? 'fresh' : 'slim';
};

/**
 * The next instant the settled rows change on their own: a fresh bubble folds to its note, or a note
 * retires. One scheduled wake-up instead of polling; `undefined` when nothing will.
 */
export const nextSettledChange = (
  records: readonly LedgerSendRecord[],
  nowMs: number,
  view: SendViewState = EMPTY_SEND_VIEW,
): number | undefined => {
  let next = Number.POSITIVE_INFINITY;
  for (const record of visibleSettledSends(records, nowMs, view)) {
    if (view.expanded.has(record.sendId)) continue;
    const since = settledSince(record);
    const sent = instant(record.acceptedAt);
    const candidates: (number | undefined)[] = [
      since === undefined ? undefined : since + SETTLED_FRESH_MS,
      record.fate === 'cancelled'
        ? since === undefined
          ? undefined
          : since + CANCELLED_ROW_LIFETIME_MS
        : sent === undefined
          ? undefined
          : sent + SETTLED_ROW_LIFETIME_MS,
    ];
    for (const at of candidates) if (at !== undefined && at > nowMs && at < next) next = at;
  }
  return Number.isFinite(next) ? next : undefined;
};

/** Whitespace-insensitive, case-sensitive: a soft-wrapped composer is not a different message. */
const norm = (value: string): string => value.normalize('NFC').replace(/\s+/gu, ' ').trim();

/** Every whitespace run removed: how the daemon compares a message the harness JOINED to its neighbours. */
const squeezed = (value: string): string => value.normalize('NFC').replace(/\s+/gu, '');

/**
 * Is this send the one a hand-off row points at? By IDENTITY, not text: the row holds only the pointer,
 * and the turn number or send id it names is the very one the daemon recorded on the send.
 */
const handedOff = (pointer: HandoffPointer, record: LedgerSendRecord): boolean =>
  pointer.kind === 'turn' ? record.turn === pointer.turn : record.sendId === pointer.sendId;

/**
 * The key a send is drawn under WHEREVER it is drawn — its own bubble after the conversation while it
 * travels, and the message it became once the transcript carries it. One key is what makes the hand-over
 * one element changing its mark rather than one bubble vanishing while another appears.
 */
export const sendRowId = (sendId: string): string => `send:${sendId}`;

/**
 * How long a DELIVERED send keeps its own bubble while the loaded transcript does not show it yet. The
 * daemon reads the transcript on its own clock, so its confirmation can reach this browser a poll before
 * the transcript read that carries the row — and without this the message vanished for that poll.
 */
export const LANDING_GRACE_MS = 30_000;

/** Still on its way. A transcript row that carries it can only be the message landing. */
const travelling = (record: LedgerSendRecord): boolean => record.fate === 'accepted' || record.fate === 'queued';

/** A send a transcript row can stand for: proved there by the daemon, or landing there right now. */
const wearable = (record: LedgerSendRecord): boolean => record.fate === 'delivered' || travelling(record);

/** The send's own words: what a person typed, or a teammate's message with its banner lifted. */
const bodyOf = (record: LedgerSendRecord): string => peerFrom(record.message).body;

/**
 * How far this row is from where the send's message was written, or `undefined` when the row cannot BE
 * that message.
 *
 * A hand-off is matched by identity, so it beats any text match. Otherwise the row must carry the send's
 * text and — whenever both times are known — have been written no earlier than the send was accepted: an
 * identical OLDER message is an earlier send, never this one, which is what stops a fifth "continue" from
 * landing on the first. A send still travelling is only ever placed on a row it can be timed against; a
 * delivered one the daemon already proved, so an untimed row is a last resort rather than a refusal.
 *
 * Nearest wins, measured from the daemon's own observation of the record when it has one, else from when
 * the send was accepted.
 */
const distance = (entry: TranscriptEntry, record: LedgerSendRecord, texts: ReadonlySet<string>): number | undefined => {
  if (entry.handoff !== undefined) return handedOff(entry.handoff, record) ? -1 : undefined;
  if (!texts.has(norm(entry.text))) return undefined;
  const accepted = instant(record.acceptedAt);
  if (entry.at === undefined || accepted === undefined)
    return record.fate === 'delivered' ? Number.POSITIVE_INFINITY : undefined;
  if (entry.at < accepted - RECORD_CLOCK_SLACK_MS) return undefined;
  return Math.abs(entry.at - (instant(record.evidence?.observedAt) ?? accepted));
};

/** Which user row wears which send, and which sends are inside a row another send wears. */
interface Wearing {
  readonly worn: ReadonlyMap<number, LedgerSendRecord>;
  readonly inside: ReadonlySet<string>;
}

/**
 * Puts each send on the transcript row that IS its message, ONE-TO-ONE: every legal pairing is ranked by
 * `distance`, then the newer send, then the newer row — the order a reader expects five identical
 * messages to line up in — and each pairing taken consumes both sides.
 *
 * Then the rows that are SEVERAL sends: see `joinedSends`.
 */
const wearSends = (entries: readonly TranscriptEntry[], records: readonly LedgerSendRecord[]): Wearing => {
  const candidates = records.filter(wearable);
  const pairs: { readonly index: number; readonly record: LedgerSendRecord; readonly distance: number }[] = [];
  for (const record of candidates) {
    const texts = new Set([norm(record.message), norm(bodyOf(record))]);
    entries.forEach((entry, index) => {
      if (entry.kind !== 'user') return;
      const away = distance(entry, record, texts);
      if (away !== undefined) pairs.push({ index, record, distance: away });
    });
  }
  const acceptedOf = (record: LedgerSendRecord): number => instant(record.acceptedAt) ?? 0;
  pairs.sort(
    (left, right) =>
      left.distance - right.distance || acceptedOf(right.record) - acceptedOf(left.record) || right.index - left.index,
  );
  const worn = new Map<number, LedgerSendRecord>();
  const placed = new Set<string>();
  for (const pair of pairs) {
    if (worn.has(pair.index) || placed.has(pair.record.sendId)) continue;
    worn.set(pair.index, pair.record);
    placed.add(pair.record.sendId);
  }
  const inside = joinedSends(
    entries,
    candidates.filter(record => !placed.has(record.sendId)),
    worn,
  );
  return { worn, inside };
};

/**
 * Sends the harness JOINED into one message. A TUI submits whatever its composer holds, so a message
 * typed onto one still sitting there unsent reaches the agent with it — "hello" and "hi" arrive as
 * "hellohi" — and neither send can find a row of its own.
 *
 * A row is taken only when it is EXACTLY two or more consecutive sends, in the order they were accepted,
 * each accepted before the row was written: the daemon's own rule for proving them (`judgeMerged`), never
 * a looser containment that would let one message stand for another. The row wears the LAST of the run;
 * the rest are inside it, so they are in the conversation and get no bubble of their own.
 */
const joinedSends = (
  entries: readonly TranscriptEntry[],
  unplaced: readonly LedgerSendRecord[],
  worn: Map<number, LedgerSendRecord>,
): ReadonlySet<string> => {
  const inside = new Set<string>();
  const waiting = [...unplaced].sort(
    (left, right) => (instant(left.acceptedAt) ?? 0) - (instant(right.acceptedAt) ?? 0),
  );
  entries.forEach((entry, index) => {
    const at = entry.at;
    if (entry.kind !== 'user' || entry.handoff !== undefined || worn.has(index) || at === undefined) return;
    const run = joinedRun(waiting, squeezed(entry.text), at);
    if (run === undefined) return;
    worn.set(index, run.at(-1) as LedgerSendRecord);
    for (const record of run.slice(0, -1)) inside.add(record.sendId);
    for (const record of run) waiting.splice(waiting.indexOf(record), 1);
  });
  return inside;
};

const joinedRun = (
  waiting: readonly LedgerSendRecord[],
  target: string,
  writtenAt: number,
): readonly LedgerSendRecord[] | undefined => {
  for (let start = 0; start < waiting.length; start += 1) {
    let joined = '';
    for (let end = start; end < waiting.length; end += 1) {
      const record = waiting[end] as LedgerSendRecord;
      const accepted = instant(record.acceptedAt);
      if (accepted === undefined || writtenAt < accepted - RECORD_CLOCK_SLACK_MS) break;
      joined += squeezed(bodyOf(record));
      if (!target.startsWith(joined)) break;
      if (joined === target && end > start) return waiting.slice(start, end + 1);
    }
  }
  return undefined;
};

/**
 * A delivered send the loaded transcript does not show YET: confirmed within `LANDING_GRACE_MS`, with no
 * user row written after it that nothing else explains. Such a row is most likely this very message in a
 * shape that could not be matched (a redaction, a harness rewording), and drawing a bubble beside it would
 * be the double this exists to prevent — so then the send is left to the row, as before.
 */
const stillLanding = (
  record: LedgerSendRecord,
  entries: readonly TranscriptEntry[],
  worn: ReadonlyMap<number, LedgerSendRecord>,
  nowMs: number,
): boolean => {
  if (record.fate !== 'delivered') return false;
  const confirmed = instant(record.fateAt) ?? instant(record.evidence?.observedAt);
  if (confirmed === undefined || nowMs - confirmed > LANDING_GRACE_MS) return false;
  const accepted = instant(record.acceptedAt) ?? Number.NEGATIVE_INFINITY;
  return !entries.some(
    (entry, index) =>
      entry.kind === 'user' &&
      entry.images === undefined &&
      !worn.has(index) &&
      (entry.at === undefined || entry.at >= accepted - RECORD_CLOCK_SLACK_MS),
  );
};

/**
 * Puts the send ledger INTO the conversation, and draws every message the reader sent exactly ONCE.
 *
 * A SEND IS ONE BUBBLE FOR ITS WHOLE LIFE. While it travels it is its own bubble after the conversation
 * — that is where it truly is, after everything the agent has read. The moment the transcript carries
 * it, that row WEARS the send and the trailing bubble is gone in the same render; the daemon's
 * confirmation then only moves the row's mark. Both are drawn under `sendRowId`, so the hand-over is one
 * element whose mark advances, never a second copy that appears and then vanishes. The bug this closes
 * was exactly that: the trailing bubble stayed until the daemon said "delivered", so for a poll or two
 * the reader saw their message twice and then watched the conversation jump.
 *
 *   * A row WEARS a send it is (`wearSends`): the daemon proved it there (delivered), or it is landing
 *     (the send is still accepted or queued, and the row was written after it with the same words). A
 *     message handed over through a FILE is matched by the turn or send its pointer names instead, since
 *     the row's text is only the pointer. A delivered send whose row is outside the loaded window simply
 *     has nothing to wear, which is right: it is in the conversation, just not on screen.
 *   * Several sends the harness joined into one message are worn by that one row (`joinedSends`).
 *   * A send still on its way is shown after the transcript, oldest first, as its own bubble: sending, held
 *     in the agent's queue, held for a revive — and, briefly, a delivered one whose row the loaded
 *     transcript does not carry yet (`stillLanding`), so a confirmation that outruns the transcript read
 *     does not make the message blink out.
 *   * A TERMINAL send — cancelled, or given up on — is NOT under the conversation: nothing is trying to
 *     deliver it, so pinning it below the live messages made the whole chat feel blocked. It is placed in
 *     the timeline at the moment it was SENT and drawn as a one-line note (`settledForm`), the whole
 *     bubble only while fresh or once the reader opened it. If the daemon later finds it WAS delivered it
 *     is worn by its transcript row like any other, under the same key, so the note becomes the
 *     message in place. A cancelled one retires after ten minutes.
 *   * Any undelivered send the reader dismissed (`view.dismissed`) is not drawn at all. That is a choice
 *     about THIS device's screen: the daemon is never told, and a dismissed send that turns out to be
 *     delivered is still the message it became.
 *
 * This never decides a FATE: a landing row wears the send's own fate until the daemon moves it. Matching
 * only chooses which row shows a message the daemon already has; a row it cannot place stays unworn
 * rather than guessed. A send that settled without arriving retires from view a day after it was sent;
 * the ledger itself keeps it.
 *
 * Once every row wears its send, a message THIS ferret sent that its recipient has since answered reads
 * `replied` (`markReplies`) — the answer is often a hand-off whose sender only its send names.
 */
export const placeLedgerRows = (
  entries: readonly TranscriptEntry[],
  records: readonly LedgerSendRecord[],
  nowMs: number = Date.now(),
  view: SendViewState = EMPTY_SEND_VIEW,
): readonly TranscriptEntry[] => {
  const folded = foldLedgerSendRecords(records);
  const { worn, inside } = wearSends(entries, folded);
  const shown = new Set([...worn.values()].map(record => record.sendId));
  const unplaced = folded.filter(
    record =>
      !shown.has(record.sendId) &&
      !inside.has(record.sendId) &&
      (record.fate === 'delivered' || !view.dismissed.has(record.sendId)),
  );
  const settled = unplaced
    .filter(record => isSettledUndelivered(record) && keepsItsRow(record, nowMs, view.expanded))
    .reverse();
  const trailing = unplaced
    .filter(
      record =>
        !isSettledUndelivered(record) && (keepsItsRow(record, nowMs) || stillLanding(record, entries, worn, nowMs)),
    )
    .reverse();
  const conversation = entries.map((entry, index) => {
    const send = worn.get(index);
    return send === undefined ? entry : { ...entry, id: sendRowId(send.sendId), send };
  });
  return markReplies([
    ...settled.reduce(
      (rows, record) => withSettledNote(rows, record, settledForm(record, nowMs, view.expanded)),
      conversation,
    ),
    ...trailing.map(
      (record): TranscriptEntry => ({
        id: sendRowId(record.sendId),
        kind: 'ledger',
        text: record.message,
        ledger: record,
        placement: 'chronological',
      }),
    ),
  ]);
};

/**
 * Puts a terminal send's note into the timeline at the moment it was sent: before the first row written
 * after it. Rows with no time stay where they are, and notes arrive oldest first, so two notes keep their
 * order. A send older than everything loaded sits at the top and says so; one with no readable time goes
 * last and says that.
 */
const withSettledNote = (
  rows: readonly TranscriptEntry[],
  record: LedgerSendRecord,
  settled: SettledForm,
): TranscriptEntry[] => {
  const sentAt = instant(record.acceptedAt);
  const after = sentAt === undefined ? -1 : rows.findIndex(row => row.at !== undefined && row.at > sentAt);
  const index = after === -1 ? rows.length : after;
  const placement: LedgerBlockPlacement =
    sentAt === undefined ? 'unknown-time' : index === 0 && rows.length > 0 ? 'before-loaded' : 'chronological';
  const note: TranscriptEntry = {
    id: sendRowId(record.sendId),
    kind: 'ledger',
    text: record.message,
    ledger: record,
    placement,
    settled,
  };
  return [...rows.slice(0, index), note, ...rows.slice(index)];
};

/**
 * Is this the reader's OWN send — typed by a person here, not a teammate's message and not Ferretry's
 * own notice? Only an own send is drawn as the reader's bubble while it travels, so that it is the same
 * bubble the transcript row draws once it lands.
 */
export const isOwnSend = (record: LedgerSendRecord): boolean =>
  record.from === undefined &&
  record.fromName === undefined &&
  !isFerretryNoticeSend(record) &&
  !isInstructionsSend(record) &&
  peerFrom(record.message).from === null;

/** Ferretry's own notice, never the reader's words: a daemon sender, or text that reads as a notice. */
export const isFerretryNoticeSend = (record: LedgerSendRecord): boolean =>
  record.senderKind === 'daemon' || parseFerretryNotice(record.message) !== null;

/**
 * What the document of a send handed over through a FILE holds, or `undefined` for a send typed into the
 * agent directly. The send's stored message is exactly what the daemon wrote there, so the bubble can
 * draw the document's message — and name its files — before the document is ever read.
 */
export const handedOverDraft = (record: LedgerSendRecord): ReturnType<typeof parseMessageAttachments> | undefined =>
  record.path === 'turn-file' || record.path === 'native-file' ? parseMessageAttachments(record.message) : undefined;

const isInstructionsSend = (record: LedgerSendRecord): boolean => {
  const by = record.queue?.by ?? record.by;
  return by !== undefined && isInstructionsNote(by);
};
