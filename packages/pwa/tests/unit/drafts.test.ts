import { describe, it } from 'bun:test';
import should from 'should';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import {
  DRAFTS_KEY,
  DRAFTS_VERSION,
  MAX_DRAFTS,
  MAX_DRAFT_LEN,
  DaemonDraftStore,
  emptyDraftStore,
  evictDraftLru,
  parseDraftStore,
  removeDraft,
  upsertDraft,
  type DraftStorage,
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

    const retrying: DraftStorage = {
      getItem: () => null,
      setItem: (() => {
        let attempts = 0;
        return (_key: string, value: string): void => {
          attempts += 1;
          if (attempts === 1) throw new Error('quota');
          should(Object.keys(parseDraftStore(value).drafts)).have.length(1);
        };
      })(),
    };
    new DaemonDraftStore(retrying).save(scopeA, 'retried', 1);
    should(DRAFTS_KEY).equal('fy-drafts-v1');
  });
});
