// JOINING THIS BROWSER'S OPTIMISTIC ROWS TO THE DURABLE LEDGER.
//
// Content matching survives in exactly two places, both here, and neither of
// them establishes a send's FATE — the daemon already decided that (see
// `send-ledger.ts`). These are UI bookkeeping questions: "is my chip now
// represented by a durable row?" and "can the reader already see this message?"
//
// The bug this file exists to prevent is a message being proved by a LATER
// message that merely quoted it. Every match below is therefore bounded by
// identity, by attachment-set equality, and by a forward-only time window.

import { sameAttachmentIds } from './attachment-ids.ts';
import { hasLedgerHardExpired, RECORD_CLOCK_SLACK_MS, type LedgerSendRecord } from './send-ledger.ts';

/**
 * Normalizes for the local↔durable join only. Collapses whitespace runs rather
 * than stripping whitespace entirely, and never lowercases: the composer
 * soft-wraps, but "OK" and "ok" are different messages, and a full strip makes
 * "ab c" and "a bc" identical.
 */
const norm = (value: string): string => value.normalize('NFC').trim().replace(/\s+/gu, ' ');

/** An optimistic row this browser is holding, awaiting its durable twin. */
export interface LocalSend {
  readonly key: string;
  /**
   * The idempotency key this browser minted for the LOGICAL message. The daemon
   * reuses it as the `sendId` where it can, which makes the join exact.
   */
  readonly requestId: string;
  readonly text: string;
  readonly attachmentIds: readonly string[];
  /** Browser clock, milliseconds. */
  readonly at: number;
}

export interface SendReconciliation<T extends LocalSend> {
  /** Local rows now represented by a durable row — the caller drops these chips. */
  readonly claimed: ReadonlyMap<string, LedgerSendRecord>;
  /** Local rows with no durable twin yet: still the local chip's job. */
  readonly unclaimedLocal: readonly T[];
  /**
   * Durable rows not claimed by any local row — the rows to RENDER. Includes
   * rows from other clients and from earlier sessions of this one, which is
   * exactly what survives a refresh.
   */
  readonly durable: readonly LedgerSendRecord[];
}

/**
 * Joins this browser's optimistic rows to the durable ledger, ONE-TO-ONE.
 *
 * Two tiers, and no third:
 *
 *   1. `sendId === requestId`. The daemon reuses the client's own idempotency
 *      key as the send id where the path allows, so this is an exact identity
 *      join with nothing inferred. Always preferred.
 *   2. Normalized message equality + identical attachment set + the durable row
 *      was accepted no earlier than `at - RECORD_CLOCK_SLACK_MS`.
 *
 * The forward-only window is what stops an OLDER identical row from reaping a
 * NEWER send: re-sending "continue" for the fifth time must join to the fifth
 * durable row, not to the first. Where several candidates remain legal the
 * closest `acceptedAt` wins, ties break FIFO by local `at` — the order the
 * reader actually pressed Enter in — and every match consumes both sides, so N
 * identical local rows can never all collapse onto one durable row.
 *
 * Equality, not prefix or containment. Two drafts where one is a prefix of the
 * other are DIFFERENT messages and must not cross-claim.
 */
export const reconcileLocalSends = <T extends LocalSend>(
  local: readonly T[],
  ledger: readonly LedgerSendRecord[],
): SendReconciliation<T> => {
  const claimed = new Map<string, LedgerSendRecord>();
  const takenLocal = new Set<string>();
  const takenDurable = new Set<string>();

  // Tier 1: exact identity, done first and unconditionally, so a content
  // coincidence can never outrank a real id.
  const byId = new Map<string, LedgerSendRecord>();
  for (const record of ledger) byId.set(record.sendId, record);
  for (const entry of local) {
    const hit = byId.get(entry.requestId);
    if (hit === undefined || takenDurable.has(hit.sendId)) continue;
    claimed.set(entry.key, hit);
    takenLocal.add(entry.key);
    takenDurable.add(hit.sendId);
  }

  // Tier 2: content + attachments + forward window, assigned by closest time.
  const pairs: {
    readonly localKey: string;
    readonly sendId: string;
    readonly distance: number;
    readonly at: number;
  }[] = [];
  for (const entry of local) {
    if (takenLocal.has(entry.key)) continue;
    const text = norm(entry.text);
    for (const record of ledger) {
      if (takenDurable.has(record.sendId)) continue;
      if (norm(record.message) !== text) continue;
      if (!sameAttachmentIds(record.attachmentIds, entry.attachmentIds)) continue;
      const acceptedAt = Date.parse(record.acceptedAt);
      if (!Number.isFinite(acceptedAt) || acceptedAt < entry.at - RECORD_CLOCK_SLACK_MS) continue;
      pairs.push({
        localKey: entry.key,
        sendId: record.sendId,
        distance: Math.abs(acceptedAt - entry.at),
        at: entry.at,
      });
    }
  }
  pairs.sort((left, right) => left.distance - right.distance || left.at - right.at);
  for (const pair of pairs) {
    if (takenLocal.has(pair.localKey) || takenDurable.has(pair.sendId)) continue;
    const record = byId.get(pair.sendId);
    if (record === undefined) continue;
    claimed.set(pair.localKey, record);
    takenLocal.add(pair.localKey);
    takenDurable.add(pair.sendId);
  }

  return {
    claimed,
    unclaimedLocal: local.filter(entry => !takenLocal.has(entry.key)),
    durable: ledger.filter(record => !takenDurable.has(record.sendId)),
  };
};

/**
 * The minimum a transcript user block has to expose for `selectLedgerChips` to
 * reason about it. Deliberately a plain shape rather than a transcript block, so
 * this module stays independent of the render model.
 */
export interface VisibleUserRow {
  /**
   * The harness record identities this row was built from — the ONLY thing that
   * can retire a delivered chip. Matched verbatim against the citation key.
   * Absent means this row cannot stand in for any send.
   */
  readonly proofKeys?: readonly string[];
  readonly text: string;
  readonly attachmentIds: readonly string[];
  /** Milliseconds. */
  readonly at: number;
  /**
   * The teammate this row is attributed to, absent for a human/self row. It must
   * AGREE with the record's own `fromName`/`from` for the row to stand in for it.
   */
  readonly peerName?: string;
}

/**
 * Do this row and this record come from the same author? Both unattributed (the
 * human's own send) or both attributed to the same teammate. The record stores
 * `from` (session id) and `fromName` (callsign); the rendered row shows whichever
 * the daemon supplied, so either is accepted.
 */
const samePeerIdentity = (row: VisibleUserRow, record: LedgerSendRecord): boolean => {
  const rowPeer = row.peerName;
  const recordPeer = record.fromName ?? record.from;
  if (rowPeer === undefined) return recordPeer === undefined;
  if (recordPeer === undefined) return false;
  return rowPeer === record.fromName || rowPeer === record.from;
};

/**
 * Strips the daemon's peer attribution banner, matching the transcript parser.
 * A message with no banner (the normal human send) is returned untouched.
 */
const peerBody = (message: string): string => {
  const match = /^\[peer message from teammate [^\]]*\]\n(?:.*?)\n\n/su.exec(message);
  return match === null ? message : message.slice(match[0].length);
};

const sortNewestFirst = (records: LedgerSendRecord[]): LedgerSendRecord[] =>
  records.sort((left, right) => (Date.parse(right.acceptedAt) || 0) - (Date.parse(left.acceptedAt) || 0));

/**
 * Which durable rows still need a chip of their own, given what is ON SCREEN.
 *
 * ACCEPTED and UNACCOUNTED always do: the reader is owed the knowledge that a
 * message is in flight, and an unconfirmed message is a standing fact about the
 * session rather than a transient.
 *
 * DELIVERED is the interesting case, and "delivered ⇒ no chip" is WRONG. The
 * transcript is paginated, so the harness record that proved a send can easily
 * sit outside what is currently loaded. Dropping the chip on fate alone would
 * render such a send as NOTHING AT ALL: no row, no badge, no trace. The ledger
 * owns EXISTENCE; only the presence of the proof-backed row on screen retires
 * its chip, because only then is the message actually visible to the reader.
 *
 * RETIREMENT REQUIRES EXACT PROOF IDENTITY — a loaded row IS the row the daemon
 * cited. Content equality is not identity, and treating it as identity was a
 * real bug: two sends of the same text are indistinguishable by text, and so is
 * a later message that quotes an earlier one.
 *
 * Text, attachments, peer identity and the time window are kept, but strictly as
 * defensive checks on top of an identity hit: they can only ever VETO a
 * retirement, never authorise one.
 *
 * Deliberate consequences, not gaps:
 *   - no citation, or a citation with no key ⇒ chip stays;
 *   - a row with no `proofKeys` cannot retire anything;
 *   - assignment stays one-to-one, so two delivered sends cannot both be retired
 *     by one row even if its key somehow matched both.
 */
export const selectLedgerChips = (
  durable: readonly LedgerSendRecord[],
  blocks: readonly VisibleUserRow[] = [],
  nowMs: number = Date.now(),
): LedgerSendRecord[] => {
  const live = durable.filter(record => !hasLedgerHardExpired(record, nowMs));
  const delivered = live.filter(record => record.withdrawn !== true && record.fate === 'delivered');
  const open = live.filter(record => record.withdrawn !== true && record.fate !== 'delivered');
  if (delivered.length === 0) return sortNewestFirst(open);

  const takenRow = new Set<number>();
  const proven = new Set<string>();
  // The transcript is PAGED. A send older than everything currently loaded can
  // never find its row here, and keeping its chip renders the message a second
  // time in the footer — so a long session showed every delivered send stacked
  // below the transcript instead of in place. Out-of-window is not a
  // disagreement: the daemon already cited the row it matched.
  const windowFloor = blocks.reduce<number>(
    (min, row) => (Number.isFinite(row.at) && row.at < min ? row.at : min),
    Number.POSITIVE_INFINITY,
  );
  for (const record of delivered) {
    const key = record.evidence?.key;
    // No citation ⇒ nothing to match against ⇒ keep the chip.
    if (key === undefined) continue;
    const rowIndex = blocks.findIndex((row, index) => !takenRow.has(index) && row.proofKeys?.includes(key) === true);
    if (rowIndex === -1) {
      // Retire ONLY when the send is unambiguously off-page: older than the
      // loaded window AND no visible row carries the same body. If an identical
      // row IS visible the chip stays, because this send cannot be told apart
      // from that row's own send.
      const acceptedAt = Date.parse(record.acceptedAt);
      const body = norm(peerBody(record.message));
      const ambiguous = blocks.some(row => norm(row.text) === body);
      if (
        !ambiguous &&
        Number.isFinite(windowFloor) &&
        Number.isFinite(acceptedAt) &&
        acceptedAt < windowFloor - RECORD_CLOCK_SLACK_MS
      )
        proven.add(record.sendId);
      continue;
    }
    const row = blocks[rowIndex];
    if (row === undefined) continue;
    // Consistency checks. The daemon has named this exact row, so a disagreement
    // here means the ledger and the transcript describe different things — keep
    // the chip and let the reader see both rather than silently trusting one.
    //
    // A peer send's stored `message` carries the attribution banner the daemon
    // prepends (the harness only reads text), while the rendered row has had that
    // banner lifted into a sender chip, so bodies are compared.
    if (!samePeerIdentity(row, record)) continue;
    if (norm(row.text) !== norm(peerBody(record.message))) continue;
    if (!sameAttachmentIds(row.attachmentIds, record.attachmentIds)) continue;
    const acceptedAt = Date.parse(record.acceptedAt);
    if (Number.isFinite(acceptedAt) && Number.isFinite(row.at) && row.at < acceptedAt - RECORD_CLOCK_SLACK_MS) continue;
    proven.add(record.sendId);
    takenRow.add(rowIndex);
  }
  return sortNewestFirst([...open, ...delivered.filter(record => !proven.has(record.sendId))]);
};

/**
 * Projects a built transcript down to the user rows `selectLedgerChips` needs.
 * Structurally typed rather than importing the block union, so the ledger stays
 * independent of the render model.
 */
export const visibleUserRows = (
  blocks: readonly {
    readonly kind: string;
    readonly text?: string;
    readonly ts?: string;
    readonly from?: { readonly name: string };
    readonly attachments?: readonly { readonly attachmentId: string }[];
    readonly proofKeys?: readonly string[];
  }[],
): VisibleUserRow[] => {
  const rows: VisibleUserRow[] = [];
  for (const block of blocks) {
    if (block.kind !== 'user') continue;
    rows.push({
      text: block.text ?? '',
      attachmentIds: (block.attachments ?? []).map(attachment => attachment.attachmentId),
      at: Date.parse(block.ts ?? '') || 0,
      ...(block.from === undefined ? {} : { peerName: block.from.name }),
      // Carried through verbatim. A block with none stays unable to retire a chip.
      ...(block.proofKeys === undefined ? {} : { proofKeys: block.proofKeys }),
    });
  }
  return rows;
};
