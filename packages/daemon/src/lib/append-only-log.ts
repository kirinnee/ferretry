import { z } from 'zod';

/** Byte-oriented IO; append must sync the file before resolving. The caller serializes writers. */
export interface AppendOnlyFiles {
  read(sessionId: string, name: string): Promise<string | undefined>;
  readAfter(sessionId: string, name: string, bytes: number): Promise<Uint8Array>;
  appendSynced(sessionId: string, name: string, bytes: Uint8Array): Promise<void>;
  /** Cut the file to its first `bytes` bytes, synced. Only ever drops an uncommitted tail. */
  truncate(sessionId: string, name: string, bytes: number): Promise<void>;
  writeAtomic(sessionId: string, name: string, text: string): Promise<void>;
  remove(sessionId: string, name: string): Promise<void>;
}

/** Where an append the caller has not committed yet began. Extra fields of an earlier shape are ignored. */
const UncommittedAppendSchema = z.object({ bytes: z.number().int().nonnegative().safe() });

const markOf = (name: string) => `${name}.pending`;

/**
 * Append JSONL records past the committed cursor and return the cursor that commits them. Every byte past the
 * cursor was never committed — a rolled-back command's records, or a torn append — so it is cut first: a retry
 * of the same command writes its records once, and a different command never adopts another's. Only that
 * uncommitted tail is read; committed history is never read or rewritten here.
 *
 * Before anything is written, a durable mark records where this append begins. It stays until the caller's
 * commit lands ({@link commitLogAppend}), so a reader whose commit record has no cursor still knows where the
 * committed history ends ({@link uncommittedLogFrom}).
 */
export async function appendLogRecords(
  files: AppendOnlyFiles,
  sessionId: string,
  name: string,
  cursor: { readonly bytes: number; readonly count: number },
  records: readonly unknown[],
): Promise<{ readonly bytes: number; readonly count: number }> {
  if (records.length === 0) return cursor;
  const text = new TextEncoder().encode(`${records.map(record => JSON.stringify(record)).join('\n')}\n`);
  await files.writeAtomic(sessionId, markOf(name), JSON.stringify({ bytes: cursor.bytes }));
  if ((await files.readAfter(sessionId, name, cursor.bytes)).length > 0)
    await files.truncate(sessionId, name, cursor.bytes);
  await files.appendSynced(sessionId, name, text);
  return { bytes: cursor.bytes + text.length, count: cursor.count + records.length };
}

/** Where an append that was never committed begins, or `undefined` when every append was committed. */
export async function uncommittedLogFrom(
  files: AppendOnlyFiles,
  sessionId: string,
  name: string,
): Promise<number | undefined> {
  const mark = await files.read(sessionId, markOf(name));
  return mark === undefined ? undefined : UncommittedAppendSchema.parse(JSON.parse(mark)).bytes;
}

/** Drop the mark once the commit naming the log's cursor has landed; a no-op when there is none. */
export async function commitLogAppend(files: AppendOnlyFiles, sessionId: string, name: string): Promise<void> {
  await files.remove(sessionId, markOf(name));
}

/** The cursor that covers every complete line of `bytes`: a log's committed extent when no cursor was ever kept. */
export function completeLinesCursor(bytes: Uint8Array): { readonly bytes: number; readonly count: number } {
  const end = bytes.lastIndexOf(0x0a) + 1;
  return { bytes: end, count: bytes.subarray(0, end).filter(byte => byte === 0x0a).length };
}
