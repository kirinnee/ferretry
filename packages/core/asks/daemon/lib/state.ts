import { defineState } from '@ferretry/kernel/contract';

/**
 * Asks' private state (§9.2, lead decision 2026-11-07): ONE LEDGER PER FERRET, as today's engine keeps it, under
 * `state/asks/ferrets/<ferret>/`. Nobody else reads these files, so they live here and not in the contract.
 *
 * Every file is `opaque`: the engine writes and reads its own exact bytes, because its crash recovery compares the
 * digest of the text it prepared with the text on disk, and cuts a history append back to a byte cursor. The kernel
 * still writes each one atomically (a synced temporary file renamed over it, then the folder synced) and confines
 * it to `state/asks/`. The ledger carries its own one format (`version: 1`, read at exactly that).
 *
 * The `*` is the ferret's session id, or `machine-agenda` for the daemon's own notices.
 */
const perFerret = <const Name extends string>(name: Name, file: string) =>
  defineState({ name, path: `ferrets/*/${file}`, store: 'opaque', format: 1 });

/** The board: every open and recently closed ask of one ferret (today's `agenda.json`). */
export const AgendaLedgerFiles = perFerret('ledgers', 'agenda.json');
/** The owner's held answers on their way to the ferret (today's `agenda-replies.json`). */
export const AgendaRepliesFiles = perFerret('replies', 'agenda-replies.json');
/** The append-only history the ledger's cursor commits (today's `agenda-history.jsonl`). */
export const AgendaHistoryFiles = perFerret('history', 'agenda-history.jsonl');
/** Where an uncommitted history append began (`agenda-history.jsonl.pending`). */
export const AgendaHistoryMarkFiles = perFerret('history-marks', 'agenda-history.jsonl.pending');
/** The fsynced intent of a change with versions, replayed after a crash (`agenda-versions.pending.json`). */
export const AgendaPendingVersionsFiles = perFerret('pending-versions', 'agenda-versions.pending.json');
/** Each device's last-seen version of each ask (`agenda-seen.json`): a display hint. */
export const AgendaSeenFiles = perFerret('seen', 'agenda-seen.json');
/** The change events still to be delivered (`agenda-changes.pending.json`). */
export const AgendaPendingChangesFiles = perFerret('pending-changes', 'agenda-changes.pending.json');
/**
 * A file set aside rather than replayed or read (a stale intent, a damaged outbox), kept for a person to look at:
 * named `<ferret>~<its old name>`.
 */
export const AgendaSetAsideFiles = defineState({ name: 'set-aside', path: 'set-aside/*', store: 'opaque', format: 1 });

/** The per-ferret files, by the name the engine knows each one under. */
export const AGENDA_STATE_FILES = {
  'agenda.json': AgendaLedgerFiles,
  'agenda-replies.json': AgendaRepliesFiles,
  'agenda-history.jsonl': AgendaHistoryFiles,
  'agenda-history.jsonl.pending': AgendaHistoryMarkFiles,
  'agenda-versions.pending.json': AgendaPendingVersionsFiles,
  'agenda-changes.pending.json': AgendaPendingChangesFiles,
  'agenda-seen.json': AgendaSeenFiles,
} as const;

/** Every file Asks declares besides the contract's version archives. */
export const ASKS_STATE = [
  AgendaLedgerFiles,
  AgendaRepliesFiles,
  AgendaHistoryFiles,
  AgendaHistoryMarkFiles,
  AgendaPendingVersionsFiles,
  AgendaPendingChangesFiles,
  AgendaSeenFiles,
  AgendaSetAsideFiles,
] as const;

/** The name a version archive goes by in `versions/*.sqlite`: the ferret and the ask (`<ferret>~A12`). */
export const versionArchiveName = (sessionId: string, askId: string): string => `${sessionId}~${askId}`;
