import type { SessionId } from '../session-id.ts';

/**
 * Where a migration's forensic record lives.
 *
 * The record is written in TWO halves and that split is the contract, not a convenience: the
 * inventory half is written BEFORE the pane is killed — while the evidence still exists — and the
 * outcome half is appended after the attempt settles. The renderers enforce the same discipline in
 * their prose, so a report that stops after the first half is a migration that was attempted and
 * never came back, which is exactly what it should read as.
 *
 * The document is what the replacement agent is pointed at, so `write` answers with the PATH rather
 * than nothing: the handoff message names the file, and a store that decided its own location
 * without telling the caller would leave that message pointing at a guess.
 */
export interface MigrationReportStore {
  /** Writes the pre-attempt inventory, replacing any earlier report, and answers its path. */
  write(id: SessionId, document: string): Promise<string>;
  /** Appends the settled outcome to the record `write` produced. */
  append(id: SessionId, section: string): Promise<void>;
}
