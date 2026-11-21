import { expect, test } from 'bun:test';
import {
  ConversationIndex,
  type FerretConversationNames,
  type IndexSource,
} from '../../../daemon/links/lib/conversation-index.ts';
import { claudeRecord, MemoryHistory, memorySqlite, PARSERS } from '../../support/history-tree.ts';

const id = '9367ca52-0000-4000-8000-000000000001';
const path = `projects/-work-app/${id}.jsonl`;
const at = '2026-02-01T09:00:00.000Z';
const later = '2026-02-03T09:00:00.000Z';
const talk = (text: string, time = at) => claudeRecord('user', text, time) + '\n';
const rename = (title: string) => JSON.stringify({ type: 'custom-title', customTitle: title }) + '\n';
const pad = (claudeRecord('assistant', 'Padding '.repeat(1000), at) + '\n').repeat(140);
const custom = 'Mac builds FAIL';

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

/** A cached /rename in the middle of a long transcript, and an index made before the title rule changed. */
async function upgraded() {
  const f = fixture();
  const seed = f.make();
  f.history.set(path, talk('Why do Mac builds fail after upgrading Xcode?') + pad + talk('Check this build'));
  await seed.refresh();
  f.history.append(path, rename(custom));
  await seed.refresh();
  f.history.append(path, pad + talk('Follow up on this build', later));
  await seed.refresh();
  expect(seed.get('claude-code', id)?.row.title).toBe(custom);
  f.sqlite.run("DELETE FROM meta WHERE k = 'title_rule'");
  return f;
}

const stamp = (f: ReturnType<typeof fixture>) =>
  f.sqlite.query<{ size: number }>('SELECT size FROM conv').map(row => row.size === -1);

for (const fault of ['undefined read', 'thrown read', 'mtime change'] as const) {
  test(`the long full scan preserves and retries a cached /rename after ${fault}`, async () => {
    const f = await upgraded();
    const file = f.history.files.get(path)!;
    const size = file.bytes.length;
    const real = f.history.read.bind(f.history);
    let attempts = 0;
    f.history.read = async (p, offset, length) => {
      if (offset === 0 && length === size) {
        attempts++;
        if (fault === 'undefined read') return undefined;
        if (fault === 'thrown read') throw new Error('simulated I/O error');
        f.history.files.set(path, { ...file, mtimeMs: file.mtimeMs + 1 });
      }
      return real(p, offset, length);
    };
    const next = f.make();
    await next.refresh();
    expect(attempts).toBe(1);
    expect(next.get('claude-code', id)?.row.title).toBe(custom);
    expect(f.sqlite.query('SELECT size, mtime_ms, scanned FROM conv')).toEqual([
      { size: -1, mtime_ms: -1, scanned: 0 },
    ]);
    f.history.read = real;
    await next.refresh();
    expect(next.get('claude-code', id)?.row.title).toBe(custom);
    expect(stamp(f)).toEqual([false]);
  });
}

async function upgradedWidenedTail() {
  const f = fixture();
  const seed = f.make();
  const quiet = (claudeRecord('assistant', 'Padding '.repeat(1000), at) + '\n').repeat(50);
  f.history.set(path, talk('Why do Mac builds fail after upgrading Xcode?') + quiet + rename(custom));
  await seed.refresh();
  f.history.append(path, quiet);
  await seed.refresh();
  expect(seed.get('claude-code', id)?.row.title).toBe(custom);
  f.sqlite.run("DELETE FROM meta WHERE k = 'title_rule'");
  return f;
}

for (const fault of ['none', 'early EOF', 'mtime change'] as const) {
  test(`the widened tail whole-file read preserves the cached /rename with ${fault}`, async () => {
    const f = await upgradedWidenedTail();
    const file = f.history.files.get(path)!;
    const size = file.bytes.length;
    const real = f.history.read.bind(f.history);
    let fullReads = 0;
    f.history.read = async (p, offset, length) => {
      if (offset === 0 && length === size) {
        fullReads++;
        if (fault === 'early EOF') return real(p, 0, 20_000);
        if (fault === 'mtime change') f.history.files.set(path, { ...file, mtimeMs: file.mtimeMs + 1 });
      }
      return real(p, offset, length);
    };
    const next = f.make();
    await next.refresh();
    const firstRefresh = { fullReads, title: next.get('claude-code', id)?.row.title, stale: stamp(f) };
    f.history.read = real;
    await next.refresh();
    const retry = { title: next.get('claude-code', id)?.row.title, stale: stamp(f) };
    expect({ firstRefresh, retry }).toEqual({
      firstRefresh: { fullReads: 1, title: custom, stale: [fault !== 'none'] },
      retry: { title: custom, stale: [false] },
    });
  });
}
