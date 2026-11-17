/**
 * The read-only file port over a harness history tree, when the tree caps one read: a request for more than the cap is
 * fulfilled by ranged reads, never answered with the first part as though it were all of it.
 */
import { describe, expect, test } from 'bun:test';
import { HARNESS_HISTORY_READ_MAX_BYTES, type HarnessHistoryFiles } from '@ferretry/core-ferrets/contract';
import { conversationFiles } from '../../../daemon/links/adapters/conversation-files.ts';
import { FileConversationDescriber } from '../../../daemon/links/lib/conversation-describer.ts';
import { claudeRecord, MemoryHistory, PARSERS } from '../../support/history-tree.ts';

const ID = '3b1a4a52-0000-4000-8000-00000000000a';
const PATH = `projects/p/${ID}.jsonl`;
const AT = '2026-02-01T09:00:00.000Z';
const MIB = 1024 * 1024;

/** The tree as the real port serves it: one read returns at most the cap. */
const capped = (home: MemoryHistory): HarnessHistoryFiles & { readonly sizes: number[] } => {
  const sizes: number[] = [];
  return {
    sizes,
    entries: home.entries.bind(home),
    stat: home.stat.bind(home),
    read: async (path, offset, length) => {
      const bytes = await home.read(path, offset, Math.min(length, HARNESS_HISTORY_READ_MAX_BYTES));
      sizes.push(bytes?.length ?? -1);
      return bytes;
    },
  };
};

describe('conversationFiles over a port that caps one read', () => {
  test('a preview of a 4–8 MiB transcript still ends with the latest message', async () => {
    const home = new MemoryHistory();
    home.set(
      PATH,
      `${claudeRecord('user', 'first', AT)}\n${claudeRecord('assistant', 'x'.repeat(5 * MIB), AT)}\n${claudeRecord('user', 'latest important question', AT)}\n`,
    );
    const describer = new FileConversationDescriber(conversationFiles(capped(home)), PARSERS);
    const preview = await describer.preview({ harness: 'claude', source: PATH, relativePath: PATH, nameId: ID });
    expect(preview?.messages.at(-1)?.text).toBe('latest important question');
    const described = await describer.describe({ harness: 'claude', source: PATH, relativePath: PATH, nameId: ID });
    expect(described).toMatchObject({ preview: 'first', latest: 'latest important question', turns: 2 });
    expect(described?.turnsAtLeast).toBeUndefined();
  });

  test('a head or tail larger than the cap is read in cap-sized ranges and joined in order', async () => {
    const home = new MemoryHistory();
    const text = `${'a'.repeat(4 * MIB)}${'b'.repeat(4 * MIB)}${'c'.repeat(MIB)}`;
    home.set('big', text);
    const port = capped(home);
    const files = conversationFiles(port);
    expect(await files.head('big', 9 * MIB)).toBe(text);
    expect(port.sizes).toEqual([4 * MIB, 4 * MIB, MIB]);
    expect((await files.tail('big', 6 * MIB))?.length).toBe(6 * MIB);
    expect(await files.tail('big', 6 * MIB)).toBe(text.slice(3 * MIB));
  });

  test('a request longer than the file stops at the end of the file', async () => {
    const home = new MemoryHistory();
    home.set('small', 'hello');
    const files = conversationFiles(capped(home));
    expect(await files.head('small', 6 * MIB)).toBe('hello');
    expect(await files.head('nothing', 6 * MIB)).toBeUndefined();
  });

  test('an empty read ends the range, and a later read that fails leaves what was read', async () => {
    const stat = async () => ({ size: 10 * MIB, modifiedMs: 1 });
    const chunk = (n: number) => new Uint8Array(n).fill(0x61);
    const empty = conversationFiles({
      entries: async () => [],
      stat,
      read: async (_p, offset) => (offset === 0 ? chunk(HARNESS_HISTORY_READ_MAX_BYTES) : new Uint8Array(0)),
    });
    expect((await empty.head('f', 9 * MIB))?.length).toBe(HARNESS_HISTORY_READ_MAX_BYTES);
    const failing = conversationFiles({
      entries: async () => [],
      stat,
      read: async (_p, offset) => (offset === 0 ? chunk(HARNESS_HISTORY_READ_MAX_BYTES) : undefined),
    });
    expect((await failing.head('f', 9 * MIB))?.length).toBe(HARNESS_HISTORY_READ_MAX_BYTES);
  });
});
