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

const PendingAppendSchema = z.strictObject({
  bytes: z.number().int().nonnegative().safe(),
  text: z.string().min(1),
});

/** Complete an append whose write-ahead journal survived a crash; a no-op when none did. */
export async function recoverLogAppend(files: AppendOnlyFiles, sessionId: string, name: string): Promise<void> {
  const journal = `${name}.pending`;
  const interrupted = await files.read(sessionId, journal);
  if (interrupted === undefined) return;
  const pending = PendingAppendSchema.parse(JSON.parse(interrupted));
  const tail = await files.readAfter(sessionId, name, pending.bytes);
  const intended = new TextEncoder().encode(pending.text);
  if (!tail.subarray(0, intended.length).every((byte, index) => byte === intended[index])) {
    throw new Error(`inconsistent append tail: ${name}`);
  }
  await files.appendSynced(sessionId, name, intended.subarray(tail.length));
  await files.remove(sessionId, journal);
}

/**
 * Append JSONL records once, then return the new bounded cursor. A small write-ahead file completes a torn
 * append on restart. Bytes past the cursor were never committed: the leading records of that tail that equal
 * this call's leading records are reused (a retry of the same command after a crash), and every other tail
 * byte is cut, so a rolled-back command's records can never be adopted by a different one. Only the
 * uncommitted tail is read; committed history is never read or rewritten here.
 */
export async function appendLogRecords(
  files: AppendOnlyFiles,
  sessionId: string,
  name: string,
  cursor: { readonly bytes: number; readonly count: number },
  records: readonly unknown[],
): Promise<{ readonly bytes: number; readonly count: number }> {
  const journal = `${name}.pending`;
  await recoverLogAppend(files, sessionId, name);
  const tailBytes = await files.readAfter(sessionId, name, cursor.bytes);
  const tail = new TextDecoder('utf-8', { fatal: true }).decode(tailBytes);
  if (tail !== '' && !tail.endsWith('\n')) throw new Error(`incomplete append tail: ${name}`);
  const replay = tail === '' ? [] : tail.slice(0, -1).split('\n');
  // Validate recovery data before advancing the cursor. The record schema belongs to the caller.
  for (const line of replay) JSON.parse(line);
  const lines = records.map(record => JSON.stringify(record));
  let reused = 0;
  while (reused < replay.length && reused < lines.length && replay[reused] === lines[reused]) reused += 1;
  const bytes =
    cursor.bytes +
    new TextEncoder().encode(
      replay
        .slice(0, reused)
        .map(line => `${line}\n`)
        .join(''),
    ).length;
  if (bytes < cursor.bytes + tailBytes.length) await files.truncate(sessionId, name, bytes);
  const added = lines.slice(reused);
  const text = added.length === 0 ? '' : `${added.join('\n')}\n`;
  if (text !== '') {
    const pending = { bytes, text };
    await files.writeAtomic(sessionId, journal, JSON.stringify(pending));
    await recoverLogAppend(files, sessionId, name);
  }
  return { bytes: bytes + new TextEncoder().encode(text).length, count: cursor.count + lines.length };
}

/** The cursor that covers every complete line of `bytes`: a log's committed extent when no cursor was ever kept. */
export function completeLinesCursor(bytes: Uint8Array): { readonly bytes: number; readonly count: number } {
  const end = bytes.lastIndexOf(0x0a) + 1;
  return { bytes: end, count: bytes.subarray(0, end).filter(byte => byte === 0x0a).length };
}
