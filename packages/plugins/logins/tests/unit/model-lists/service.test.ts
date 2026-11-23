import { describe, it } from 'bun:test';
import should from 'should';
import type { Instant } from '@ferretry/std';
import { MODEL_LIST_FRESH_MS, type ModelListView } from '../../../contract/model-list.ts';
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
  async read(loginId: string) {
    return this.lists.get(loginId);
  }
  async write(loginId: string, list: ModelListView) {
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
  const service = new ModelListService({
    store,
    now: () => new Date(at).toISOString() as Instant,
    nowMs: () => at,
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
    const { service, asked } = world([listed(DEEPSEEK), listed(DEEPSEEK)]);
    await service.refresh('deepseek');

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
    const { service, store } = world([listed(DEEPSEEK), { kind: 'none' }]);
    await service.refresh('deepseek');
    const before = store.lists.get('deepseek');

    // Act
    const actual = await service.refresh('deepseek', { force: true });

    // Assert
    should(actual.outcome).equal('kept');
    should(actual.list).eql(before);
    should(store.lists.get('deepseek')).eql(before);
  });

  it('should never store a body that is not a model list, and keep the last list', async () => {
    // Arrange
    const { service, store } = world([
      listed(DEEPSEEK),
      listed({ error: { message: 'nope' } }),
      listed({ data: [] }),
      listed('<html>gateway</html>'),
    ]);
    await service.refresh('deepseek');
    const before = store.lists.get('deepseek');

    // Act
    const outcomes = [
      await service.refresh('deepseek', { force: true }),
      await service.refresh('deepseek', { force: true }),
      await service.refresh('deepseek', { force: true }),
    ];

    // Assert
    should(outcomes.map(outcome => outcome.outcome)).eql(['kept', 'kept', 'kept']);
    should(store.lists.get('deepseek')).eql(before);
  });

  it('should keep the last list, and not throw, when the read itself fails', async () => {
    // Arrange
    const { service, store } = world([listed(DEEPSEEK), new Error('socket hang up')]);
    await service.refresh('deepseek');
    const before = store.lists.get('deepseek');

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
