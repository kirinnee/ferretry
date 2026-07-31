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
        if (count > 4) throw new Error('quota');
        saved = candidate;
      },
    };
    new DaemonDraftStore(retrying).save(scopeA, 'retried', 5);
    should(attempts).deepEqual([5, 2, 3, 4]);
    should(Object.values(saved.drafts).map(entry => entry.text)).deepEqual(['retried', 'old-4', 'old-3', 'old-2']);
    should(DRAFTS_KEY).equal('fy-drafts-v1');
  });

  it('should retain more than ten drafts when only the oldest entry overflows the quota', () => {
    let seeded = emptyDraftStore();
    for (let index = 1; index <= 11; index += 1)
      seeded = upsertDraft(seeded, daemonSessionScope(daemonB, `old-${index}`), `old-${index}`, index);
    const attempts: number[] = [];
    let saved = emptyDraftStore();
    const retrying: DraftStorage = {
      getItem: () => JSON.stringify(seeded),
      setItem: (_key, value) => {
        const candidate = parseDraftStore(value);
        const count = Object.keys(candidate.drafts).length;
        attempts.push(count);
        if (count > 11) throw new Error('quota');
        saved = candidate;
      },
    };
    new DaemonDraftStore(retrying).save(scopeA, 'retried', 12);

    // the full 12-entry document overflows; the search keeps the 11 newest, above the old fixed cap of 10
    should(attempts).deepEqual([12, 6, 9, 10, 11]);
    should(Object.keys(saved.drafts)).have.length(11);
    should(Object.values(saved.drafts).map(entry => entry.text)).deepEqual([
      'retried',
      'old-11',
      'old-10',
      'old-9',
      'old-8',
      'old-7',
      'old-6',
      'old-5',
      'old-4',
      'old-3',
      'old-2',
    ]);
  });

  it('should preserve a previously persisted draft when the newest draft alone overflows the quota', () => {
    const persisted = upsertDraft(emptyDraftStore(), scopeA, 'good', 1);
    const persistedJson = JSON.stringify(persisted);
    // Quota admits the persisted good store but rejects any document holding the oversized draft;
    // the oversized text stays within MAX_DRAFT_LEN so upsertDraft keeps rather than drops it.
    const quota = persistedJson.length + 32;
    const oversized = 'x'.repeat(quota);

    const attempts: number[] = [];
    let value = persistedJson;
    const overflowing: DraftStorage = {
      getItem: () => value,
      setItem: (_key, candidate) => {
        attempts.push(Object.keys(parseDraftStore(candidate).drafts).length);
        if (candidate.length > quota) throw new Error('quota');
        value = candidate;
      },
    };
    const drafts = new DaemonDraftStore(overflowing);

    should(() => drafts.save(scopeB, oversized, 2)).not.throw();
    // the full two-entry document (2) and the lone oversized draft (1) both overflow; the empty
    // document is never tried, so the previously persisted good draft survives untouched
    should(attempts).deepEqual([2, 1]);
    should(attempts).not.containEql(0);
    should(drafts.load(scopeA)).equal('good');
    should(overflowing.getItem(DRAFTS_KEY)).equal(persistedJson);
  });

  it('should never attempt the empty document when every non-empty fallback overflows the quota', () => {
    let seeded = emptyDraftStore();
    for (let index = 1; index <= 11; index += 1)
      seeded = upsertDraft(seeded, daemonSessionScope(daemonB, `old-${index}`), `old-${index}`, index);
    const attempts: number[] = [];
    const alwaysOver: DraftStorage = {
      getItem: () => JSON.stringify(seeded),
      setItem: (_key, value) => {
        const candidate = parseDraftStore(value);
        attempts.push(Object.keys(candidate.drafts).length);
        throw new Error('quota');
      },
    };
    const drafts = new DaemonDraftStore(alwaysOver);

    should(() => drafts.save(scopeA, 'retried', 12)).not.throw();
    // the full document (12), then binary-search probes 6, 3, and 1; retained = 0 is never tried,
    // so a quota that rejects every non-empty candidate cannot erase what is already persisted
    should(attempts).deepEqual([12, 6, 3, 1]);
    should(attempts).not.containEql(0);
  });
});
