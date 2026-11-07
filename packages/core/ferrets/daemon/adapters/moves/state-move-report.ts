import type { StatePort } from '@ferretry/kernel/contract';
import { MoveInflightFiles } from '../../../contract/move-state.ts';
import type { MoveReportStore } from '../../lib/moves/report-store.ts';
import type { SessionId } from '../../lib/session-id.ts';

/**
 * The move report inside the ferret's own state folder (`<ferret>/move-inflight.md`, declared by
 * {@link MoveInflightFiles}).
 *
 * The first half is written ATOMICALLY (the state port replaces the file whole, never in place), for the same reason
 * the turn store is: the agent that reads this document is handed its path by the very relaunch that follows the
 * write, so a torn document is one a moved agent reads as its account of what was interrupted.
 *
 * The outcome half is added to what the first half wrote, and the state port replaces the file atomically too: a
 * failure part-way leaves the inventory exactly as it was, so the only surviving evidence of what the kill destroyed
 * is never taken with it. The state port offers no append for an opaque file, so the old bytes are read back and the
 * file written again whole; moves of one ferret are serialized (`KeyedSerialExecutor` in the module), so nothing else
 * writes between the read and the write. Appending keeps the file honest about ordering: the pending inventory was
 * true when it was written, and the outcome is a later fact about it.
 *
 * ONE report per ferret, deliberately overwritten by a second move. A ferret that is moved twice was moved twice for a
 * reason, and the journal carries both `session.moving` events with their targets; keeping a numbered pile of reports
 * would grow without bound while the handoff message could only ever name one of them.
 */
export class StateMoveReportStore implements MoveReportStore {
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  constructor(private readonly state: StatePort) {}

  /** Where this ferret's report lives. Public so a caller can name it before deciding to write. */
  file(id: SessionId): string {
    return this.state.pathOf(MoveInflightFiles, id);
  }

  async write(id: SessionId, document: string): Promise<string> {
    await this.state.write(MoveInflightFiles, this.encoder.encode(document), id);
    return this.file(id);
  }

  async append(id: SessionId, section: string): Promise<void> {
    const read = await this.state.read(MoveInflightFiles, id);
    if (!read.ok) throw new Error(read.error.sentence);
    // A report that is not there is created from the section alone, as an append to a missing file always did.
    const before = read.value === undefined ? '' : this.decoder.decode(read.value);
    await this.state.write(MoveInflightFiles, this.encoder.encode(before + section), id);
  }
}
