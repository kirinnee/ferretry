import { describe, expect, it } from 'bun:test';
import type { TranscriptProvenance } from '@ferretry/protocol';
import {
  StorageTranscriptProvenanceStore,
  storedTranscriptProvenance,
} from '../../../../src/adapters/session/transcript/storage-transcript-provenance.ts';
import { DaemonStorage } from '../../../../src/adapters/storage/session-storage.ts';
import { KeyedSerialExecutor } from '../../../../src/adapters/system/keyed-serial-executor.ts';
import { createFoundationPaths } from '../../../../src/lib/paths.ts';
import { parseSessionId } from '../../../../src/lib/session-id.ts';
import { SessionTranscriptResolver } from '../../../../src/lib/session/transcript/resolver.ts';

const ID = parseSessionId('baseline-1');
const NOW = '2026-11-06T12:00:00.000Z';
const provenance: TranscriptProvenance = {
  v: 1,
  home: '/codex',
  identity: 'correlated',
  harnessSessionId: 'mine',
  file: '/mine.jsonl',
  correlationToken: '/session',
  resolvedAt: NOW,
  baseline: ['old'],
};

/** In-memory document/index ports; the actual storage lock, CAS and publication paths run unchanged. */
function fixture(archived = false) {
  let config = { id: ID, transcript: provenance };
  let writes = 0;
  let syncs = 0;
  const rows = new Map<string, unknown>(archived ? [] : [[ID, { id: ID }]]);
  const storage = new DaemonStorage(
    createFoundationPaths('/unused' as never),
    {
      writeTextAtomic: async (_path: string, text: string) => {
        writes++;
        config = JSON.parse(text);
      },
    } as never,
    {
      findSession: (id: string) => rows.get(id),
      listSessions: () => [...rows.values()],
    } as never,
    { now: () => NOW },
    new KeyedSerialExecutor(),
    {} as never,
  );
  const internals = storage as unknown as {
    archived: Map<string, unknown>;
    readDocument: () => Promise<unknown>;
    ensureSessionDirectory: () => Promise<void>;
    syncSessionUnlocked: () => Promise<void>;
  };
  if (archived) internals.archived.set(ID, { indexed: { id: ID }, archivedAt: NOW });
  storage.readConfig = async () => config;
  internals.readDocument = async () => config;
  internals.ensureSessionDirectory = async () => {};
  internals.syncSessionUnlocked = async () => {
    syncs++;
    rows.set(ID, { id: ID });
  };
  const store = new StorageTranscriptProvenanceStore(storage);
  const resolver = new SessionTranscriptResolver({ candidates: async () => [] }, { claimed: async () => [] }, store, {
    now: () => NOW,
  });
  return { storage, store, resolver, counts: () => ({ writes, syncs, configWrites: storage.configWrites() }) };
}

describe('baseline maintenance publication', () => {
  it('leaves an archived correlated transcript readable without reviving it into the live index', async () => {
    const { storage, resolver, counts } = fixture(true);
    const before = storage.listSessions();
    expect(await resolver.file(ID, provenance)).toBe('/mine.jsonl');
    expect(storage.isArchived(ID)).toBe(true);
    expect(storage.listSessions()).toEqual(before);
    expect(storedTranscriptProvenance(await storage.readConfig(ID))?.baseline).toEqual(['old']);
    expect(counts()).toEqual({ writes: 0, syncs: 0, configWrites: 0 });
  });

  it('publishes one retirement while concurrent and repeated readers publish nothing', async () => {
    const { storage, resolver, counts } = fixture();
    await Promise.all(Array.from({ length: 8 }, () => resolver.file(ID, provenance)));
    await resolver.file(ID, storedTranscriptProvenance(await storage.readConfig(ID)));
    expect(counts()).toEqual({ writes: 1, syncs: 1, configWrites: 1 });
  });

  it('does not publish a rejected CAS after a relaunch replaced the evidence', async () => {
    const { storage, store, counts } = fixture();
    const next = { ...provenance, correlationToken: '/new' };
    await storage.updateConfig(ID, current => ({ ...(current as object), transcript: next }));
    const before = counts();
    await store.record(ID, { ...provenance, baseline: undefined }, provenance);
    expect(counts()).toEqual(before);
    expect(storedTranscriptProvenance(await storage.readConfig(ID))).toEqual(next);
  });
});
