import type { HandoffPointer } from '@ferretry/protocol';
import { peerFrom } from './peer-message.ts';
import { foldLedgerSendRecords, type LedgerSendRecord } from './send-ledger.ts';
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

/** Whitespace-insensitive, case-sensitive: a soft-wrapped composer is not a different message. */
const norm = (value: string): string => value.normalize('NFC').replace(/\s+/gu, ' ').trim();

/**
 * Is this send the one a hand-off row points at? By IDENTITY, not text: the row holds only the pointer,
 * and the turn number or send id it names is the very one the daemon recorded on the send.
 */
const handedOff = (pointer: HandoffPointer, record: LedgerSendRecord): boolean =>
  pointer.kind === 'turn' ? record.turn === pointer.turn : record.sendId === pointer.sendId;

/**
 * Puts the send ledger INTO the conversation.
 *
 * TWO KINDS OF SEND, TWO PLACES:
 *
 *   * A DELIVERED send is already in the transcript — the daemon proved it there — so it gets no row of
 *     its own. Its chip goes on the user message it became: the NEWEST unclaimed user row carrying the
 *     same text, matched one-to-one from the end, so five identical "continue"s chip five rows. A
 *     delivered send whose row is outside the loaded window simply has nothing to chip, which is
 *     right: it is in the conversation, just not on screen. A message handed over through a FILE is
 *     matched by the turn or send its pointer names instead, since the row's text is only the pointer.
 *   * Every other send is NOT in the conversation — still sending, held in the agent's queue, or
 *     settled without arriving — so it is shown after the transcript, oldest first, as its own bubble
 *     with its own chip. That is where it is in truth: after everything the agent has read.
 *
 * This never decides a fate. Text matching only chooses WHICH user row wears a chip the daemon
 * already proved; a row it cannot place stays unchipped rather than guessed. A send that settled
 * without arriving retires from view a day after it was sent, so an old failure does not sit under
 * the conversation forever; the ledger itself keeps it.
 */
export const placeLedgerRows = (
  entries: readonly TranscriptEntry[],
  records: readonly LedgerSendRecord[],
  nowMs: number = Date.now(),
): readonly TranscriptEntry[] => {
  const folded = foldLedgerSendRecords(records);
  const delivered = folded.filter(record => record.fate === 'delivered');
  const chips = new Map<number, LedgerSendRecord>();
  for (const record of delivered) {
    const texts = new Set([norm(record.message), norm(peerFrom(record.message).body)]);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index] as TranscriptEntry;
      if (entry.kind !== 'user' || chips.has(index)) continue;
      const matches = entry.handoff === undefined ? texts.has(norm(entry.text)) : handedOff(entry.handoff, record);
      if (!matches) continue;
      chips.set(index, record);
      break;
    }
  }
  const pending = folded
    .filter(record => record.fate !== 'delivered')
    .filter(record => {
      if (record.fate === 'accepted' || record.fate === 'queued') return true;
      const at = Date.parse(record.acceptedAt);
      return !Number.isFinite(at) || nowMs - at < SETTLED_ROW_LIFETIME_MS;
    })
    .reverse();
  return [
    ...entries.map((entry, index) => {
      const send = chips.get(index);
      return send === undefined ? entry : { ...entry, send };
    }),
    ...pending.map(
      (record): TranscriptEntry => ({
        id: `ledger:${record.sendId}`,
        kind: 'ledger',
        text: record.message,
        ledger: record,
        placement: 'chronological',
      }),
    ),
  ];
};
