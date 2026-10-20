/**
 * Provider keys this device holds: sealed under a non-extractable key, never handed back, and spent
 * only on a request to their own provider's host.
 *
 * The CRYPTO is real WebCrypto — whether the wrapping key is extractable, and whether a record moved
 * between slots still opens, are the facts this module exists to get right. The records are an
 * in-memory map for the vault, and a scripted IndexedDB for the adapter, because IndexedDB does not
 * exist in this runtime. The network is a fake: nothing here leaves the process.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import {
  DeviceSpeedupKeys,
  IndexedDbSpeedupKeyRecords,
  SPEEDUP_KEY_SHAPE_SENTENCE,
  type SpeedupKeyDatabaseFactory,
  type SpeedupKeyRecords,
  SpeedupKeyShapeError,
} from '../../../src/lib/stt/speedup-keys.ts';

const GROQ_KEY = 'gsk_test_0123456789abcdefAB';
const CEREBRAS_KEY = 'csk-test-9876543210zyxwvuCD';

class MemoryRecords implements SpeedupKeyRecords {
  readonly values = new Map<string, unknown>();
  failGet = false;

  async get(slot: string): Promise<unknown> {
    if (this.failGet) throw new Error('storage blocked');
    return this.values.get(slot);
  }

  async put(slot: string, value: unknown): Promise<void> {
    this.values.set(slot, value);
  }

  async delete(slot: string): Promise<void> {
    this.values.delete(slot);
  }
}

interface Sent {
  readonly url: string;
  readonly init: RequestInit;
}

const vault = () => {
  const records = new MemoryRecords();
  const sent: Sent[] = [];
  const keys = new DeviceSpeedupKeys(records, crypto.subtle, async (url, init) => {
    sent.push({ url: String(url), init: init ?? {} });
    return Response.json({ ok: true });
  });
  return { records, sent, keys };
};

const headerOf = (init: RequestInit, name: string): string | undefined =>
  (init.headers as Record<string, string> | undefined)?.[name];

describe('saving a key on this device', () => {
  it('should seal it under a non-extractable key and keep only its last two characters in the clear', async () => {
    // Arrange
    const { records, keys } = vault();

    // Act
    await keys.save('groq', `  ${GROQ_KEY}  `);

    // Assert
    const wrapping = records.values.get('wrapping-key') as CryptoKey;
    should(wrapping).be.instanceof(CryptoKey);
    should(wrapping.extractable).be.false();
    await should(crypto.subtle.exportKey('raw', wrapping)).be.rejected();
    const sealed = records.values.get('provider:groq') as { data: ArrayBuffer; endsWith: string };
    should(sealed.endsWith).equal('AB');
    should(new TextDecoder().decode(sealed.data)).not.containEql(GROQ_KEY);
    should(JSON.stringify([...records.values.entries()])).not.containEql(GROQ_KEY);
    should(await keys.status('groq')).eql({ kind: 'saved', endsWith: 'AB' });
    should(await keys.status('cerebras')).eql({ kind: 'none' });
  });

  it('should reuse one wrapping key for every provider', async () => {
    // Arrange
    const { records, keys } = vault();
    await keys.save('groq', GROQ_KEY);
    const first = records.values.get('wrapping-key');

    // Act
    await keys.save('cerebras', CEREBRAS_KEY);

    // Assert
    should(records.values.get('wrapping-key')).equal(first);
    should(await keys.status('cerebras')).eql({ kind: 'saved', endsWith: 'CD' });
  });

  it('should refuse something that is not a key, and keep nothing', async () => {
    // Arrange
    const { records, keys } = vault();

    // Act
    const refusals = await Promise.all(
      ['', 'short', 'has a space in it', `${'x'.repeat(513)}`, 'tab\there-and-more'].map(value =>
        keys.save('groq', value).then(
          () => undefined,
          (reason: unknown) => reason,
        ),
      ),
    );

    // Assert
    for (const refusal of refusals) {
      should(refusal).be.instanceof(SpeedupKeyShapeError);
      should((refusal as Error).message).equal(SPEEDUP_KEY_SHAPE_SENTENCE);
      should((refusal as Error).name).equal('SpeedupKeyShapeError');
    }
    should(records.values.size).equal(0);
  });

  it('should forget a removed key', async () => {
    // Arrange
    const { keys } = vault();
    await keys.save('groq', GROQ_KEY);

    // Act
    await keys.remove('groq');

    // Assert
    should(await keys.status('groq')).eql({ kind: 'none' });
  });
});

describe('what the settings screen may learn', () => {
  it('should say a damaged record or a blocked store is unreadable, never "none"', async () => {
    // Arrange
    const { records, keys } = vault();
    records.values.set('provider:groq', { v: 1, iv: 'not bytes' });
    records.values.set('provider:cerebras', 'nonsense');

    // Act + Assert
    should((await keys.status('groq')).kind).equal('unreadable');
    should((await keys.status('cerebras')).kind).equal('unreadable');
    records.failGet = true;
    const blocked = await keys.status('groq');
    should(blocked.kind).equal('unreadable');
    should(blocked)
      .have.property('message')
      .match(/save it again/u);
  });

  it('should treat a null record as damaged', async () => {
    // Arrange
    const { records, keys } = vault();
    records.values.set('provider:groq', null);

    // Assert
    should((await keys.status('groq')).kind).equal('unreadable');
  });
});

describe('spending a key', () => {
  it('should put the key on one request to its own provider, with no cookie, referrer or cache', async () => {
    // Arrange
    const { keys, sent } = vault();
    await keys.save('groq', GROQ_KEY);
    await keys.save('cerebras', CEREBRAS_KEY);
    const controller = new AbortController();

    // Act
    const chat = await keys.send('groq', { endpoint: 'chat', body: '{"x":1}', signal: controller.signal });
    await keys.send('cerebras', { endpoint: 'models' });

    // Assert
    should(chat.kind).equal('response');
    should(sent.map(request => request.url)).eql([
      'https://api.groq.com/openai/v1/chat/completions',
      'https://api.cerebras.ai/v1/models',
    ]);
    const [post, get] = sent;
    should(post?.init.method).equal('POST');
    should(headerOf(post?.init ?? {}, 'authorization')).equal(`Bearer ${GROQ_KEY}`);
    should(headerOf(post?.init ?? {}, 'content-type')).equal('application/json');
    should(post?.init.body).equal('{"x":1}');
    should(post?.init.signal).equal(controller.signal);
    should(post?.init).containDeep({ credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
    should(get?.init.method).equal('GET');
    should(headerOf(get?.init ?? {}, 'authorization')).equal(`Bearer ${CEREBRAS_KEY}`);
    should(headerOf(get?.init ?? {}, 'content-type')).be.undefined();
    should(get?.init).not.have.property('body');
    should(get?.init).not.have.property('signal');
  });

  it('should send nothing without a key, and say so', async () => {
    // Arrange
    const { keys, sent } = vault();

    // Assert
    should(await keys.send('groq', { endpoint: 'chat' })).eql({ kind: 'missing' });
    should(sent).have.length(0);
  });

  it('should send nothing when the key cannot be opened: no wrapping key, a moved record, a blocked store', async () => {
    // Arrange
    const { records, keys, sent } = vault();
    await keys.save('groq', GROQ_KEY);
    const groqRecord = records.values.get('provider:groq');

    // Act + Assert — a Groq record moved into the Cerebras slot fails its additional data.
    records.values.set('provider:cerebras', groqRecord);
    should(await keys.send('cerebras', { endpoint: 'chat' })).eql({ kind: 'unreadable' });
    records.values.set('provider:cerebras', 'nonsense');
    should(await keys.send('cerebras', { endpoint: 'chat' })).eql({ kind: 'unreadable' });
    records.values.delete('wrapping-key');
    should(await keys.send('groq', { endpoint: 'chat' })).eql({ kind: 'unreadable' });
    records.failGet = true;
    should(await keys.send('groq', { endpoint: 'chat' })).eql({ kind: 'unreadable' });
    should(sent).have.length(0);
  });
});

interface ScriptedRequest<T> {
  result: T;
  error: DOMException | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onupgradeneeded?: (() => void) | null;
}

const succeeds = <T>(result: T): ScriptedRequest<T> => {
  const request: ScriptedRequest<T> = { result, error: null, onsuccess: null, onerror: null };
  queueMicrotask(() => request.onsuccess?.());
  return request;
};

const fails = <T>(error: DOMException | null): ScriptedRequest<T> => {
  const request: ScriptedRequest<T> = { result: undefined as T, error, onsuccess: null, onerror: null };
  queueMicrotask(() => request.onerror?.());
  return request;
};

/** An IndexedDB holding one database, recording what a suite asks it about. */
class ScriptedIndexedDb implements SpeedupKeyDatabaseFactory {
  readonly values = new Map<string, unknown>();
  readonly stores = new Set<string>();
  readonly opened: { name: string; version?: number }[] = [];
  closes = 0;
  failAction: DOMException | null | undefined;

  open(name: string, version?: number): IDBOpenDBRequest {
    this.opened.push({ name, version });
    const database = {
      objectStoreNames: { contains: (store: string) => this.stores.has(store) },
      createObjectStore: (store: string) => {
        this.stores.add(store);
      },
      close: () => {
        this.closes += 1;
      },
      transaction: () => ({
        objectStore: () => ({
          get: (key: string) =>
            this.failAction !== undefined ? fails(this.failAction) : succeeds(this.values.get(key)),
          put: (value: unknown, key: string) => {
            this.values.set(key, value);
            return succeeds(key);
          },
          delete: (key: string) => {
            this.values.delete(key);
            return succeeds(undefined);
          },
        }),
      }),
    };
    const request: ScriptedRequest<unknown> = {
      result: database,
      error: null,
      onsuccess: null,
      onerror: null,
      onupgradeneeded: null,
    };
    queueMicrotask(() => {
      request.onupgradeneeded?.();
      request.onsuccess?.();
    });
    return request as unknown as IDBOpenDBRequest;
  }
}

describe('the IndexedDB records', () => {
  it('should keep, return and forget values in their own database, closing it every time', async () => {
    // Arrange
    const database = new ScriptedIndexedDb();
    const records = new IndexedDbSpeedupKeyRecords(database);

    // Act
    await records.put('slot', { v: 1 });
    const kept = await records.get('slot');
    await records.delete('slot');
    const gone = await records.get('slot');

    // Assert
    should(kept).eql({ v: 1 });
    should(gone).be.undefined();
    should(database.opened[0]).eql({ name: 'ferretry-speedup-keys', version: 1 });
    should([...database.stores]).eql(['keys']);
    should(database.closes).equal(4);
  });

  it('should carry a refused request out as a rejection, and say when there is no IndexedDB at all', async () => {
    // Arrange
    const database = new ScriptedIndexedDb();
    database.failAction = new DOMException('quota', 'QuotaExceededError');
    const silent = new ScriptedIndexedDb();
    silent.failAction = null;

    // Assert
    await should(new IndexedDbSpeedupKeyRecords(database).get('slot')).be.rejectedWith('quota');
    await should(new IndexedDbSpeedupKeyRecords(silent).get('slot')).be.rejectedWith(/refused a request/u);
    await should(new IndexedDbSpeedupKeyRecords(undefined).get('slot')).be.rejectedWith(/no IndexedDB/u);
  });

  it('should seal and open a real key through it end to end', async () => {
    // Arrange
    const sent: string[] = [];
    const keys = new DeviceSpeedupKeys(
      new IndexedDbSpeedupKeyRecords(new ScriptedIndexedDb()),
      crypto.subtle,
      async url => {
        sent.push(String(url));
        return Response.json({ data: [] });
      },
    );

    // Act
    await keys.save('groq', GROQ_KEY);
    const outcome = await keys.send('groq', { endpoint: 'models' });

    // Assert
    should(outcome.kind).equal('response');
    should(sent).eql(['https://api.groq.com/openai/v1/models']);
  });
});
