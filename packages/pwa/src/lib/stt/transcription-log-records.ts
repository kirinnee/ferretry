/**
 * The transcription log's rows in IndexedDB, in a database of their own. Opened per call, like
 * `IndexedDbSpeedupKeyRecords`: a held connection would block a future version change, and this is
 * touched once per dictation. Rows are returned untrusted; `TranscriptionLog` parses each one.
 */

import type { TranscriptionEntry, TranscriptionLogRecords } from './transcription-log.ts';

/** The slice of `IDBFactory` the records use, so a suite can supply one without a browser. */
export interface TranscriptionLogDatabaseFactory {
  open(name: string, version?: number): IDBOpenDBRequest;
}

const DATABASE = 'ferretry-transcription-log';
const STORE = 'entries';
const VERSION = 1;

const settled = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('the transcription log refused a request'));
  });

export class IndexedDbTranscriptionLogRecords implements TranscriptionLogRecords {
  constructor(private readonly factory: TranscriptionLogDatabaseFactory | undefined) {}

  async list(): Promise<readonly unknown[]> {
    return await this.#run('readonly', store => store.getAll());
  }

  async put(entry: TranscriptionEntry): Promise<void> {
    await this.#run('readwrite', store => store.put(entry));
  }

  async delete(id: string): Promise<void> {
    await this.#run('readwrite', store => store.delete(id));
  }

  async clear(): Promise<void> {
    await this.#run('readwrite', store => store.clear());
  }

  async #run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const factory = this.factory;
    if (factory === undefined) throw new Error('this browser has no IndexedDB, so it cannot keep a transcription log');
    const opening = factory.open(DATABASE, VERSION);
    opening.onupgradeneeded = () => {
      if (!opening.result.objectStoreNames.contains(STORE)) opening.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    const database = await settled(opening);
    try {
      return await settled(action(database.transaction(STORE, mode).objectStore(STORE)));
    } finally {
      database.close();
    }
  }
}
