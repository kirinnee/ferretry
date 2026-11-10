import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FakeAsks, entryId, sourceKey } from '@ferretry/core-asks/contract/testing';
import type { AskSummary } from '@ferretry/core-asks/contract';
import type { TranscriptEntry, TranscriptReader } from '@ferretry/core-ferrets/contract';
import type { Redaction, RootHandle } from '@ferretry/kernel/contract';
import { diskRoot } from '@ferretry/kernel/testing';
import type { Instant } from '@ferretry/std';
import { EntriesTranscriptSource } from '../../../daemon/reader/adapters/entries-source.ts';
import { historyFiles } from '../../../daemon/reader/adapters/history-files.ts';
import { conversationFiles } from '../../../daemon/links/adapters/conversation-files.ts';
import { asksSource } from '../../../daemon/search/adapters/asks-source.ts';
import { workRedaction } from '../../../daemon/search/adapters/redaction.ts';

const AT = '2026-11-07T09:00:00.000Z' as Instant;
const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

/** A real fenced root over a temp folder, with a few files in it. */
async function history() {
  const parent = await mkdtemp(join(tmpdir(), 'fy-history-'));
  parents.push(parent);
  const { root, folder } = await diskRoot(parent);
  await mkdir(join(folder, 'proj'), { recursive: true });
  await writeFile(join(folder, 'proj', 'one.jsonl'), '0123456789');
  await writeFile(join(folder, 'proj', 'two.jsonl'), 'abcdefghij');
  await mkdir(join(folder, 'proj', 'sub'));
  await symlink(join(folder, 'proj', 'one.jsonl'), join(folder, 'proj', 'link.jsonl'));
  return { root, folder };
}

describe('the harness history root read in place for conversations', () => {
  test('a folder lists its files and folders by kind, and a folder that is missing or outside the root lists nothing', async () => {
    const { root } = await history();
    const files = conversationFiles(root);

    const entries = await files.entries('proj');

    expect(entries.filter(entry => entry.name !== 'link.jsonl')).toEqual([
      { name: 'one.jsonl', kind: 'file' },
      { name: 'sub', kind: 'directory' },
      { name: 'two.jsonl', kind: 'file' },
    ]);
    expect(entries.some(entry => entry.name === 'link.jsonl')).toBe(true);
    expect(await files.entries('absent')).toEqual([]);
    expect(await files.entries('../../outside')).toEqual([]);
  });

  test('an entry whose status cannot be read is listed as other', async () => {
    const { root } = await history();
    const failing = { ...root, stat: async () => Promise.reject(new Error('gone')) } as unknown as RootHandle;

    const entries = await conversationFiles(failing).entries('proj');

    expect(entries.every(entry => entry.kind === 'other')).toBe(true);
    expect(entries.length).toBeGreaterThan(0);
    const unresolvable = {
      ...root,
      resolve: (path: string) => (path === 'proj' ? root.resolve(path) : ({ ok: false } as never)),
    } as unknown as RootHandle;
    expect((await conversationFiles(unresolvable).entries('proj')).every(entry => entry.kind === 'other')).toBe(true);
  });

  test('a file’s size and time are told, a folder, a missing file or a path outside the root has none', async () => {
    const { root } = await history();
    const files = conversationFiles(root);

    const info = await files.info('proj/one.jsonl');

    expect(info?.size).toBe(10);
    expect(Number.isFinite(info?.modifiedAtMs)).toBe(true);
    expect(await files.info('proj/sub')).toBeUndefined();
    expect(await files.info('proj/absent.jsonl')).toBeUndefined();
    expect(await files.info('../../outside')).toBeUndefined();
  });

  test('the head is the first bytes and the tail the last, and anything unreadable is nothing', async () => {
    const { root } = await history();
    const files = conversationFiles(root);

    expect(await files.head('proj/two.jsonl', 4)).toBe('abcd');
    expect(await files.tail('proj/two.jsonl', 4)).toBe('ghij');
    expect(await files.tail('proj/two.jsonl', 100)).toBe('abcdefghij');
    expect(await files.head('proj/absent.jsonl', 4)).toBeUndefined();
    expect(await files.head('../../outside', 4)).toBeUndefined();
    expect(await files.tail('proj/absent.jsonl', 4)).toBeUndefined();
    expect(await files.tail('../../outside', 4)).toBeUndefined();
    const unreadable = { ...root, readBytes: async () => Promise.reject(new Error('io')) } as unknown as RootHandle;
    expect(await conversationFiles(unreadable).tail('proj/two.jsonl', 4)).toBeUndefined();
  });
});

describe('the transcript files an image handle names', () => {
  test('a file has a fingerprint, a folder, a missing file or a path outside the root has none', async () => {
    const { root } = await history();
    const files = historyFiles(root);

    expect((await files.fingerprint('proj/one.jsonl'))?.size).toBe(10);
    expect(await files.fingerprint('proj/sub')).toBeUndefined();
    expect(await files.fingerprint('proj/absent.jsonl')).toBeUndefined();
    expect(await files.fingerprint('../../outside')).toBeUndefined();
  });

  test('a range is the bytes between its offsets, shortened at the end, and empty outside the root', async () => {
    const { root } = await history();
    const files = historyFiles(root);
    const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

    expect(text(await files.readRange('proj/one.jsonl', 2, 3))).toBe('234');
    expect(text(await files.readRange('proj/one.jsonl', 8, 10))).toBe('89');
    expect((await files.readRange('../../outside', 0, 5)).byteLength).toBe(0);
  });
});

describe('a ferret’s conversation read through its harness’s transcript reader', () => {
  const entry = (index: number, over: Partial<TranscriptEntry> = {}): TranscriptEntry => ({
    id: `e${String(index)}`,
    at: AT,
    role: index % 2 === 0 ? 'assistant' : 'user',
    text: `line ${String(index)} about the badge`,
    ...over,
  });
  const readerOf = (entries: readonly TranscriptEntry[]): TranscriptReader => ({
    read: async (_ferret, after, limit = 1_000) => {
      const start = after === undefined ? 0 : entries.findIndex(each => each.id === after) + 1;
      return entries.slice(start, start + limit);
    },
    follow: async function* () {},
    find: async (_ferret, id) => entries.find(each => each.id === id),
  });
  const sourceOf = (entries: readonly TranscriptEntry[]) =>
    new EntriesTranscriptSource(async () => ({ harness: 'claude', reader: readerOf(entries) }));
  const five = [
    entry(0),
    entry(1),
    entry(2, { role: 'tool', data: { ok: true }, text: 'tool said the badge is green' }),
    entry(3, { role: 'system', text: undefined }),
    entry(4),
  ];

  test('a ferret the harness does not know is unresolved and a reader that fails is unreadable, on every read', async () => {
    const unknown = new EntriesTranscriptSource(async () => undefined);
    const failing = new EntriesTranscriptSource(async () => ({
      harness: 'claude',
      reader: { ...readerOf([]), read: async () => Promise.reject(new Error('io')) },
    }));

    for (const source of [unknown, failing]) {
      const kind = source === unknown ? 'unresolved' : 'unreadable';
      expect(await source.tail('f1', 5)).toEqual({ kind });
      expect(await source.page('f1', { limit: 5 })).toEqual({ kind });
      expect(await source.search('f1', { needle: undefined, accept: () => true, limit: 5 })).toEqual({ kind });
      expect(await source.read('f1')).toEqual({ kind });
    }
  });

  test('the tail is the newest events, a tool entry is a tool result and the rest are messages', async () => {
    const read = await sourceOf(five).tail('f1', 3);

    expect(read.kind).toBe('read');
    if (read.kind !== 'read') return;
    expect(read.events.map(event => event.kind)).toEqual(['tool-result', 'message', 'message']);
    expect(read.events.map(event => event.role)).toEqual(['tool', 'system', 'assistant']);
  });

  test('a page is the events before or from a byte coordinate, newest last, with where it starts', async () => {
    const source = sourceOf(five);
    const all = await source.page('f1', { limit: 10 });
    if (all.kind !== 'read') throw new Error('unreadable');
    const second = all.events[1]?.byteOffset ?? 0;

    const before = await source.page('f1', { before: second, limit: 10 });
    const from = await source.page('f1', { from: second, limit: 2 });
    const none = await source.page('f1', { before: 0, limit: 10 });

    expect(before.kind === 'read' && before.events.map(event => event.recordId)).toEqual(['e0']);
    expect(from.kind === 'read' && from.events.map(event => event.recordId)).toEqual(['e3', 'e4']);
    expect(none.kind === 'read' && [none.events.length, none.start]).toEqual([0, 0]);
    expect(all.start).toBe(0);
    expect(all.file).toHaveLength(22);
  });

  test('a search walks from the newest, filters by the needle and by what is accepted, and says when it stopped short', async () => {
    const source = sourceOf(five);

    const found = await source.search('f1', { needle: 'badge', accept: () => true, limit: 2 });
    const odd = await source.search('f1', { needle: undefined, accept: event => event.role === 'user', limit: 10 });
    const none = await source.search('f1', { needle: 'zzz', accept: () => true, limit: 10 });

    expect(found.kind === 'read' && found.events.map(event => event.recordId)).toEqual(['e2', 'e4']);
    expect(found.kind === 'read' && found.truncated).toBe(true);
    expect(odd.kind === 'read' && odd.events.map(event => event.recordId)).toEqual(['e1']);
    expect(odd.kind === 'read' && odd.truncated).toBe(false);
    expect(none.kind === 'read' && none.events).toEqual([]);
  });

  test('the message rows carry the conversation’s identity, and an empty conversation has no resolved time', async () => {
    const read = await sourceOf(five).read('f1');
    expect(read.kind).toBe('read');
    if (read.kind !== 'read') return;
    expect(read.rows.length).toBeGreaterThan(0);
    expect(read.context.provenance).toMatchObject({
      v: 1,
      home: 'claude',
      identity: 'minted',
      harnessSessionId: 'f1',
      resolvedAt: AT,
    });

    const empty = await sourceOf([]).read('f1');
    expect(empty.kind === 'read' && empty.rows).toEqual([]);
    expect(empty.kind === 'read' && empty.context.provenance).not.toHaveProperty('resolvedAt');
  });

  test('a long conversation is read page after page, and one past the limit is refused as unreadable, never served shorter', async () => {
    const many = Array.from({ length: 1_001 }, (_, index) => entry(index));
    const tail = await sourceOf(many).tail('f1', 2);
    expect(tail.kind === 'read' && tail.events.map(event => event.recordId)).toEqual(['e999', 'e1000']);

    const endless = new EntriesTranscriptSource(async () => ({
      harness: 'claude',
      reader: {
        ...readerOf([]),
        read: async (_ferret, after) =>
          Array.from({ length: 1_000 }, (_, index) => entry(Number(after?.slice(1) ?? -1) + 1 + index)),
      },
    }));
    expect(await endless.tail('f1', 2)).toEqual({ kind: 'unreadable' });
  });
});

describe('the asks as work for the search', () => {
  test('every ask is work with its subject, its standing in the Inbox’s words, and open or closed', async () => {
    const asks = new FakeAsks();
    const draft = (entry: string) => ({
      source: sourceKey('ferret'),
      ref: {},
      entry: entryId(entry),
      kind: 'task' as const,
      subject: `Do ${entry}`,
      why: 'because',
      raisedBy: { kind: 'ferret' as const, ferret: 'f1' },
      ferret: 'f1',
    });
    const open = await asks.raise(draft('e1'));
    const answered = await asks.raise(draft('e2'));
    const closed = await asks.raise(draft('e3'));
    asks.answerAs(answered, 'done');
    await asks.close(closed, 'withdrawn');

    const works = await asksSource(asks).list();

    const standing = Object.fromEntries(works.map(work => [work.key, work.identity]));
    expect(
      Object.values(standing)
        .map(identity => [identity.standing, identity.state])
        .sort(),
    ).toEqual([
      ['answered', 'closed'],
      ['closed', 'closed'],
      ['open', 'open'],
    ]);
    expect(works.map(work => work.fields[1])).toContainEqual(['title', 'Do e1']);
    expect(open.id).toBeDefined();
  });

  test('an ask that did not change is the same object, one that did a new one, a gone one is dropped and an unowned one is the owner’s', async () => {
    const summary = (id: string, over: Partial<AskSummary> = {}): AskSummary =>
      ({
        id,
        source: sourceKey('ferret'),
        entry: entryId(id),
        kind: 'task',
        subject: `Do ${id}`,
        raisedBy: { kind: 'owner' },
        state: 'open',
        raisedAt: AT,
        ...over,
      }) as AskSummary;
    let listed = [summary('A1'), summary('A2')];
    const source = asksSource({ open: async filter => listed.filter(ask => ask.state === (filter.state ?? 'open')) });

    const first = await source.list();
    listed = [summary('A1'), summary('A2', { subject: 'Changed' })];
    const second = await source.list();
    listed = [summary('A1')];
    const third = await source.list();

    expect(source.id).toBe('asks');
    expect(second[0]).toBe(first[0]!);
    expect(second[1]).not.toBe(first[1]!);
    expect(third).toHaveLength(1);
    expect(first[0]?.identity).toMatchObject({ ferret: 'owner' });
  });
});

describe('the kernel’s redaction as the work search sees it', () => {
  const redaction: Redaction = {
    read: async fn => await fn({ text: (text: string) => text.replaceAll('hunter2', '[hidden]') } as never),
  };

  test('a batch scrubs every text inside one read, and the unchanging generation says the index never needs a rebuild', async () => {
    const redacted = workRedaction(redaction);

    const texts = await redacted.batch(scrub => ['hunter2 is the word', 'nothing here'].map(scrub));

    expect(texts).toEqual(['[hidden] is the word', 'nothing here']);
    expect(await redacted.epoch()).toBe('unchanging');
    expect(redacted.epochTracksValues).toBe(false);
  });

  test('a generation handed in is the epoch and tells the search the index tracks the values', async () => {
    const redacted = workRedaction(redaction, async () => 'generation-7');

    expect(await redacted.epoch()).toBe('generation-7');
    expect(redacted.epochTracksValues).toBe(true);
  });
});
