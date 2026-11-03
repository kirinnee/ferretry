import { z } from 'zod';

/** Byte-oriented IO; append must sync the file before resolving. The caller serializes writers. */
export interface AppendOnlyFiles {
  read(sessionId: string, name: string): Promise<string | undefined>;
  readAfter(sessionId: string, name: string, bytes: number): Promise<Uint8Array>;
  appendSynced(sessionId: string, name: string, bytes: Uint8Array): Promise<void>;
  writeAtomic(sessionId: string, name: string, text: string): Promise<void>;
  remove(sessionId: string, name: string): Promise<void>;
}

const PendingAppendSchema = z.strictObject({
  bytes: z.number().int().nonnegative().safe(),
  text: z.string().min(1),
});

/**
 * Append JSONL records once, then return the new bounded cursor. A small write-ahead file completes a torn
 * append on restart. A cursor lagging a completed append reuses its matching records, including duplicates
 * within a batch. Only the uncommitted tail is read; committed history is never read or rewritten here.
 */
export async function appendLogRecords(
  files: AppendOnlyFiles,
  sessionId: string,
  name: string,
  cursor: { readonly bytes: number; readonly count: number },
  records: readonly unknown[],
): Promise<{ readonly bytes: number; readonly count: number }> {
  const journal = `${name}.pending`;
  const finish = async (pending: z.infer<typeof PendingAppendSchema>) => {
    const tail = await files.readAfter(sessionId, name, pending.bytes);
    const intended = new TextEncoder().encode(pending.text);
    if (!tail.subarray(0, intended.length).every((byte, index) => byte === intended[index])) {
      throw new Error(`inconsistent append tail: ${name}`);
    }
    await files.appendSynced(sessionId, name, intended.subarray(tail.length));
    await files.remove(sessionId, journal);
  };
  const interrupted = await files.read(sessionId, journal);
  if (interrupted !== undefined) await finish(PendingAppendSchema.parse(JSON.parse(interrupted)));
  const tailBytes = await files.readAfter(sessionId, name, cursor.bytes);
  const tail = new TextDecoder('utf-8', { fatal: true }).decode(tailBytes);
  if (tail !== '' && !tail.endsWith('\n')) throw new Error(`incomplete append tail: ${name}`);
  const replay = tail === '' ? [] : tail.slice(0, -1).split('\n');
  // Validate recovery data before advancing the cursor. The record schema belongs to the caller.
  for (const line of replay) JSON.parse(line);
  const unmatched = [...replay];
  const added = records
    .map(record => JSON.stringify(record))
    .filter(line => {
      const matched = unmatched.indexOf(line);
      if (matched < 0) return true;
      unmatched.splice(matched, 1);
      return false;
    });
  const bytes = cursor.bytes + tailBytes.length;
  const text = added.length === 0 ? '' : `${added.join('\n')}\n`;
  if (text !== '') {
    const pending = { bytes, text };
    await files.writeAtomic(sessionId, journal, JSON.stringify(pending));
    await finish(pending);
  }
  return { bytes: bytes + new TextEncoder().encode(text).length, count: cursor.count + replay.length + added.length };
}
