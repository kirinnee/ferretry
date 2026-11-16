/** A worker module as a plugin writes one: it opens only what its half granted. */
import { defineState } from '../../../../contract/index.ts';
import { workerState } from '../../../../worker.ts';

const Archive = defineState({ name: 'archive', path: 'archive.sqlite', store: 'sqlite', format: 1 });

declare const self: Worker;
self.onmessage = (event: MessageEvent<{ insert: string }>) => {
  const db = workerState().sqlite(Archive);
  db.run('CREATE TABLE IF NOT EXISTS versions (label TEXT)');
  db.run('INSERT INTO versions (label) VALUES (?)', [event.data.insert]);
  const rows = db.query<{ n: number }>('SELECT count(*) AS n FROM versions')[0]?.n ?? 0;
  db.close();
  self.postMessage({ rows });
};
