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
const fallback = 'Mac Builds Fail After Upgrading';

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

test('a full scan that ends early keeps the cached /rename and leaves the row for the next refresh', async () => {
  const f = await upgraded();
  const size = f.history.files.get(path)!.bytes.length;
  const cut = 20_000;
  const real = f.history.read.bind(f.history);
  f.history.read = async (p, offset, length) => {
    // The scan is the one read that starts at 0 and asks for the whole file: it ends early, short of the /rename.
    if (offset === 0 && length === size) return (await real(p, 0, cut))!;
    if (offset === cut && length === size - cut) return new Uint8Array(0);
    return real(p, offset, length);
  };
  const next = f.make();
  await next.refresh();
  expect(next.get('claude-code', id)?.row.title).toBe(custom);
  expect(stamp(f)).toEqual([true]);
  f.history.read = real;
  await next.refresh();
  expect(next.get('claude-code', id)?.row.title).toBe(custom);
  expect(stamp(f)).toEqual([false]);
  f.history.resetReads();
  await next.refresh();
  expect(f.history.bytesRead).toBe(0);
  expect(next.get('claude-code', id)?.row.title).toBe(custom);
});

test('a full scan of a file that changed while it was read keeps the cached /rename and leaves the row stale', async () => {
  const f = await upgraded();
  const size = f.history.files.get(path)!.bytes.length;
  const real = f.history.read.bind(f.history);
  f.history.read = async (p, offset, length) => {
    const bytes = await real(p, offset, length);
    if (offset === 0 && length === size) f.history.append(path, talk('More text arrives', later));
    return bytes;
  };
  const next = f.make();
  await next.refresh();
  expect(next.get('claude-code', id)?.row.title).toBe(custom);
  expect(stamp(f)).toEqual([true]);
  f.history.read = real;
  await next.refresh();
  expect(next.get('claude-code', id)?.row.title).toBe(custom);
  expect(stamp(f)).toEqual([false]);
});

test('a whole scan that completes still remakes the fallback title', async () => {
  const f = fixture();
  const seed = f.make();
  f.history.set(path, talk('Why do Mac builds fail after upgrading Xcode?') + pad + talk('Check this build'));
  await seed.refresh();
  f.sqlite.run('UPDATE conv SET file_title = ?', ['Why Do Mac Builds Fail']);
  f.sqlite.run("DELETE FROM meta WHERE k = 'title_rule'");
  const next = f.make();
  await next.refresh();
  expect(next.get('claude-code', id)?.row.title).toBe(fallback);
  expect(stamp(f)).toEqual([false]);
});

test('a stale transcript whose widened tail already holds the whole file is read once, not twice', async () => {
  const f = fixture();
  const seed = f.make();
  const quiet = (claudeRecord('assistant', 'Padding '.repeat(1000), at) + '\n').repeat(100);
  f.history.set(path, talk('Why do Mac builds fail after upgrading Xcode?') + quiet);
  await seed.refresh();
  f.sqlite.run("DELETE FROM meta WHERE k = 'title_rule'");
  f.history.resetReads();
  const next = f.make();
  await next.refresh();
  const size = f.history.files.get(path)!.bytes.length;
  // The narrow ends (about 512 KiB) plus one whole read: well under two whole reads.
  expect(f.history.bytesRead).toBeLessThan(2 * size);
  expect(next.get('claude-code', id)?.row.title).toBe(fallback);
  expect(stamp(f)).toEqual([false]);
});
