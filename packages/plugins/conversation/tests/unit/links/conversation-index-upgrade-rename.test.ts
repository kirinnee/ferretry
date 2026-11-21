import { expect, test } from 'bun:test';
import {
  ConversationIndex,
  type FerretConversationNames,
  type IndexSource,
} from '../../../daemon/links/lib/conversation-index.ts';
import { claudeRecord, MemoryHistory, memorySqlite, PARSERS } from '../../support/history-tree.ts';

const id = (n: number) => `9367ca52-0000-4000-8000-${String(n).padStart(12, '0')}`;
const path = (n: number) => `projects/-work-app/${id(n)}.jsonl`;
const at = '2026-02-01T09:00:00.000Z';
const later = '2026-02-03T09:00:00.000Z';
const first = 'Why do Mac builds fail after upgrading Xcode?';
const oldTitle = 'Why Do Mac Builds Fail';
const newTitle = 'Mac Builds Fail After Upgrading';
const talk = (text: string, time = at) => claudeRecord('user', text, time) + '\n';
const rename = (title: string) => JSON.stringify({ type: 'custom-title', customTitle: title }) + '\n';
const pad = (claudeRecord('assistant', 'Padding '.repeat(1000), at) + '\n').repeat(140);
const source = (files: MemoryHistory, label: string): IndexSource => ({
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
  const make = (
    sources = [source(history, 'computer')],
    ferretNames = async (): Promise<FerretConversationNames> => new Map(),
  ) =>
    new ConversationIndex({
      sqlite: () => sqlite,
      sources: async () => sources,
      ferretNames,
      parsers: PARSERS,
      nowMs: () => 0,
      warn: message => warnings.push(message),
    });
  const eraseStamp = () => sqlite.run("DELETE FROM meta WHERE k = 'title_rule'");
  return { sqlite, history, warnings, make, eraseStamp };
}

for (const title of [oldTitle, 'Mac builds FAIL']) {
  test(`the upgrade keeps the mid-transcript Claude /rename "${title}"`, async () => {
    const { history, make, eraseStamp } = fixture();
    const seed = make();
    history.set(path(1), talk(first) + pad + talk('Check this build'));
    await seed.refresh();
    expect(seed.get('claude-code', id(1))?.row.title).toBe(newTitle);
    history.append(path(1), rename(title));
    await seed.refresh();
    expect(seed.get('claude-code', id(1))?.row.title).toBe(title);
    history.append(path(1), pad + talk('Follow up on this build', later));
    await seed.refresh();
    expect(seed.get('claude-code', id(1))?.row.title).toBe(title);
    eraseStamp();
    history.resetReads();
    const next = make();
    await next.refresh();
    // One read of the whole transcript finds the /rename wherever it sits (plus the two ends the row is described from).
    const size = history.files.get(path(1))!.bytes.length;
    expect(history.bytesRead).toBeGreaterThanOrEqual(size);
    expect(history.bytesRead).toBeLessThan(2 * size);
    expect(next.get('claude-code', id(1))?.row.title).toBe(title);
    history.resetReads();
    await next.refresh();
    expect(history.bytesRead).toBe(0);
    expect(next.get('claude-code', id(1))?.row.title).toBe(title);
  });
}

test('the upgrade keeps an owner Rename matching the legacy fallback', async () => {
  const { sqlite, history, make, eraseStamp } = fixture();
  history.set(path(1), talk(first));
  const names = async (): Promise<FerretConversationNames> =>
    new Map([[`claude-code:${id(1)}`, { ferret: 'ms-12', name: 'Ms-12', title: oldTitle, titleSource: 'owner' }]]);
  const sources = [source(history, 'computer')];
  await make(sources, names).refresh();
  sqlite.run('UPDATE conv SET file_title = ?', [oldTitle]);
  eraseStamp();
  const next = make(sources, names);
  await next.refresh();
  expect(next.get('claude-code', id(1))?.row.title).toBe(oldTitle);
  expect(sqlite.query('SELECT file_title FROM conv')).toEqual([{ file_title: newTitle }]);
});

for (const point of [
  'after row commit',
  'before settlement update',
  'inside settlement transaction',
  'after settlement commit',
]) {
  test(`restart recovers ${point}`, async () => {
    const { sqlite, history, warnings, make, eraseStamp } = fixture();
    const copy = new MemoryHistory();
    history.set(path(1), talk(first));
    history.set(path(2), talk(first));
    copy.set(path(1), talk(first, later));
    copy.set(path(3), talk(first, later));
    const sources = [source(history, 'computer'), source(copy, 'other')];
    await make(sources).refresh();
    sqlite.run('UPDATE conv SET file_title = ?, title = ?', [oldTitle, oldTitle]);
    eraseStamp();

    const realRun = sqlite.run;
    const realTransaction = sqlite.transaction;
    let operation = '';
    sqlite.run = (sql, args) => {
      if (sql.includes('INTO conv ')) operation = 'rows';
      if (sql.startsWith('UPDATE conv SET win =')) {
        operation = 'settlement';
        if (point === 'before settlement update') throw new Error(point);
        if (point === 'inside settlement transaction') {
          realRun(sql, args);
          throw new Error(point);
        }
      }
      return realRun(sql, args);
    };
    sqlite.transaction = fn => {
      operation = '';
      const result = realTransaction(fn);
      if (
        (point === 'after row commit' && operation === 'rows') ||
        (point === 'after settlement commit' && operation === 'settlement')
      )
        throw new Error(point);
      return result;
    };

    await make(sources).refresh();
    sqlite.run = realRun;
    sqlite.transaction = realTransaction;
    expect(warnings).toEqual([`The conversation index could not be updated: ${point}`]);
    expect(sqlite.query('SELECT DISTINCT file_title FROM conv')).toEqual([{ file_title: newTitle }]);
    expect(sqlite.query("SELECT v FROM meta WHERE k = 'winners_dirty'")).toEqual(
      point === 'after settlement commit' ? [] : [{ v: '1' }],
    );

    history.resetReads();
    copy.resetReads();
    const restarted = make(sources);
    expect(restarted.query().matched).toBe(3);
    await restarted.refresh();
    expect(history.bytesRead + copy.bytesRead).toBe(0);
    const rows = restarted.query().conversations;
    expect(rows.map(found => found.row.id).sort()).toEqual([id(1), id(2), id(3)]);
    expect(rows.find(found => found.row.id === id(1))?.label).toBe('other');
    expect(sqlite.query('SELECT id, label, win FROM conv ORDER BY id, label')).toEqual([
      { id: id(1), label: 'computer', win: 0 },
      { id: id(1), label: 'other', win: 1 },
      { id: id(2), label: 'computer', win: 1 },
      { id: id(3), label: 'other', win: 1 },
    ]);
    expect(sqlite.query("SELECT v FROM meta WHERE k = 'winners_dirty'")).toEqual([]);
    history.resetReads();
    copy.resetReads();
    await restarted.refresh();
    expect(history.bytesRead + copy.bytesRead).toBe(0);
  });
}
