/**
 * The transcription log's IndexedDB rows: a database of their own, opened and closed for every call.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import {
  IndexedDbTranscriptionLogRecords,
  type TranscriptionLogDatabaseFactory,
} from '../../../src/lib/stt/transcription-log-records.ts';
import type { TranscriptionEntry } from '../../../src/lib/stt/transcription-log.ts';

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

class ScriptedIndexedDb implements TranscriptionLogDatabaseFactory {
  readonly rows = new Map<string, unknown>();
  readonly stores = new Map<string, unknown>();
  readonly opened: { name: string; version?: number }[] = [];
  readonly modes: string[] = [];
  closes = 0;
  failAction: DOMException | null | undefined;
  hasStoreAlready = false;

  open(name: string, version?: number): IDBOpenDBRequest {
    this.opened.push({ name, version });
    const database = {
      objectStoreNames: { contains: (store: string) => this.hasStoreAlready || this.stores.has(store) },
      createObjectStore: (store: string, options: unknown) => {
        this.stores.set(store, options);
      },
      close: () => {
        this.closes += 1;
      },
      transaction: (_store: string, mode: string) => {
        this.modes.push(mode);
        const outcome = <T>(result: T) =>
          this.failAction !== undefined ? fails<T>(this.failAction) : succeeds(result);
        return {
          objectStore: () => ({
            getAll: () => outcome([...this.rows.values()]),
            put: (value: { id: string }) => {
              this.rows.set(value.id, value);
              return outcome(value.id);
            },
            delete: (key: string) => {
              this.rows.delete(key);
              return outcome(undefined);
            },
            clear: () => {
              this.rows.clear();
              return outcome(undefined);
            },
          }),
        };
      },
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

const row = (id: string): TranscriptionEntry => ({ id, at: 1, engine: 'parakeet', raw: 'hello', outcome: 'pending' });

describe('the transcription log IndexedDB records', () => {
  it('should keep, list, delete and clear rows in their own database, closing it every time', async () => {
    // Arrange
    const database = new ScriptedIndexedDb();
    const records = new IndexedDbTranscriptionLogRecords(database);

    // Act
    await records.put(row('a'));
    await records.put(row('b'));
    const both = await records.list();
    await records.delete('a');
    const one = await records.list();
    await records.clear();
    const none = await records.list();

    // Assert
    should(both).have.length(2);
    should(one).deepEqual([row('b')]);
    should(none).have.length(0);
    should(new Set(database.opened.map(open => `${open.name}@${String(open.version)}`))).deepEqual(
      new Set(['ferretry-transcription-log@1']),
    );
    should(database.closes).equal(database.opened.length);
    should(database.stores.get('entries')).deepEqual({ keyPath: 'id' });
    should(database.modes).deepEqual([
      'readwrite',
      'readwrite',
      'readonly',
      'readwrite',
      'readonly',
      'readwrite',
      'readonly',
    ]);
  });

  it('should not create a store that already exists', async () => {
    // Arrange
    const database = new ScriptedIndexedDb();
    database.hasStoreAlready = true;

    // Act
    await new IndexedDbTranscriptionLogRecords(database).list();

    // Assert
    should(database.stores.size).equal(0);
  });

  it('should reject, and still close the database, when a request is refused', async () => {
    // Arrange
    const database = new ScriptedIndexedDb();
    database.failAction = new DOMException('quota', 'QuotaExceededError');

    // Act
    const refused = new IndexedDbTranscriptionLogRecords(database).put(row('a'));

    // Assert
    await should(refused).be.rejectedWith('quota');
    should(database.closes).equal(1);
  });

  it('should reject with a plain reason when the refusal carries none', async () => {
    // Arrange
    const database = new ScriptedIndexedDb();
    database.failAction = null;

    // Act
    const refused = new IndexedDbTranscriptionLogRecords(database).list();

    // Assert
    await should(refused).be.rejectedWith('the transcription log refused a request');
  });

  it('should refuse plainly when this browser has no IndexedDB', async () => {
    // Act
    const refused = new IndexedDbTranscriptionLogRecords(undefined).list();

    // Assert
    await should(refused).be.rejectedWith(/no IndexedDB/u);
  });
});
