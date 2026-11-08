/**
 * The lead's pack table, read for the cards in its chat. Many cards draw at once (one per Pack command in the
 * transcript), so the table is read ONCE per ferret and shared: the first card to mount starts the read and a timer, the
 * last to unmount stops them. A read that fails leaves the rows as they were (a card then says nothing live it cannot see).
 */
import { type PackRow, PackTableSchema } from '../../contract/index.ts';
import type { PacksClient } from './client.ts';

/** How often the table is read again while a card is on screen, in milliseconds. */
export const PACK_FEED_REFRESH_MS = 5_000;

export interface PackTableFeed {
  /** Joins the shared read for `ferretId`; the returned function leaves it. */
  readonly watch: (ferretId: string, onChange: () => void) => () => void;
  /** The rows last read for `ferretId`, or `undefined` before the first read lands. */
  readonly rows: (ferretId: string) => readonly PackRow[] | undefined;
}

interface Entry {
  rows: readonly PackRow[] | undefined;
  readonly listeners: Set<() => void>;
  stop: () => void;
}

export const createPackTableFeed = (
  client: PacksClient,
  every: (ms: number, run: () => void) => () => void,
): PackTableFeed => {
  const entries = new Map<string, Entry>();

  const read = async (ferretId: string, entry: Entry): Promise<void> => {
    try {
      const table = PackTableSchema.parse(
        await client.call('GET /v1/ferrets/:ferretId/pack', { params: { ferretId } }),
      );
      entry.rows = table.rows;
      for (const listener of entry.listeners) listener();
    } catch {
      // The rows stay as they were.
    }
  };

  return {
    watch: (ferretId, onChange) => {
      let entry = entries.get(ferretId);
      if (entry === undefined) {
        const created: Entry = { rows: undefined, listeners: new Set(), stop: () => undefined };
        created.stop = every(PACK_FEED_REFRESH_MS, () => void read(ferretId, created));
        void read(ferretId, created);
        entries.set(ferretId, created);
        entry = created;
      }
      entry.listeners.add(onChange);
      const joined = entry;
      return () => {
        joined.listeners.delete(onChange);
        if (joined.listeners.size === 0) {
          joined.stop();
          entries.delete(ferretId);
        }
      };
    },
    rows: ferretId => entries.get(ferretId)?.rows,
  };
};
