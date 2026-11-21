import { expect, test } from 'bun:test';
import {
  ConversationIndex,
  type FerretConversationNames,
  type IndexSource,
  type ScrubBatch,
} from '../../../daemon/links/lib/conversation-index.ts';
import { claudeRecord, MemoryHistory, memorySqlite, PARSERS } from '../../support/history-tree.ts';

const id = (n: number) => `3b1a4a52-0000-4000-8000-${String(n).padStart(12, '0')}`;
const path = (n: number) => `projects/-work-app/${id(n)}.jsonl`;
const at = '2026-02-01T09:00:00.000Z';
const talk = (text: string, time = at) =>
  `${claudeRecord('user', text, time)}\n${claudeRecord('assistant', 'done', time)}\n`;
const first = 'Look at why the deploy script keeps failing on every push to main';
const oldTitle = 'Look at Why the Deploy';
const newTitle = 'Deploy Script Keeps Failing';
const renameRecord = (title: string) => JSON.stringify({ type: 'custom-title', customTitle: title }) + '\n';
const source = (files: MemoryHistory, label = 'owner'): IndexSource => ({
  harness: 'claude-code',
  parser: 'claude',
  kind: 'computer',
  label,
  files,
});

function fixture() {
  const sqlite = memorySqlite();
  const history = new MemoryHistory();
  const warnings: string[] = [];
  const make = (opts: { sources?: IndexSource[]; names?: FerretConversationNames; scrubbing?: ScrubBatch } = {}) =>
    new ConversationIndex({
      sqlite: () => sqlite,
      sources: async () => opts.sources ?? [source(history)],
      ferretNames: async () => opts.names ?? new Map(),
      parsers: PARSERS,
      nowMs: () => 0,
      warn: message => warnings.push(message),
      ...(opts.scrubbing === undefined ? {} : { scrubbing: opts.scrubbing }),
    });
  const eraseStamp = () => sqlite.database.run("DELETE FROM meta WHERE k = 'title_rule'");
  const seedOldTitle = () => sqlite.database.run('UPDATE conv SET file_title = ?, title = ?', [oldTitle, oldTitle]);
  return { sqlite, history, warnings, make, eraseStamp, seedOldTitle };
}

test('stale fallback is read once and all three seeded names retain exact bytes', async () => {
  const { sqlite, history, make, eraseStamp } = fixture();
  const ownerRename = 'Owner’s exact casing — ü';
  const ferretRename = 'Ferret’s exact casing — é';
  const cliRename = 'CLI exact casing — 文';
  const names: FerretConversationNames = new Map([
    [`claude-code:${id(2)}`, { ferret: 'ms-12', name: 'Ms-12', title: ownerRename, titleSource: 'owner' }],
    [`claude-code:${id(3)}`, { ferret: 'ms-13', name: 'Ms-13', title: ferretRename }],
  ]);
  for (const n of [1, 2, 3, 4]) history.set(path(n), talk(first) + (n === 4 ? renameRecord(cliRename) : ''));
  const seeded = make({ names });
  await seeded.refresh();
  expect([2, 3, 4].map(n => seeded.get('claude-code', id(n))?.row.title)).toEqual([
    ownerRename,
    ferretRename,
    cliRename,
  ]);
  sqlite.database.run('UPDATE conv SET file_title = ?, title = ? WHERE id = ?', [oldTitle, oldTitle, id(1)]);
  eraseStamp();
  history.resetReads();
  const index = make({ names });
  await index.refresh();
  expect(index.get('claude-code', id(1))?.row.title).toBe(newTitle);
  expect(history.readByPath.get(path(1))).toBe(history.files.get(path(1))?.bytes.length);
  expect([2, 3, 4].map(n => index.get('claude-code', id(n))?.row.title)).toEqual([
    ownerRename,
    ferretRename,
    cliRename,
  ]);
  history.resetReads();
  await index.refresh();
  expect(history.bytesRead).toBe(0);
});

test('a restart retries the remaining stale row after a committed batch', async () => {
  const { sqlite, history, warnings, make, eraseStamp, seedOldTitle } = fixture();
  for (let n = 1; n <= 65; n++) history.set(path(n), talk(first));
  await make().refresh();
  eraseStamp();
  seedOldTitle();
  const interrupt: ScrubBatch = async work => {
    const written = sqlite.database.query('SELECT COUNT(*) AS count FROM conv WHERE file_title = ?').get(newTitle) as {
      count: number;
    };
    if (written.count === 64) throw new Error('simulated abort after the first batch');
    return work(text => text);
  };
  await make({ scrubbing: interrupt }).refresh();
  expect(warnings).toEqual(['The conversation index could not be updated: simulated abort after the first batch']);
  expect(sqlite.database.query('SELECT size, scanned FROM conv WHERE file_title = ?').all(oldTitle)).toEqual([
    { size: -1, scanned: 0 },
  ]);
  expect(sqlite.database.query("SELECT v FROM meta WHERE k = 'title_rule'").get()).toEqual({ v: '1' });
  history.resetReads();
  const restarted = make();
  await restarted.refresh();
  expect(history.readByPath.size).toBe(1);
  expect(restarted.query().conversations.map(found => found.row.title)).toEqual(Array(65).fill(newTitle));
  history.resetReads();
  await restarted.refresh();
  expect(history.bytesRead).toBe(0);
});

test('a restart after writing the upgraded rows still deduplicates conversation copies', async () => {
  const { sqlite, history, warnings, make, eraseStamp, seedOldTitle } = fixture();
  const copy = new MemoryHistory();
  history.set(path(1), talk(first));
  copy.set(path(1), talk(first, '2026-02-02T09:00:00.000Z'));
  const sources = [source(history), source(copy, 'other')];
  const seeded = make({ sources });
  await seeded.refresh();
  expect(seeded.query().matched).toBe(1);
  eraseStamp();
  seedOldTitle();
  let calls = 0;
  const interrupt: ScrubBatch = async work => {
    if (++calls === 2) throw new Error('simulated abort before settling winners');
    return work(text => text);
  };
  await make({ sources, scrubbing: interrupt }).refresh();
  expect(warnings).toEqual(['The conversation index could not be updated: simulated abort before settling winners']);
  expect(sqlite.database.query('SELECT file_title FROM conv').all()).toEqual([
    { file_title: newTitle },
    { file_title: newTitle },
  ]);
  history.resetReads();
  copy.resetReads();
  const restarted = make({ sources });
  await restarted.refresh();
  expect(history.bytesRead + copy.bytesRead).toBe(0);
  expect(restarted.query().matched).toBe(1);
});

test('upgrade preserves a previously indexed /rename beyond the bounded transcript ends', async () => {
  const { history, make, eraseStamp } = fixture();
  const renamed = 'A case-sensitive custom title — ü';
  const pad = `${claudeRecord('assistant', 'Padding '.repeat(1000), at)}\n`.repeat(40);
  const existing = make();
  history.set(path(1), talk(first) + pad + talk('Checked the deployment'));
  await existing.refresh();
  history.append(path(1), renameRecord(renamed));
  await existing.refresh();
  expect(existing.get('claude-code', id(1))?.row.title).toBe(renamed);
  history.append(path(1), pad + talk('Follow up tomorrow', '2026-02-03T09:00:00.000Z'));
  await existing.refresh();
  expect(existing.get('claude-code', id(1))?.row.title).toBe(renamed);
  expect(make().get('claude-code', id(1))?.row.title).toBe(renamed);
  eraseStamp();
  const restarted = make();
  await restarted.refresh();
  expect(restarted.get('claude-code', id(1))?.row.title).toBe(renamed);
});
