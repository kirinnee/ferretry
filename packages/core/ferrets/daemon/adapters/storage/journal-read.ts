import type { StatePort } from '@ferretry/kernel/contract';
import { FerretHistoryFiles } from '../../../contract/index.ts';
import type { SessionId } from '../../lib/session-id.ts';
import { JournalScanner } from '../../lib/storage/journal.ts';
import type { JournalRead } from './session-storage-shapes.ts';
import { fileOf } from './session-storage-support.ts';

/**
 * A session's journal read once, each record folded into the scan as the state port hands it out: a journal of any
 * size costs its pointers, never its lines. A read that fails part way ends with a damaged line, as it always did.
 */
export async function readJournalScan(state: StatePort, id: SessionId): Promise<JournalRead> {
  const scanner = new JournalScanner({ file: fileOf(FerretHistoryFiles, id), sessionId: id });
  let complete = true;
  try {
    for await (const value of state.lines(FerretHistoryFiles, id)) scanner.push({ value });
  } catch (error) {
    scanner.push({
      damaged: `event record could not be read: ${error instanceof Error ? error.message : String(error)}`,
    });
    complete = false;
  }
  return { scan: scanner.scan(), count: scanner.count, complete };
}

/**
 * The journal lines at the given positions, in one pass that keeps only those: the journal itself is never held. A
 * position the read never reached (the journal is shorter, or the read failed first) is absent from the answer.
 */
export async function journalLinesAt(
  state: StatePort,
  id: SessionId,
  positions: ReadonlySet<number>,
): Promise<Map<number, unknown>> {
  const found = new Map<number, unknown>();
  if (positions.size === 0) return found;
  const last = Math.max(...positions);
  let position = 0;
  try {
    for await (const value of state.lines(FerretHistoryFiles, id)) {
      if (positions.has(position)) found.set(position, value);
      position += 1;
      if (position > last) break;
    }
  } catch {
    // What was read before the fault stands; the positions past it are absent, so the caller refuses them.
  }
  return found;
}
