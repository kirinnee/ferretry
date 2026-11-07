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

const markOf = (name: string) => `${name}.pending`;

/**
 * Append JSONL records past the committed cursor and return the cursor that commits them. Every byte past the
 * cursor was never committed — a rolled-back command's records, or a torn append — so it is cut first: a retry
 * of the same command writes its records once, and a different command never adopts another's. Only that
 * uncommitted tail is read; committed history is never read or rewritten here.
 *
 * Before anything is written, a durable mark records where this append begins. It stays until the caller's
 * commit lands ({@link commitLogAppend}).
 */
export async function appendLogRecords(
  files: AppendOnlyFiles,
  sessionId: string,
  name: string,
  cursor: { readonly bytes: number; readonly count: number },
  records: readonly unknown[],
): Promise<{ readonly bytes: number; readonly count: number }> {
  if (records.length === 0) return cursor;
  await files.writeAtomic(sessionId, markOf(name), JSON.stringify({ bytes: cursor.bytes }));
  if ((await files.readAfter(sessionId, name, cursor.bytes)).length > 0)
    await files.truncate(sessionId, name, cursor.bytes);
  await files.appendSynced(sessionId, name, encodedRecords(records));
  return appendedCursor(cursor, records);
}

const encodedRecords = (records: readonly unknown[]): Uint8Array =>
  new TextEncoder().encode(`${records.map(record => JSON.stringify(record)).join('\n')}\n`);

/** The cursor {@link appendLogRecords} returns for these records, without writing anything. Pure. */
export function appendedCursor(
  cursor: { readonly bytes: number; readonly count: number },
  records: readonly unknown[],
): { readonly bytes: number; readonly count: number } {
  if (records.length === 0) return cursor;
  return { bytes: cursor.bytes + encodedRecords(records).length, count: cursor.count + records.length };
}

/** Drop the mark once the commit naming the log's cursor has landed; a no-op when there is none. */
export async function commitLogAppend(files: AppendOnlyFiles, sessionId: string, name: string): Promise<void> {
  await files.remove(sessionId, markOf(name));
}
