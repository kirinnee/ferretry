import { type HandoffPointer, parseMessageAttachments } from '@ferretry/protocol';
import { markReplies } from './peer-delivery.ts';
import { peerFrom } from './peer-message.ts';
import { foldLedgerSendRecords, type LedgerSendRecord, RECORD_CLOCK_SLACK_MS } from './send-ledger.ts';
import type { TranscriptEntry } from './session-screens.ts';

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
 * Does this undelivered send still have a row under the conversation? Sending and queued ones always
 * do; one that settled (or was cancelled) keeps its row for a day, and then retires from view.
 */
const keepsItsRow = (record: LedgerSendRecord, nowMs: number): boolean => {
  if (record.fate === 'delivered') return false;
  if (record.fate === 'accepted' || record.fate === 'queued') return true;
  const at = Date.parse(record.acceptedAt);
  return !Number.isFinite(at) || nowMs - at < SETTLED_ROW_LIFETIME_MS;
};

/**
 * A STUCK send: one the reader can still see waiting, that nothing has proved arrived, that nobody has
 * taken back and that is not deliberately held for a revive. It is what "Clear stuck messages" clears,
 * so the count in its question is the number of such rows on screen.
 */
export const isStuckSend = (record: LedgerSendRecord, nowMs: number = Date.now()): boolean =>
  record.withdrawn !== true && record.held !== true && record.fate !== 'cancelled' && keepsItsRow(record, nowMs);

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

const instant = (value: string | undefined): number | undefined => {
  const at = Date.parse(value ?? '');
  return Number.isFinite(at) ? at : undefined;
};

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
 *   * Every other send is shown after the transcript, oldest first, as its own bubble: still sending,
 *     held in the agent's queue, settled without arriving — and, briefly, a delivered one whose row the
 *     loaded transcript does not carry yet (`stillLanding`), so a confirmation that outruns the
 *     transcript read does not make the message blink out.
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
): readonly TranscriptEntry[] => {
  const folded = foldLedgerSendRecords(records);
  const { worn, inside } = wearSends(entries, folded);
  const shown = new Set([...worn.values()].map(record => record.sendId));
  const trailing = folded
    .filter(
      record =>
        !shown.has(record.sendId) &&
        !inside.has(record.sendId) &&
        (keepsItsRow(record, nowMs) || stillLanding(record, entries, worn, nowMs)),
    )
    .reverse();
  return markReplies([
    ...entries.map((entry, index) => {
      const send = worn.get(index);
      return send === undefined ? entry : { ...entry, id: sendRowId(send.sendId), send };
    }),
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
 * Is this the reader's OWN send — typed by a person here, not a teammate's message and not Ferretry's
 * own notice? Only an own send is drawn as the reader's bubble while it travels, so that it is the same
 * bubble the transcript row draws once it lands.
 */
export const isOwnSend = (record: LedgerSendRecord): boolean =>
  record.from === undefined &&
  record.fromName === undefined &&
  record.senderKind !== 'daemon' &&
  peerFrom(record.message).from === null;

/**
 * What the document of a send handed over through a FILE holds, or `undefined` for a send typed into the
 * agent directly. The send's stored message is exactly what the daemon wrote there, so the bubble can
 * draw the document's message — and name its files — before the document is ever read.
 */
export const handedOverDraft = (record: LedgerSendRecord): ReturnType<typeof parseMessageAttachments> | undefined =>
  record.path === 'turn-file' || record.path === 'native-file' ? parseMessageAttachments(record.message) : undefined;
