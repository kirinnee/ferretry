import type { AskSummary, AsksApi } from '@ferretry/core-asks/contract';
import { instantMs, type RawWork, askKey } from '../lib/documents.ts';
import type { WorkSource } from '../lib/service.ts';

/** Where an ask stands, in the words the Inbox uses. */
const standing = (ask: AskSummary): string =>
  ask.state === 'open' ? 'open' : ask.state === 'answered' ? 'answered' : 'closed';

/** An ask as work: its subject is all Conversation may know of it (the source owns the rest). */
const asWork = (ask: AskSummary): RawWork => ({
  key: askKey(ask.id),
  kind: 'ask',
  updatedAtMs: instantMs(ask.raisedAt),
  identity: {
    kind: 'ask',
    id: ask.id,
    ferret: ask.ferret ?? 'owner',
    title: ask.subject,
    state: ask.state === 'open' ? 'open' : 'closed',
    standing: standing(ask),
    updatedAt: ask.raisedAt,
  },
  fields: [
    ['id', ask.id],
    ['title', ask.subject],
  ],
});

/**
 * The asks as a work source, read through the Asks port. The port hands back a fresh summary each time, so a piece of
 * work is kept as the same object while its summary reads the same: the service re-indexes by identity.
 */
export function asksSource(asks: Pick<AsksApi, 'open'>): WorkSource {
  const kept = new Map<string, { readonly signature: string; readonly work: RawWork }>();
  return {
    id: 'asks',
    list: async () => {
      const listed = (
        await Promise.all((['open', 'answered', 'closed'] as const).map(state => asks.open({ state })))
      ).flat();
      const present = new Set<string>();
      const works = listed.map(ask => {
        const work = asWork(ask);
        const signature = JSON.stringify(ask);
        const before = kept.get(work.key);
        present.add(work.key);
        if (before?.signature === signature) return before.work;
        kept.set(work.key, { signature, work });
        return work;
      });
      for (const key of [...kept.keys()]) if (!present.has(key)) kept.delete(key);
      return works;
    },
  };
}
