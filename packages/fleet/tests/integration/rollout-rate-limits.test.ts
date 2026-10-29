/**
 * The passive Codex usage reading against real rollout files in a throwaway directory. Nothing here
 * reads a real Codex home: every sessions tree is built under a temporary directory.
 */
import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  listRollouts,
  newestRateLimitsInRollout,
  newestRolloutRateLimits,
  type RolloutFile,
  rolloutConversationId,
} from '../../src/adapters/rollout-rate-limits.ts';

const CONVERSATION = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const OTHER = '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';

const directories: string[] = [];
async function sessions(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'fy-rollouts-'));
  directories.push(directory);
  return directory;
}
afterEach(async () => {
  await Promise.all(directories.splice(0).map(each => rm(each, { recursive: true, force: true })));
});

const tokenCount = (timestamp: string, rateLimits: unknown): string =>
  JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: { type: 'token_count', info: null, rate_limits: rateLimits },
  });

const limits = (primary: number, secondary: number) => ({
  primary: { used_percent: primary, window_minutes: 300, resets_at: 1_800_003_600 },
  secondary: { used_percent: secondary, window_minutes: 10_080, resets_at: 1_800_500_000 },
});

const at = (iso: string): number => Date.parse(iso);

describe('rolloutConversationId', () => {
  it('should read the conversation id from a rollout name, compressed or not', () => {
    // Arrange / Act / Assert
    should(rolloutConversationId(`rollout-2026-10-13T07-00-00-${CONVERSATION}.jsonl`)).equal(CONVERSATION);
    should(rolloutConversationId(`rollout-2026-10-13T07-00-00-${CONVERSATION}.jsonl.zst`)).equal(CONVERSATION);
    should(rolloutConversationId('history.jsonl')).be.undefined();
  });
});

describe('newestRateLimitsInRollout', () => {
  it('should take the LAST token_count event that measured something', () => {
    // Arrange
    const text = [
      tokenCount('2026-10-13T07:00:00.000Z', limits(10, 1)),
      '{"type":"response_item","payload":{"type":"message"}}',
      tokenCount('2026-10-13T07:05:00.000Z', limits(20, 2)),
      tokenCount('2026-10-13T07:06:00.000Z', null),
      'not json token_count rate_limits',
      JSON.stringify({ type: 'event_msg', payload: { type: 'other', note: 'token_count rate_limits' } }),
      '',
    ].join('\n');

    // Act
    const actual = newestRateLimitsInRollout(text, 0);

    // Assert
    should(actual).deepEqual({
      version: 1,
      source: 'codex-rollout',
      at: at('2026-10-13T07:05:00.000Z'),
      fiveHour: { usedPercent: 20, resetAt: 1_800_003_600_000 },
      weekly: { usedPercent: 2, resetAt: 1_800_500_000_000 },
    });
  });

  it('should read an older rollout reset given relative to the event, and fall back to the file time', () => {
    // Arrange
    const relative = JSON.stringify({
      type: 'event_msg',
      payload: { type: 'token_count', rate_limits: { primary: { used_percent: 55, resets_in_seconds: 60 } } },
    });

    // Act
    const actual = newestRateLimitsInRollout(relative, 1_700_000_000_000);

    // Assert
    should(actual).deepEqual({
      version: 1,
      source: 'codex-rollout',
      at: 1_700_000_000_000,
      fiveHour: { usedPercent: 55, resetAt: 1_700_000_060_000 },
    });
  });

  it('should pass over a record that is JSON but not an object', () => {
    // Arrange — lines that name both markers yet parse to a string, an array and null.
    const text = [
      tokenCount('2026-10-13T07:05:00.000Z', limits(20, 2)),
      JSON.stringify('token_count rate_limits'),
      JSON.stringify(['token_count', 'rate_limits']),
      'null',
      '',
    ].join('\n');

    // Act
    const actual = newestRateLimitsInRollout(text, 0);

    // Assert — none of them is an event, so the reading before them is still the newest.
    should(actual?.fiveHour?.usedPercent).equal(20);
  });

  it('should find nothing in a rollout with no usable reading', () => {
    // Arrange / Act / Assert
    should(newestRateLimitsInRollout(tokenCount('2026-10-13T07:00:00.000Z', { primary: {} }), 0)).be.undefined();
    should(newestRateLimitsInRollout('', 0)).be.undefined();
  });
});

describe('listRollouts and newestRolloutRateLimits', () => {
  async function tree(): Promise<{ root: string; plain: string; packed: string }> {
    const root = await sessions();
    const day = join(root, '2026', '10', '13');
    const older = join(root, '2026', '09', '01');
    await mkdir(day, { recursive: true });
    await mkdir(older, { recursive: true });
    const plain = join(day, `rollout-2026-10-13T07-00-00-${CONVERSATION}.jsonl`);
    const packed = join(older, `rollout-2026-09-01T07-00-00-${OTHER}.jsonl.zst`);
    await writeFile(plain, `${tokenCount('2026-10-13T07:05:00.000Z', limits(30, 3))}\n`);
    await writeFile(
      packed,
      Bun.zstdCompressSync(Buffer.from(`${tokenCount('2026-09-01T07:05:00.000Z', limits(70, 7))}\n`)),
    );
    await writeFile(join(day, 'not-a-rollout.txt'), 'token_count');
    await utimes(plain, new Date('2026-10-13T07:05:00Z'), new Date('2026-10-13T07:05:00Z'));
    await utimes(packed, new Date('2026-09-01T07:05:00Z'), new Date('2026-09-01T07:05:00Z'));
    return { root, plain, packed };
  }

  it('should list every rollout in the nested day directories, newest first', async () => {
    // Arrange
    const { root, plain, packed } = await tree();

    // Act
    const actual = await listRollouts(root);

    // Assert
    should(actual.map(file => [file.path, file.conversationId])).deepEqual([
      [plain, CONVERSATION],
      [packed, OTHER],
    ]);
    should(actual[0]?.modifiedAt).equal(at('2026-10-13T07:05:00.000Z'));
  });

  it('should list nothing for a sessions directory that does not exist', async () => {
    // Arrange
    const root = await sessions();

    // Act / Assert
    should(await listRollouts(join(root, 'missing'))).deepEqual([]);
  });

  it('should not walk deeper than a sessions tree goes', async () => {
    // Arrange
    const root = await sessions();
    const deep = join(root, 'a', 'b', 'c', 'd', 'e');
    await mkdir(deep, { recursive: true });
    await writeFile(join(deep, `rollout-x-${CONVERSATION}.jsonl`), '');

    // Act / Assert
    should(await listRollouts(root)).deepEqual([]);
  });

  it('should read the newest file first, decompressing an older .zst one only when the newer says nothing', async () => {
    // Arrange
    const { root, plain } = await tree();
    const files = await listRollouts(root);

    // Act
    const newest = await newestRolloutRateLimits(files);
    await writeFile(plain, '{"type":"session_meta"}\n');
    const fallback = await newestRolloutRateLimits(files);

    // Assert
    should(newest?.fiveHour?.usedPercent).equal(30);
    should(fallback?.fiveHour?.usedPercent).equal(70);
    should(fallback?.at).equal(at('2026-09-01T07:05:00.000Z'));
  });

  it('should order the files it is given by itself, and skip one it cannot read', async () => {
    // Arrange
    const { plain, packed } = await tree();
    const broken = join(await sessions(), `rollout-x-${OTHER}.jsonl.zst`);
    await writeFile(broken, 'not zstd');
    const missing: RolloutFile = { path: join(tmpdir(), 'fy-no-such-rollout.jsonl'), modifiedAt: 4_000_000_000_000 };
    const files: RolloutFile[] = [
      { path: packed, modifiedAt: 1 },
      { path: broken, modifiedAt: 3_000_000_000_000 },
      missing,
      { path: plain, modifiedAt: 2 },
    ];

    // Act
    const actual = await newestRolloutRateLimits(files);

    // Assert — the two unreadable files are newest and skipped; then `plain` (2) beats `packed` (1).
    should(actual?.fiveHour?.usedPercent).equal(30);
  });

  it('should answer nothing when no attributed rollout carries a reading', async () => {
    // Arrange / Act / Assert
    should(await newestRolloutRateLimits([])).be.undefined();
  });

  it('should find the newest reading at the end of a large rollout, and one only its start holds', async () => {
    // A busy account's rollout runs to hundreds of megabytes and used to be read whole every usage
    // pass. The newest reading is near its end, so a tail answers; the whole file is still read when
    // the tail holds none.
    // Arrange — five megabytes of ordinary records, past every tail window.
    const root = await sessions();
    const filler = `${JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(1_000) } })}\n`.repeat(5_000);
    const atEnd = join(root, `rollout-end-${CONVERSATION}.jsonl`);
    const atStart = join(root, `rollout-start-${OTHER}.jsonl`);
    await writeFile(
      atEnd,
      `${tokenCount('2026-10-13T07:00:00.000Z', limits(10, 1))}\n${filler}${tokenCount('2026-10-13T08:00:00.000Z', limits(55, 5))}\n`,
    );
    await writeFile(atStart, `${tokenCount('2026-10-13T06:00:00.000Z', limits(42, 4))}\n${filler}`);

    // Act
    const newest = await newestRolloutRateLimits([{ path: atEnd, modifiedAt: 2 }]);
    const early = await newestRolloutRateLimits([{ path: atStart, modifiedAt: 1 }]);

    // Assert
    should(newest?.fiveHour?.usedPercent).equal(55);
    should(early?.fiveHour?.usedPercent).equal(42);
  });

  it('should find a reading whose record straddles the boundary between two scanned windows', async () => {
    // The scan walks back from the end one window at a time; a record cut by a window's start must be
    // joined to the window before it, not lost between the two.
    // Arrange — the reading ends a few bytes past where the first 256 KiB window from the end begins.
    const root = await sessions();
    const reading = `${tokenCount('2026-10-13T09:00:00.000Z', limits(77, 7))}\n`;
    const tail = `${JSON.stringify({ type: 'response_item', payload: { text: 'y'.repeat(256 * 1024 - 80) } })}\n`;
    const filler = `${JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(1_000) } })}\n`.repeat(3_000);
    const file = join(root, `rollout-straddle-${CONVERSATION}.jsonl`);
    await writeFile(file, `${filler}${reading}${tail}`);

    // Act
    const found = await newestRolloutRateLimits([{ path: file, modifiedAt: 1 }]);

    // Assert
    should(Buffer.byteLength(tail)).be.below(256 * 1024);
    should(Buffer.byteLength(reading) + Buffer.byteLength(tail)).be.above(256 * 1024);
    should(found?.fiveHour?.usedPercent).equal(77);
  });

  it('should scan past one record longer than a whole window to the reading before it', async () => {
    // Arrange — a single 3 MiB record at the end: two windows find no line break at all.
    const root = await sessions();
    const giant = `${JSON.stringify({ type: 'response_item', payload: { text: 'z'.repeat(3 * 1024 * 1024) } })}\n`;
    const file = join(root, `rollout-giant-${CONVERSATION}.jsonl`);
    await writeFile(file, `${tokenCount('2026-10-13T05:00:00.000Z', limits(64, 6))}\n${giant}`);

    // Act
    const found = await newestRolloutRateLimits([{ path: file, modifiedAt: 1 }]);

    // Assert
    should(found?.fiveHour?.usedPercent).equal(64);
  });

  it('should find the newest reading in a large compressed rollout, scanned from its end', async () => {
    // Arrange
    const root = await sessions();
    const filler = `${JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(1_000) } })}\n`.repeat(5_000);
    const file = join(root, `rollout-zst-${CONVERSATION}.jsonl.zst`);
    await writeFile(
      file,
      Bun.zstdCompressSync(Buffer.from(`${tokenCount('2026-10-13T06:00:00.000Z', limits(31, 3))}\n${filler}`)),
    );

    // Act
    const found = await newestRolloutRateLimits([{ path: file, modifiedAt: 1 }]);

    // Assert
    should(found?.fiveHour?.usedPercent).equal(31);
  });

  it('should leave out a rollout it can list but not inspect', async () => {
    // Arrange — a directory that can be read but not searched names its files and refuses to stat them.
    const root = await sessions();
    const readable = join(root, '2026', '10');
    const listOnly = join(root, '2026', '09');
    await mkdir(readable, { recursive: true });
    await mkdir(listOnly, { recursive: true });
    const kept = join(readable, `rollout-2026-10-13T07-00-00-${CONVERSATION}.jsonl`);
    await writeFile(kept, '');
    await writeFile(join(listOnly, `rollout-2026-09-01T07-00-00-${OTHER}.jsonl`), '');
    await chmod(listOnly, 0o400);

    // Act
    const actual = await listRollouts(root);
    await chmod(listOnly, 0o700);

    // Assert
    should(actual.map(file => file.path)).deepEqual([kept]);
  });

  it('should skip a day directory it cannot read', async () => {
    // Arrange
    const root = await sessions();
    const unreadable = join(root, '2026');
    await mkdir(unreadable, { recursive: true });
    await writeFile(join(unreadable, `rollout-x-${CONVERSATION}.jsonl`), '');
    await chmod(unreadable, 0o000);

    // Act
    const actual = await listRollouts(root);
    await chmod(unreadable, 0o700);

    // Assert — a directory that cannot be read contributes nothing.
    should(actual).deepEqual([]);
  });
});
