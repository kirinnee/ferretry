import type { BoundTranscriptReader, TranscriptEntry } from '@ferretry/core-ferrets/contract';
import { exportEntries, type SessionExport } from './session-export.ts';

/** Each measured small export took ~450ms; polling is deliberately no faster than once every three seconds. */
const POLL_MS = 3000;

export interface ExportReaderPorts {
  snapshot(): Promise<SessionExport>;
  /** Mask text AND structured tool data before handing an entry outside this reader. */
  mask(entry: TranscriptEntry): Promise<TranscriptEntry>;
  nowMs(): number;
  wait(ms: number, signal: AbortSignal): Promise<void>;
}

/** One reader belongs to one private home/session. Concurrent readers share an export, never a cross-home cache. */
export function exportReader(ports: ExportReaderPorts): BoundTranscriptReader {
  let cached: readonly TranscriptEntry[] | undefined;
  let readAt = -Infinity;
  let pending: Promise<readonly TranscriptEntry[]> | undefined;
  const raw = async (): Promise<readonly TranscriptEntry[]> => {
    if (cached !== undefined && ports.nowMs() - readAt < POLL_MS) return cached;
    pending ??= (async () => {
      const snapshot = await ports.snapshot();
      const entries = exportEntries(snapshot);
      cached = entries;
      readAt = ports.nowMs();
      return entries;
    })().finally(() => {
      pending = undefined;
    });
    return await pending;
  };
  // A Vault value registered after the previous export must be masked on this read too.
  const read = async () => Promise.all((await raw()).map(entry => ports.mask(entry)));
  return {
    async read(after, limit) {
      const entries = await read();
      const cursor = after === undefined ? -1 : entries.findIndex(entry => entry.id === after);
      if (after !== undefined && cursor === -1) return [];
      const remaining = entries.slice(cursor + 1);
      return limit === undefined ? remaining : remaining.slice(0, Math.max(0, Math.floor(limit)));
    },
    async find(id) {
      return (await read()).find(entry => entry.id === id);
    },
    async *follow(signal) {
      const seen = new Set<string>();
      while (!signal.aborted) {
        for (const entry of await read()) {
          if (signal.aborted) return;
          if (seen.has(entry.id)) continue;
          seen.add(entry.id);
          yield entry;
        }
        if (signal.aborted) return;
        try {
          await ports.wait(POLL_MS, signal);
        } catch (error) {
          if (!signal.aborted) throw error;
        }
      }
    },
  };
}
