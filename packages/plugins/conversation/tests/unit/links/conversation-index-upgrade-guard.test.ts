import { expect, test } from 'bun:test';
import {
  ConversationIndex,
  type FerretConversationNames,
  type IndexSource,
} from '../../../daemon/links/lib/conversation-index.ts';
import { claudeRecord, MemoryHistory, memorySqlite, PARSERS } from '../../support/history-tree.ts';

// R5: a small transcript read whole by the ordinary read is also a scan. A stale row clears only when that read reached the
// size and modified time it started from; a read that came back empty (a vanished or emptied file) leaves the cached title and the row.

const id = '9367ca52-0000-4000-8000-000000000002';
const path = `projects/-work-app/${id}.jsonl`;
const at = '2026-02-01T09:00:00.000Z';
const custom = 'Cached owner words';

function fixture() {
  const sqlite = memorySqlite();
  const history = new MemoryHistory();
  const source: IndexSource = {
    harness: 'claude-code',
    parser: 'claude',
    kind: 'computer',
    label: 'computer',
    files: history,
  };
  const make = () =>
    new ConversationIndex({
      sqlite: () => sqlite,
      sources: async () => [source],
      ferretNames: async (): Promise<FerretConversationNames> => new Map(),
      parsers: PARSERS,
      nowMs: () => 0,
      warn: () => undefined,
    });
  return { sqlite, history, make };
}

async function upgradedSmall() {
  const f = fixture();
  const seed = f.make();
  f.history.set(
    path,
    claudeRecord('user', 'Why do Mac builds fail after upgrading Xcode?', at) +
      '\n' +
      JSON.stringify({ type: 'custom-title', customTitle: custom }) +
      '\n',
  );
  await seed.refresh();
  expect(seed.get('claude-code', id)?.row.title).toBe(custom);
  f.sqlite.run("DELETE FROM meta WHERE k = 'title_rule'");
  return f;
}

const stale = (f: ReturnType<typeof fixture>) =>
  f.sqlite.query<{ size: number }>('SELECT size FROM conv').map(row => row.size === -1);

for (const fault of ['empty read', 'mtime change'] as const) {
  test(`a small whole read with ${fault} keeps the cached title and the row stale; the next refresh finishes`, async () => {
    const f = await upgradedSmall();
    const file = f.history.files.get(path)!;
    const real = f.history.read.bind(f.history);
    f.history.read = async (p, offset, length) => {
      if (fault === 'empty read') return new Uint8Array(0);
      f.history.files.set(path, { ...file, mtimeMs: file.mtimeMs + 1 });
      return real(p, offset, length);
    };
    const next = f.make();
    await next.refresh();
    expect({ title: next.get('claude-code', id)?.row.title, stale: stale(f) }).toEqual({
      title: custom,
      stale: [true],
    });
    f.history.read = real;
    await next.refresh();
    expect({ title: next.get('claude-code', id)?.row.title, stale: stale(f) }).toEqual({
      title: custom,
      stale: [false],
    });
  });
}
