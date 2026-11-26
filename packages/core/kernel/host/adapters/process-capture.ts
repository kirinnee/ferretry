export const ABANDONED = Symbol('abandoned');

/** A hard byte cap: stop the child and both readers on overflow or cancellation. */
export async function readCapped(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  abandoned: Promise<typeof ABANDONED>,
  stop: () => void,
): Promise<{ readonly bytes: Uint8Array; readonly truncated: boolean }> {
  const chunks: Uint8Array[] = [];
  let keptBytes = 0;
  let truncated = false;
  let abandonedRead = false;
  const reader = stream.getReader();
  try {
    while (true) {
      const result = await Promise.race([reader.read(), abandoned]);
      if (result === ABANDONED) {
        abandonedRead = true;
        break;
      }
      if (result.done) break;
      const chunk = result.value;
      // Copy the prefix: even a short view must never retain an oversized backing buffer.
      const kept = chunk.slice(0, Math.min(maxBytes - keptBytes, chunk.byteLength));
      if (kept.byteLength > 0) chunks.push(kept);
      keptBytes += kept.byteLength;
      if (kept.byteLength < chunk.byteLength) {
        truncated = true;
        abandonedRead = true;
        stop();
        break;
      }
    }
  } finally {
    if (abandonedRead) await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(keptBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, truncated };
}
