import { describe, it } from 'bun:test';
import should from 'should';
import { type TranscriptFingerprint, TranscriptTailCache } from '../../../../src/lib/session/transcript/tail-cache.ts';
import type { TranscriptEvent } from '../../../../src/lib/transcript/types.ts';

const event = (id: string): TranscriptEvent => ({
  kind: 'tool-call',
  harness: 'claude',
  role: 'assistant',
  call: { id, name: 'Bash', input: { command: 'ls' } },
});

const ids = (events: readonly TranscriptEvent[] | undefined): readonly string[] =>
  (events ?? []).map(each => (each.kind === 'tool-call' ? each.call.id : ''));

const FILE: TranscriptFingerprint = { file: '/h/big.jsonl', size: 205_000_000, mtimeMs: 1_000 };

/** A read that counts itself and answers the given events. */
const counted = (events: readonly TranscriptEvent[]) => {
  const reader = {
    reads: 0,
    read: async () => {
      reader.reads += 1;
      return events;
    },
  };
  return reader;
};

describe('TranscriptTailCache', () => {
  it('should parse an unchanged transcript once, however often it is asked for', async () => {
    // Arrange
    const cache = new TranscriptTailCache();
    const reader = counted([event('a'), event('b')]);

    // Act
    const first = await cache.events('s1', FILE, 400, reader.read);
    const again = await cache.events('s1', { ...FILE }, 400, reader.read);

    // Assert
    should(ids(first)).deepEqual(['a', 'b']);
    should(ids(again)).deepEqual(['a', 'b']);
    should(reader.reads).equal(1);
  });

  it('should parse again when the file grew, was touched or was replaced', async () => {
    // Arrange
    const cache = new TranscriptTailCache();
    const reader = counted([event('a')]);
    await cache.events('s1', FILE, 400, reader.read);

    // Act
    await cache.events('s1', { ...FILE, size: FILE.size + 10 }, 400, reader.read);
    await cache.events('s1', { ...FILE, size: FILE.size + 10, mtimeMs: 2_000 }, 400, reader.read);
    await cache.events('s1', { file: '/h/other.jsonl', size: FILE.size + 10, mtimeMs: 2_000 }, 400, reader.read);

    // Assert
    should(reader.reads).equal(4);
  });

  it('should answer a shorter ask from a longer tail, and parse again for a longer one', async () => {
    // Arrange
    const cache = new TranscriptTailCache();
    const reader = counted([event('a'), event('b'), event('c')]);
    await cache.events('s1', FILE, 3, reader.read);

    // Act
    const shorter = await cache.events('s1', FILE, 2, reader.read);
    await cache.events('s1', FILE, 10, reader.read);

    // Assert
    should(ids(shorter)).deepEqual(['b', 'c']);
    should(reader.reads).equal(2);
  });

  it('should share one parse between callers asking for the same session at once', async () => {
    // Arrange
    const cache = new TranscriptTailCache();
    let release = (): void => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    let reads = 0;
    const read = async () => {
      reads += 1;
      await gate;
      return [event('a'), event('b')];
    };

    // Act
    const asks = [cache.events('s1', FILE, 2, read), cache.events('s1', FILE, 1, read)];
    release();
    const [both, newest] = await Promise.all(asks);

    // Assert
    should(reads).equal(1);
    should(ids(both)).deepEqual(['a', 'b']);
    should(ids(newest)).deepEqual(['b']);
  });

  it('should not join a parse in flight that covers fewer events than asked', async () => {
    // Arrange
    const cache = new TranscriptTailCache();
    let reads = 0;
    const read = async () => {
      reads += 1;
      return [event('a')];
    };

    // Act
    await Promise.all([cache.events('s1', FILE, 1, read), cache.events('s1', FILE, 5, read)]);

    // Assert
    should(reads).equal(2);
  });

  it('should forget nothing it could not read, so the next ask tries again', async () => {
    // Arrange
    const cache = new TranscriptTailCache();
    let reads = 0;
    const failing = async () => {
      reads += 1;
      return undefined;
    };

    // Act
    const first = await cache.events('s1', FILE, 400, failing);
    await cache.events('s1', FILE, 400, failing);

    // Assert
    should(first).be.undefined();
    should(reads).equal(2);
  });

  it('should forget the least recently asked-for session once it holds its capacity', async () => {
    // Arrange
    const cache = new TranscriptTailCache(2);
    const reader = counted([event('a')]);
    await cache.events('s1', FILE, 1, reader.read);
    await cache.events('s2', FILE, 1, reader.read);
    await cache.events('s1', FILE, 1, reader.read);

    // Act — s3 evicts s2, the least recently used, not s1.
    await cache.events('s3', FILE, 1, reader.read);
    await cache.events('s1', FILE, 1, reader.read);
    await cache.events('s2', FILE, 1, reader.read);

    // Assert
    should(reader.reads).equal(4);
  });

  it('should parse no more transcripts at once than its concurrency allows', async () => {
    // Arrange
    const cache = new TranscriptTailCache(256, 2);
    let running = 0;
    let most = 0;
    const read = async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise(resolve => setImmediate(resolve));
      running -= 1;
      return [event('a')];
    };

    // Act — a cold listing of six sessions.
    const answers = await Promise.all(['s1', 's2', 's3', 's4', 's5', 's6'].map(id => cache.events(id, FILE, 1, read)));

    // Assert
    should(most).equal(2);
    should(answers.every(answer => answer?.length === 1)).be.true();
  });

  it('should release its slot when a parse throws, and not remember the failure', async () => {
    // Arrange
    const cache = new TranscriptTailCache(256, 1);
    const boom = async (): Promise<readonly TranscriptEvent[]> => {
      throw new Error('the disk went away');
    };

    // Act
    const failed = await cache.events('s1', FILE, 1, boom).catch((error: Error) => error.message);
    const next = await cache.events('s2', FILE, 1, async () => [event('b')]);

    // Assert
    should(failed).equal('the disk went away');
    should(ids(next)).deepEqual(['b']);
  });
});
