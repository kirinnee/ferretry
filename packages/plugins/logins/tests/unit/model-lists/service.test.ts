import { describe, it } from 'bun:test';
import should from 'should';
import type { Instant } from '@ferretry/std';
import {
  MODEL_LIST_FAILED_COOLDOWN_MS,
  MODEL_LIST_FORCE_COOLDOWN_MS,
  MODEL_LIST_FRESH_MS,
  type ModelListView,
} from '../../../contract/model-list.ts';
import { type ModelListRead, ModelListService, type ModelListStore } from '../../../daemon/lib/model-lists/service.ts';

const HOUR = 60 * 60 * 1_000;
const START = Date.parse('2026-11-23T00:00:00.000Z');

/** DeepSeek's documented `GET /models` example. */
const DEEPSEEK = {
  object: 'list',
  data: [
    { id: 'deepseek-chat', object: 'model', owned_by: 'deepseek' },
    { id: 'deepseek-reasoner', object: 'model', owned_by: 'deepseek' },
  ],
};

class MemoryStore implements ModelListStore {
  readonly lists = new Map<string, ModelListView>();
  failWrites = false;
  async read(loginId: string) {
    return this.lists.get(loginId);
  }
  async write(loginId: string, list: ModelListView) {
    if (this.failWrites) throw new Error('disk full');
    this.lists.set(loginId, list);
  }
  async remove(loginId: string) {
    this.lists.delete(loginId);
  }
  async logins() {
    return [...this.lists.keys()];
  }
}

function world(answers: (ModelListRead | undefined | Error)[] = []) {
  const store = new MemoryStore();
  const asked: string[] = [];
  const changed: number[] = [];
  let at = START;
  let hold: Promise<void> | undefined;
  /** The in-effect revision of each login; a login in `gone` is no longer on this machine. */
  const revisions = new Map<string, string>();
  const gone = new Set<string>();
  const service = new ModelListService({
    store,
    now: () => new Date(at).toISOString() as Instant,
    nowMs: () => at,
    revision: id => (gone.has(id) ? undefined : (revisions.get(id) ?? 'r1')),
    read: async id => {
      asked.push(id);
      await hold;
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    onChanged: async () => {
      changed.push(at);
    },
  });
  return {
    service,
    store,
    asked,
    changed,
    /** The login's file changed in effect: what is read from now on is of a new revision. */
    edit: (id: string, revision: string) => {
      revisions.set(id, revision);
    },
    /** The login is gone from this machine. */
    remove: (id: string) => {
      gone.add(id);
    },
    /** The login is back (a re-add of the same name). */
    restore: (id: string) => {
      gone.delete(id);
    },
    advance: (ms: number) => {
      at += ms;
    },
    holdReads: () => {
      let release = () => {};
      hold = new Promise<void>(resolve => {
        release = resolve;
      });
      return release;
    },
  };
}

const listed = (payload: unknown): ModelListRead => ({ kind: 'listed', payload });

describe('ModelListService', () => {
  it('should read nothing until somebody asks: there is no timer', async () => {
    // Arrange
    const { service, asked, advance } = world([listed(DEEPSEEK)]);

    // Act
    advance(10 * 24 * HOUR);

    // Assert
    should(asked).eql([]);
    should(await service.held('deepseek')).be.undefined();
    should(await service.all()).eql({});
  });

  it('should keep the ids of a first read, stamped with when it was read', async () => {
    // Arrange
    const { service, store, changed } = world([listed(DEEPSEEK)]);

    // Act
    const actual = await service.refresh('deepseek');

    // Assert
    const expected: ModelListView = {
      fetchedAt: '2026-11-23T00:00:00.000Z' as Instant,
      complete: true,
      ids: ['deepseek-chat', 'deepseek-reasoner'],
    };
    should(actual).eql({ loginId: 'deepseek', outcome: 'refreshed', list: expected });
    should(store.lists.get('deepseek')).eql(expected);
    should(changed).have.length(1);
  });

  it('should answer from the held list, and send nothing, while it is under 24 hours old', async () => {
    // Arrange
    const { service, asked, advance } = world([listed(DEEPSEEK)]);
    await service.refresh('deepseek');
    advance(MODEL_LIST_FRESH_MS - 1);

    // Act
    const actual = await service.refresh('deepseek');

    // Assert
    should(actual.outcome).equal('current');
    should(actual.list?.ids).eql(['deepseek-chat', 'deepseek-reasoner']);
    should(asked).have.length(1);
  });

  it('should read again once the held list is 24 hours old', async () => {
    // Arrange
    const { service, asked, advance } = world([listed(DEEPSEEK), listed(DEEPSEEK)]);
    await service.refresh('deepseek');
    advance(MODEL_LIST_FRESH_MS);

    // Act
    const actual = await service.refresh('deepseek');

    // Assert
    should(actual.outcome).equal('refreshed');
    should(actual.list?.fetchedAt).equal('2026-11-24T00:00:00.000Z');
    should(asked).have.length(2);
  });

  it('should read at once on "Refresh list" however fresh the list is', async () => {
    // Arrange
    const { service, asked, advance } = world([listed(DEEPSEEK), listed(DEEPSEEK)]);
    await service.refresh('deepseek');
    advance(MODEL_LIST_FORCE_COOLDOWN_MS);

    // Act
    const actual = await service.refresh('deepseek', { force: true });

    // Assert
    should(actual.outcome).equal('refreshed');
    should(asked).have.length(2);
  });

  it('should not announce a change when the ids are the same', async () => {
    // Arrange
    const { service, changed, advance } = world([
      listed(DEEPSEEK),
      listed(DEEPSEEK),
      listed({ object: 'list', data: [{ id: 'deepseek-chat' }] }),
    ]);
    await service.refresh('deepseek');

    // Act
    advance(HOUR);
    await service.refresh('deepseek', { force: true });
    advance(HOUR);
    await service.refresh('deepseek', { force: true });

    // Assert
    should(changed).have.length(2);
  });

  it('should share one request between callers that arrive while a read is under way', async () => {
    // Arrange: three pickers mount at once.
    const { service, asked, holdReads } = world([listed(DEEPSEEK)]);
    const release = holdReads();

    // Act
    const reads = [
      service.refresh('deepseek'),
      service.refresh('deepseek'),
      service.refresh('deepseek', { force: true }),
    ];
    release();
    const outcomes = await Promise.all(reads);

    // Assert
    should(asked).have.length(1);
    should(outcomes.map(outcome => outcome.outcome)).eql(['refreshed', 'refreshed', 'refreshed']);
  });

  it('should not share a request between two logins', async () => {
    // Arrange
    const { service, asked } = world([listed(DEEPSEEK), listed(DEEPSEEK)]);

    // Act
    await Promise.all([service.refresh('one'), service.refresh('two')]);

    // Assert
    should(asked.toSorted()).eql(['one', 'two']);
  });

  it('should keep the last list when the provider gave none (down, 4xx, 5xx): that is an answer, not an error', async () => {
    // Arrange
    const { service, store, advance } = world([listed(DEEPSEEK), { kind: 'none' }]);
    await service.refresh('deepseek');
    const before = store.lists.get('deepseek');
    advance(MODEL_LIST_FORCE_COOLDOWN_MS);

    // Act
    const actual = await service.refresh('deepseek', { force: true });

    // Assert
    should(actual.outcome).equal('kept');
    should(actual.list).eql(before);
    should(store.lists.get('deepseek')).eql(before);
  });

  it('should never store a body that is not a model list, and keep the last list', async () => {
    // Arrange
    const { service, store, advance } = world([
      listed(DEEPSEEK),
      listed({ error: { message: 'nope' } }),
      listed({ data: [] }),
      listed('<html>gateway</html>'),
    ]);
    await service.refresh('deepseek');
    const before = store.lists.get('deepseek');

    // Act
    advance(MODEL_LIST_FORCE_COOLDOWN_MS);
    const outcomes = [await service.refresh('deepseek', { force: true })];
    advance(MODEL_LIST_FORCE_COOLDOWN_MS);
    outcomes.push(await service.refresh('deepseek', { force: true }));
    advance(MODEL_LIST_FORCE_COOLDOWN_MS);
    outcomes.push(await service.refresh('deepseek', { force: true }));

    // Assert
    should(outcomes.map(outcome => outcome.outcome)).eql(['kept', 'kept', 'kept']);
    should(store.lists.get('deepseek')).eql(before);
  });

  it('should keep the last list, and not throw, when the read itself fails', async () => {
    // Arrange
    const { service, store, advance } = world([listed(DEEPSEEK), new Error('socket hang up')]);
    await service.refresh('deepseek');
    const before = store.lists.get('deepseek');
    advance(MODEL_LIST_FORCE_COOLDOWN_MS);

    // Act
    const actual = await service.refresh('deepseek', { force: true });

    // Assert
    should(actual.outcome).equal('kept');
    should(store.lists.get('deepseek')).eql(before);
  });

  it('should say "unavailable" for a login that has no way to list models, and keep none', async () => {
    // Arrange
    const { service, store } = world([undefined]);

    // Act
    const actual = await service.refresh('claude-sign-in');

    // Assert
    should(actual).eql({ loginId: 'claude-sign-in', outcome: 'unavailable' });
    should(store.lists.size).equal(0);
  });

  it('should answer "kept" with no list when the first read finds nothing usable', async () => {
    // Arrange
    const { service } = world([{ kind: 'none' }]);

    // Act
    const actual = await service.refresh('deepseek');

    // Assert
    should(actual).eql({ loginId: 'deepseek', outcome: 'kept' });
  });

  it('should keep the ids of the reply a Test already read, and leave the list alone for a reply that is not one', async () => {
    // Arrange
    const { service, store, asked } = world();

    // Act
    await service.record('deepseek', DEEPSEEK);
    const first = store.lists.get('deepseek');
    await service.record('deepseek', { data: { balance: 3 } });

    // Assert
    should(first?.ids).eql(['deepseek-chat', 'deepseek-reasoner']);
    should(store.lists.get('deepseek')).eql(first);
    should(asked).eql([]);
  });

  it('should keep the last list, and not throw, when a list cannot be written', async () => {
    // Arrange
    const { service, store, advance } = world([listed(DEEPSEEK), listed(DEEPSEEK)]);
    await service.refresh('deepseek');
    const before = store.lists.get('deepseek');
    store.failWrites = true;
    advance(MODEL_LIST_FORCE_COOLDOWN_MS);

    // Act
    const refreshed = await service.refresh('deepseek', { force: true });
    await service.record('deepseek', DEEPSEEK);

    // Assert
    should(refreshed.outcome).equal('kept');
    should(store.lists.get('deepseek')).eql(before);
  });

  it('should drop a login’s list with the login', async () => {
    // Arrange
    const { service, store } = world([listed(DEEPSEEK)]);
    await service.refresh('deepseek');

    // Act
    await service.forget('deepseek');

    // Assert
    should(store.lists.size).equal(0);
    should(await service.all()).eql({});
  });

  it('should hold only ids: no key, name, owner or body is in a stored list', async () => {
    // Arrange
    const secret = 'sk-test-not-a-real-key-0000';
    const { service, store } = world([
      listed({
        object: 'list',
        data: [{ id: 'deepseek-chat', object: 'model', owned_by: 'deepseek', api_key: secret, note: secret }],
        echo: { authorization: `Bearer ${secret}` },
      }),
    ]);

    // Act
    const actual = await service.refresh('deepseek');

    // Assert
    const everything = JSON.stringify([actual, [...store.lists.entries()]]);
    should(everything).not.containEql(secret);
    should(Object.keys(store.lists.get('deepseek') as object).toSorted()).eql(['complete', 'fetchedAt', 'ids']);
  });

  it('should read a list that is stale by its clock, and a held list from the future as stale', () => {
    // Arrange
    const { service } = world();
    const at = (ms: number): ModelListView => ({
      fetchedAt: new Date(START + ms).toISOString() as Instant,
      complete: true,
      ids: ['a'],
    });

    // Assert
    should(service.isStale(undefined)).be.true();
    should(service.isStale(at(0))).be.false();
    should(service.isStale(at(-MODEL_LIST_FRESH_MS + 1))).be.false();
    should(service.isStale(at(-MODEL_LIST_FRESH_MS))).be.true();
    should(service.isStale(at(HOUR))).be.true();
  });
});

const OLD_KEY_LIST = { object: 'list', data: [{ id: 'old-key-model' }] };
const NEW_KEY_LIST = { object: 'list', data: [{ id: 'new-key-model' }] };

describe('ModelListService attempt cooldown', () => {
  it('should send one request for twenty rapid "Refresh list" presses', async () => {
    // Arrange
    const { service, asked } = world(Array.from({ length: 20 }, () => listed(DEEPSEEK)));

    // Act
    const outcomes: string[] = [];
    for (let press = 0; press < 20; press += 1) {
      outcomes.push((await service.refresh('deepseek', { force: true })).outcome);
    }

    // Assert
    should(asked).have.length(1);
    should(outcomes[0]).equal('refreshed');
    should(outcomes.slice(1).every(outcome => outcome === 'cooling')).be.true();
  });

  it('should answer a cooling press with the held list, so the picker still has one', async () => {
    // Arrange
    const { service } = world([listed(DEEPSEEK)]);
    await service.refresh('deepseek', { force: true });

    // Act
    const actual = await service.refresh('deepseek', { force: true });

    // Assert
    should(actual.outcome).equal('cooling');
    should(actual.list?.ids).eql(['deepseek-chat', 'deepseek-reasoner']);
  });

  it('should send one request for twenty rapid presses when the provider is down, too', async () => {
    // Arrange: a failed read leaves no list, so nothing is fresh and every press is "due".
    const { service, asked } = world(Array.from({ length: 20 }, () => ({ kind: 'none' }) as ModelListRead));

    // Act
    for (let press = 0; press < 20; press += 1) await service.refresh('deepseek', { force: true });

    // Assert
    should(asked).have.length(1);
  });

  it('should allow "Refresh list" again once a minute has passed since the last attempt, not before', async () => {
    // Arrange
    const { service, asked, advance } = world([listed(DEEPSEEK), listed(DEEPSEEK)]);
    await service.refresh('deepseek', { force: true });

    // Act
    advance(MODEL_LIST_FORCE_COOLDOWN_MS - 1);
    const early = await service.refresh('deepseek', { force: true });
    advance(1);
    const due = await service.refresh('deepseek', { force: true });

    // Assert
    should(early.outcome).equal('cooling');
    should(due.outcome).equal('refreshed');
    should(asked).have.length(2);
  });

  it('should leave a stale list alone for 15 minutes after a plain read of it failed', async () => {
    // Arrange: the list is a day old and the provider is down.
    const { service, asked, advance } = world([listed(DEEPSEEK), { kind: 'none' }, listed(DEEPSEEK)]);
    await service.refresh('deepseek');
    advance(MODEL_LIST_FRESH_MS);
    await service.refresh('deepseek'); // fails

    // Act
    advance(MODEL_LIST_FAILED_COOLDOWN_MS - 1);
    const early = await service.refresh('deepseek');
    advance(1);
    const due = await service.refresh('deepseek');

    // Assert
    should(early.outcome).equal('cooling');
    should(due.outcome).equal('refreshed');
    should(asked).have.length(3);
  });

  it('should not let a plain picker read follow a failed "Refresh list" within 15 minutes', async () => {
    // Arrange
    const { service, asked, advance } = world([{ kind: 'none' }, listed(DEEPSEEK)]);
    await service.refresh('deepseek', { force: true });

    // Act
    advance(MODEL_LIST_FORCE_COOLDOWN_MS);
    const plain = await service.refresh('deepseek');

    // Assert: a minute is enough for a press, not for an unprompted picker.
    should(plain.outcome).equal('cooling');
    should(asked).have.length(1);
  });

  it('should not let a plain read follow a successful one within a minute, however old the list claims to be', async () => {
    // Arrange: a held list dated in the future reads as stale, so the freshness rule alone would send every time.
    const { service, store, asked } = world([listed(DEEPSEEK), listed(DEEPSEEK)]);
    await service.refresh('deepseek');
    const held = store.lists.get('deepseek') as ModelListView;
    store.lists.set('deepseek', { ...held, fetchedAt: '2099-01-01T00:00:00.000Z' as Instant });

    // Act
    const again = await service.refresh('deepseek');

    // Assert
    should(again.outcome).equal('cooling');
    should(asked).have.length(1);
  });

  it('should send nothing, and note no attempt, for a login that has no way to list models', async () => {
    // Arrange
    const { service, asked } = world([undefined]);

    // Act
    const first = await service.refresh('claude-sign-in', { force: true });
    const second = await service.refresh('claude-sign-in', { force: true });

    // Assert: both asked the reader, which sent nothing; neither is "cooling".
    should(first.outcome).equal('unavailable');
    should(second.outcome).equal('unavailable');
    should(asked).have.length(2);
  });

  it('should give an edited login its own read at once, whatever its last attempt', async () => {
    // Arrange
    const { service, asked, edit } = world([listed(OLD_KEY_LIST), listed(NEW_KEY_LIST)]);
    await service.refresh('deepseek', { force: true });

    // Act
    edit('deepseek', 'r2');
    const actual = await service.refresh('deepseek', { force: true });

    // Assert
    should(actual.outcome).equal('refreshed');
    should(actual.list?.ids).eql(['new-key-model']);
    should(asked).have.length(2);
  });

  it('should still cool down the new revision once it has been read', async () => {
    // Arrange
    const { service, asked, edit } = world([listed(OLD_KEY_LIST), listed(NEW_KEY_LIST), listed(NEW_KEY_LIST)]);
    await service.refresh('deepseek', { force: true });
    edit('deepseek', 'r2');
    await service.refresh('deepseek', { force: true });

    // Act
    const again = await service.refresh('deepseek', { force: true });

    // Assert
    should(again.outcome).equal('cooling');
    should(asked).have.length(2);
  });
});

describe('ModelListService edits and removals under way', () => {
  it('should not mark the list fresh with a read of the key the login had before an edit', async () => {
    // Arrange: a read is on the wire with the OLD key; the person edits the key; the edit asks for its own read.
    const { service, store, asked, holdReads, edit } = world([listed(OLD_KEY_LIST), listed(NEW_KEY_LIST)]);
    const release = holdReads();
    const underWay = service.refresh('deepseek');
    edit('deepseek', 'r2');

    // Act
    const forNewKey = service.refresh('deepseek', { force: true });
    release();
    const [old, fresh] = await Promise.all([underWay, forNewKey]);

    // Assert: the edit was not coalesced into the old read, and the old reply was never kept.
    should(asked).have.length(2);
    should(old.outcome).equal('kept');
    should(fresh.outcome).equal('refreshed');
    should(store.lists.get('deepseek')?.ids).eql(['new-key-model']);
  });

  it('should keep the edited login’s list when the old read finishes last', async () => {
    // Arrange
    const { service, store, holdReads, edit } = world([listed(OLD_KEY_LIST), listed(NEW_KEY_LIST)]);
    const release = holdReads();
    const underWay = service.refresh('deepseek');
    edit('deepseek', 'r2');
    const forNewKey = service.refresh('deepseek', { force: true });

    // Act
    release();
    await forNewKey;
    await underWay;

    // Assert
    should(store.lists.get('deepseek')?.ids).eql(['new-key-model']);
  });

  it('should hold nothing from a read that was under way when the edit came, when the edit gets no read', async () => {
    // Arrange
    const { service, store, holdReads, edit } = world([listed(OLD_KEY_LIST)]);
    const release = holdReads();
    const underWay = service.refresh('deepseek');
    edit('deepseek', 'r2');

    // Act
    release();
    const actual = await underWay;

    // Assert: the next ask reads the new login rather than finding a list a day fresh.
    should(actual.outcome).equal('kept');
    should(store.lists.size).equal(0);
    should(await service.held('deepseek')).be.undefined();
  });

  it('should not write a list for a login that was removed while its read was under way', async () => {
    // Arrange
    const { service, store, changed, holdReads, remove } = world([listed(DEEPSEEK)]);
    const release = holdReads();
    const underWay = service.refresh('deepseek');

    // Act
    remove('deepseek');
    await service.forget('deepseek');
    release();
    const actual = await underWay;

    // Assert
    should(actual.outcome).equal('kept');
    should(store.lists.size).equal(0);
    should(await service.all()).eql({});
    should(changed).eql([]);
  });

  it('should not bring back a list for a login removed and added again with the same name while a read was under way', async () => {
    // Arrange: the removal and the re-add are one revision apart in nothing but time.
    const { service, store, holdReads, remove, restore } = world([listed(DEEPSEEK)]);
    const release = holdReads();
    const underWay = service.refresh('deepseek');

    // Act
    remove('deepseek');
    await service.forget('deepseek');
    restore('deepseek');
    release();
    await underWay;

    // Assert
    should(store.lists.size).equal(0);
  });

  it('should say "unavailable" and send nothing for a login this machine does not have', async () => {
    // Arrange
    const { service, asked, remove } = world([listed(DEEPSEEK)]);
    remove('deepseek');

    // Act
    const actual = await service.refresh('deepseek', { force: true });

    // Assert
    should(actual).eql({ loginId: 'deepseek', outcome: 'unavailable' });
    should(asked).eql([]);
  });

  it('should drop the reply of a Test that finished after the login was edited or removed', async () => {
    // Arrange: a Test began, then the key was edited (and later another login's Test began, then it was removed).
    const { service, store, edit, remove } = world();
    const afterEdit = service.recorder('edited');
    const afterRemoval = service.recorder('removed');
    const current = service.recorder('current');
    edit('edited', 'r2');
    remove('removed');
    await service.forget('removed');

    // Act
    await afterEdit(OLD_KEY_LIST);
    await afterRemoval(DEEPSEEK);
    await current(DEEPSEEK);

    // Assert
    should([...store.lists.keys()]).eql(['current']);
  });

  it('should give a recreated cache nothing even when the write of an old read began first', async () => {
    // Arrange: the old read's write and the removal race for the same file.
    const { service, store, holdReads, remove } = world([listed(DEEPSEEK)]);
    const release = holdReads();
    const underWay = service.refresh('deepseek');
    remove('deepseek');
    const forgotten = service.forget('deepseek');

    // Act
    release();
    await Promise.all([underWay, forgotten]);

    // Assert
    should(store.lists.size).equal(0);
  });
});
