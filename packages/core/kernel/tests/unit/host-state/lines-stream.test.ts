import { describe, expect, test } from 'bun:test';
import { StoreDamagedError } from '../../../host/state/errors.ts';
import { createStatePort } from '../../../host/state/state-port.ts';
import { JSONL_CHUNK_BYTES, streamJsonlLines } from '../../../host/state/stream-lines.ts';
import { readJsonlLines } from '../../../host/state/readers.ts';
import { allFiles, HOME, logFile, memoryStore } from './support.ts';

const good = (count: number) => `{"format":1,"count":${count}}`;
/** Enough lines to fill several pieces of the stream. */
const MANY = Math.ceil((JSONL_CHUNK_BYTES * 5) / (good(100_000).length + 1));

function journalText(total: number, bad: readonly number[] = []): string {
  const rows = Array.from({ length: total }, (_, index) => (bad.includes(index) ? 'not json' : good(index)));
  return `${rows.join('\n')}\n`;
}

/** The memory file system with the whole-file reads refused and every piece the stream takes counted. */
function watched() {
  const { fs, path } = memoryStore();
  const seen = { pieces: 0, whole: 0 };
  const wrapped = {
    ...fs,
    readBytes: async (at: string) => {
      seen.whole += 1;
      return fs.readBytes(at);
    },
    readText: async (at: string) => {
      seen.whole += 1;
      return fs.readText(at);
    },
    streamBytes: (at: string, size: number, onChunk: (chunk: Uint8Array) => void | Promise<void>) =>
      fs.streamBytes(at, size, async chunk => {
        seen.pieces += 1;
        await onChunk(chunk);
      }),
  };
  return { fs, wrapped, seen, path };
}

describe('state.lines streams the file', () => {
  test('lines yields the first record before the whole file is read, and never reads it whole', async () => {
    const { fs, wrapped, seen, path } = watched();
    fs.seed(path('log.jsonl'), journalText(MANY));
    const port = createStatePort({ home: HOME, pluginId: 'demo', files: allFiles, fs: wrapped });
    let first: unknown;
    for await (const record of port.lines(logFile)) {
      first = record;
      break;
    }
    expect(first).toEqual({ count: 0 });
    // One piece of about five was taken; the file read stopped when the reader did.
    expect(seen.pieces).toBe(1);
    expect(seen.whole).toBe(0);
  });

  test('the file is read only as fast as the records are taken', async () => {
    const { fs, wrapped, seen, path } = watched();
    fs.seed(path('log.jsonl'), journalText(MANY));
    const port = createStatePort({ home: HOME, pluginId: 'demo', files: allFiles, fs: wrapped });
    let taken = 0;
    let piecesWhenTaken = 0;
    for await (const record of port.lines(logFile)) {
      taken += 1;
      expect(record).toEqual({ count: taken - 1 });
      // The producer never runs more than one piece ahead of the record in hand.
      piecesWhenTaken = Math.max(piecesWhenTaken, seen.pieces - Math.floor(((taken - 1) * 30) / JSONL_CHUNK_BYTES));
    }
    expect(taken).toBe(MANY);
    expect(seen.pieces).toBeGreaterThanOrEqual(5);
    expect(piecesWhenTaken).toBeLessThanOrEqual(2);
    expect(seen.whole).toBe(0);
  });

  test('bad lines are skipped and counted, across piece boundaries, as the whole-file reader counts them', async () => {
    const { fs, path } = memoryStore();
    const bad = [0, 3, Math.floor(MANY / 2), MANY - 2];
    fs.seed(path('log.jsonl'), journalText(MANY, bad));
    const stream = streamJsonlLines(fs, logFile, path('log.jsonl'), 'demo/log.jsonl');
    const records: { count: number }[] = [];
    let step = await stream.next();
    while (!step.done) {
      records.push(step.value);
      step = await stream.next();
    }
    expect(step.value).toEqual({ ok: true, value: bad.length });
    const whole = await readJsonlLines(fs, logFile, path('log.jsonl'), 'demo/log.jsonl');
    expect(whole.ok && whole.value.records).toEqual(records);
    expect(whole.ok && whole.value.unreadable).toBe(bad.length);
    expect(records).toHaveLength(MANY - bad.length);
  });

  test('a torn last line is neither a record nor a count', async () => {
    const { fs, path } = memoryStore();
    fs.seed(path('log.jsonl'), `${good(1)}\n${good(2)}\n{"format":1,"cou`);
    const stream = streamJsonlLines(fs, logFile, path('log.jsonl'), 'demo/log.jsonl');
    expect(await stream.next()).toEqual({ done: false, value: { count: 1 } });
    expect(await stream.next()).toEqual({ done: false, value: { count: 2 } });
    expect(await stream.next()).toEqual({ done: true, value: { ok: true, value: 0 } });
  });

  test('a missing file is empty, a missing required file is damage, an io fault keeps what was read', async () => {
    const { fs, path } = memoryStore();
    const drain = async (def: typeof logFile, at: string, over = fs) => {
      const stream = streamJsonlLines(over, def, at, 'demo/log.jsonl');
      const got: unknown[] = [];
      let step = await stream.next();
      while (!step.done) {
        got.push(step.value);
        step = await stream.next();
      }
      return { got, end: step.value };
    };
    expect(await drain(logFile, path('log.jsonl'))).toEqual({ got: [], end: { ok: true, value: 0 } });
    const required = { ...logFile, required: true } as typeof logFile;
    expect((await drain(required, path('log.jsonl'))).end).toMatchObject({ ok: false, error: { reason: 'missing' } });

    fs.seed(path('log.jsonl'), journalText(MANY));
    const failing = {
      ...fs,
      streamBytes: async (at: string, size: number, onChunk: (chunk: Uint8Array) => void | Promise<void>) => {
        let pieces = 0;
        return fs.streamBytes(at, size, async chunk => {
          if (pieces === 2) throw new Error('disk fell over');
          pieces += 1;
          await onChunk(chunk);
        });
      },
    };
    const cut = await drain(logFile, path('log.jsonl'), failing);
    expect(cut.got.length).toBeGreaterThan(0);
    expect(cut.got.length).toBeLessThan(MANY);
    expect(cut.end).toMatchObject({ ok: false, error: { reason: 'io' } });
  });

  test('an io fault ends port.lines with the damage noted; the records before it were handed out', async () => {
    const { fs, path } = memoryStore();
    fs.seed(path('log.jsonl'), journalText(MANY));
    const failing = {
      ...fs,
      streamBytes: async (at: string, size: number, onChunk: (chunk: Uint8Array) => void | Promise<void>) => {
        let pieces = 0;
        return fs.streamBytes(at, size, async chunk => {
          if (pieces === 1) throw new Error('disk fell over');
          pieces += 1;
          await onChunk(chunk);
        });
      },
    };
    const port = createStatePort({ home: HOME, pluginId: 'demo', files: allFiles, fs: failing });
    let taken = 0;
    // The file's policy is 'subsystem' (the default): the fault is thrown after the records already handed out.
    await expect(
      (async () => {
        for await (const record of port.lines(logFile)) {
          expect(record).toEqual({ count: taken });
          taken += 1;
        }
      })(),
    ).rejects.toBeInstanceOf(StoreDamagedError);
    expect(taken).toBeGreaterThan(0);
    expect(taken).toBeLessThan(MANY);
    expect(port.damaged().map(damage => damage.reason)).toEqual(['io']);
  });
});
