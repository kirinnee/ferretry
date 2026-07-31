import { describe, it } from 'bun:test';
import should from 'should';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import {
  DaemonDraftStore,
  DRAFTS_KEY,
  DRAFTS_VERSION,
  type DraftStorage,
  emptyDraftStore,
  evictDraftLru,
  MAX_DRAFT_LEN,
  MAX_DRAFTS,
  parseDraftStore,
  removeDaemonDrafts,
  removeDraft,
  upsertDraft,
} from '../../src/lib/drafts.ts';

const daemonA = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceToken: 'token-a' });
const daemonB = daemonConnection({ daemonId: 'daemon-b', baseUrl: 'https://b.example.test', deviceToken: 'token-b' });
const scopeA = daemonSessionScope(daemonA, 'same-session');
const scopeB = daemonSessionScope(daemonB, 'same-session');

class MemoryStorage implements DraftStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

describe('daemon-scoped drafts', () => {
  it('should discard malformed, legacy, and invalid entries when parsing', () => {
    should(parseDraftStore(null)).deepEqual(emptyDraftStore());
    should(parseDraftStore('{')).deepEqual(emptyDraftStore());
    should(parseDraftStore(JSON.stringify({ v: DRAFTS_VERSION + 1, drafts: {} }))).deepEqual(emptyDraftStore());
    should(parseDraftStore(JSON.stringify({ v: DRAFTS_VERSION, drafts: 1 }))).deepEqual(emptyDraftStore());

    const parsed = parseDraftStore(
      JSON.stringify({
        v: DRAFTS_VERSION,
        drafts: {
          good: { text: 'keep', at: 1 },
          blank: { text: ' ', at: 2 },
          badTime: { text: 'no', at: Number.NaN },
          badEntry: 'no',
        },
      }),
    );
    should(parsed.drafts).deepEqual({ good: { text: 'keep', at: 1 } });
  });

  it('should retain drafts by full daemon/session scope, not session ID alone', () => {
    let store = upsertDraft(emptyDraftStore(), scopeA, 'from a', 1);
    store = upsertDraft(store, scopeB, 'from b', 2);

    should(
      Object.values(store.drafts)
        .map(entry => entry.text)
        .sort(),
    ).deepEqual(['from a', 'from b']);
    should(removeDraft(store, scopeA)).not.equal(store);
    const empty = emptyDraftStore();
    should(removeDraft(empty, scopeA)).equal(empty);
  });

  it('should remove every draft for one daemon while preserving other and unknown keys', () => {
    let store = upsertDraft(emptyDraftStore(), scopeA, 'a', 1);
    store = upsertDraft(store, daemonSessionScope(daemonA, 'another'), 'a2', 2);
    store = upsertDraft(store, scopeB, 'b', 3);
    store = { ...store, drafts: { ...store.drafts, malformed: { text: 'unknown', at: 4 } } };

    const cleared = removeDaemonDrafts(store, daemonA.daemonId);

    should(Object.values(cleared.drafts).map(entry => entry.text)).deepEqual(['b', 'unknown']);
    should(removeDaemonDrafts(cleared, daemonA.daemonId)).equal(cleared);
  });

  it('should drop blank and oversized drafts and keep the newest entries within the LRU cap', () => {
    const seeded = upsertDraft(emptyDraftStore(), scopeA, 'saved', 1);
    should(upsertDraft(seeded, scopeA, ' ', 2).drafts).deepEqual({});
    should(upsertDraft(seeded, scopeA, 'x'.repeat(MAX_DRAFT_LEN + 1), 2).drafts).deepEqual({});

    let store = emptyDraftStore();
    for (let index = 0; index < MAX_DRAFTS + 1; index++) {
      store = upsertDraft(store, daemonSessionScope(daemonA, `session-${index}`), String(index), index);
    }
    should(Object.keys(store.drafts)).have.length(MAX_DRAFTS);
    should(Object.values(store.drafts).map(entry => entry.text)).not.containEql('0');
    should(evictDraftLru(store, MAX_DRAFTS)).equal(store);
  });

  it('should load, save, and clear only the requested daemon scope', () => {
    const storage = new MemoryStorage();
    const drafts = new DaemonDraftStore(storage);
    drafts.save(scopeA, 'a', 1);
    drafts.save(scopeB, 'b', 2);

    should(drafts.load(scopeA)).equal('a');
    should(drafts.load(scopeB)).equal('b');
    drafts.clear(scopeA);
    should(drafts.load(scopeA)).equal('');
    should(drafts.load(scopeB)).equal('b');
    drafts.clear(scopeA);
    drafts.save(daemonSessionScope(daemonA, 'another'), 'a2', 3);
    drafts.clearDaemon(daemonA.daemonId);
    should(drafts.load(daemonSessionScope(daemonA, 'another'))).equal('');
    should(drafts.load(scopeB)).equal('b');
    drafts.clearDaemon(daemonA.daemonId);
  });

  it('should tolerate unavailable storage and retry writes after pruning', () => {
    const unavailable: DraftStorage = {
      getItem: () => {
        throw new Error('unavailable');
      },
      setItem: () => {
        throw new Error('unavailable');
      },
    };
    const unavailableDrafts = new DaemonDraftStore(unavailable);
    should(unavailableDrafts.load(scopeA)).equal('');
    unavailableDrafts.save(scopeA, 'ignored', 1);
    unavailableDrafts.clear(scopeA);
    unavailableDrafts.clearDaemon(daemonA.daemonId);

    let seeded = emptyDraftStore();
    for (let index = 1; index <= 4; index += 1)
      seeded = upsertDraft(seeded, daemonSessionScope(daemonB, `old-${index}`), `old-${index}`, index);
    const attempts: number[] = [];
    let saved = emptyDraftStore();
    const retrying: DraftStorage = {
      getItem: () => JSON.stringify(seeded),
      setItem: (_key, value) => {
        const candidate = parseDraftStore(value);
        const count = Object.keys(candidate.drafts).length;
        attempts.push(count);
        if (count > 2) throw new Error('quota');
        saved = candidate;
      },
    };
    new DaemonDraftStore(retrying).save(scopeA, 'retried', 5);
    should(attempts).deepEqual([5, 4, 3, 2]);
    should(Object.values(saved.drafts).map(entry => entry.text)).deepEqual(['retried', 'old-4']);
    should(DRAFTS_KEY).equal('fy-drafts-v1');
  });
});
