import { describe, expect, test } from 'bun:test';
import { JsonlScanner, scanJsonl } from '../../../host/state/jsonl-scan.ts';
import { inspectStateFile, readJsonlRecords } from '../../../host/state/readers.ts';
import { nodeSqliteFiles } from '../../../host/state/sqlite-store.ts';
import { logFile, memoryStore } from './support.ts';

const required = { ...logFile, required: true } as typeof logFile;
const good = (count: number) => `{"format":1,"count":${count}}`;

/** The boot check of `log.jsonl` over the given text, with the whole-file read refused: it must stream. */
async function inspect(text: string | undefined, def: typeof logFile = logFile) {
  const { fs, path } = memoryStore();
  if (text !== undefined) fs.seed(path('log.jsonl'), text);
  let wholeReads = 0;
  const watched = {
    ...fs,
    readBytes: async (at: string) => {
      wholeReads += 1;
      return fs.readBytes(at);
    },
    readText: async (at: string) => {
      wholeReads += 1;
      return fs.readText(at);
    },
  };
  const damage = await inspectStateFile(watched, def, path('log.jsonl'), 'demo/log.jsonl', nodeSqliteFiles);
  // The verdict is the one the whole-file reader gives.
  const whole = await readJsonlRecords(fs, def, path('log.jsonl'), 'demo/log.jsonl');
  expect(damage).toEqual(whole.ok ? undefined : whole.error);
  return { damage, wholeReads };
}

describe('inspectStateFile on a jsonl file streams the file', () => {
  test('a good file is ok', async () => {
    expect((await inspect(`${good(1)}\n${good(2)}\n`)).damage).toBeUndefined();
  });

  test('never reads the file whole: the verdict comes from pieces', async () => {
    const { damage, wholeReads } = await inspect(`${good(1)}\n`);
    expect(damage).toBeUndefined();
    expect(wholeReads).toBe(0);
  });

  test('a file far larger than one piece is judged line by line', async () => {
    const lines = Array.from({ length: 20_000 }, (_, i) => good(i));
    expect((await inspect(`${lines.join('\n')}\n`)).damage).toBeUndefined();
    const broken = [...lines.slice(0, 15_000), 'not json', ...lines.slice(15_000)];
    expect((await inspect(`${broken.join('\n')}\n`)).damage).toMatchObject({
      reason: 'unparsable',
      sentence: expect.stringContaining('(line 15001: record is not valid JSON)'),
    });
  });

  test('an empty file is ok; an empty required file is ok; a missing optional file is ok', async () => {
    expect((await inspect('')).damage).toBeUndefined();
    expect((await inspect('', required)).damage).toBeUndefined();
    expect((await inspect(undefined)).damage).toBeUndefined();
  });

  test('a missing required file is damaged (missing)', async () => {
    expect((await inspect(undefined, required)).damage).toMatchObject({ reason: 'missing', file: 'demo/log.jsonl' });
  });

  test('a torn last line is ignored', async () => {
    expect((await inspect(`${good(1)}\n{"format":1,"cou`)).damage).toBeUndefined();
  });

  test('a bad line in the middle is unparsable and names its line', async () => {
    expect((await inspect(`${good(1)}\nnope\n${good(3)}\n`)).damage).toMatchObject({
      reason: 'unparsable',
      sentence: expect.stringContaining('(line 2: record is not valid JSON)'),
    });
  });

  test('a record over the size cap is unparsable even when it is the last line', async () => {
    const huge = JSON.stringify({ format: 1, count: 1, pad: 'x'.repeat(1 << 20) });
    expect((await inspect(`${good(1)}\n${huge}`)).damage).toMatchObject({
      reason: 'unparsable',
      sentence: expect.stringContaining('line 2: record exceeds the maximum'),
    });
  });

  test('a record that fails its schema is damaged, and a bad line anywhere wins over it', async () => {
    const wrong = '{"format":1,"count":"x"}';
    const schema = await inspect(`${good(1)}\n${wrong}\n`);
    expect(schema.damage?.file).toBe('demo/log.jsonl');
    expect(schema.damage?.reason).not.toBe('unparsable');
    expect((await inspect(`${wrong}\nnope\n`)).damage?.reason).toBe('unparsable');
  });

  test('a read fault is an io damage', async () => {
    const { fs, path } = memoryStore();
    const broken = {
      ...fs,
      streamBytes: async () => {
        throw new Error('disk gone');
      },
    };
    expect(await inspectStateFile(broken, logFile, path('log.jsonl'), 'demo/log.jsonl', nodeSqliteFiles)).toMatchObject(
      {
        reason: 'io',
      },
    );
  });
});

describe('JsonlScanner agrees with scanJsonl however the bytes are cut', () => {
  const text = `${good(1)}\n\n  \n${good(2)}\nnope\né${good(3)}\n${good(4)}\n{"torn`;
  const bytes = new TextEncoder().encode(text);

  test.each([1, 2, 3, 7, 64, bytes.byteLength])('in pieces of %p bytes', size => {
    const records: unknown[] = [];
    const problems: unknown[] = [];
    let torn = 0;
    const scanner = new JsonlScanner({
      record: r => void records.push(r),
      problem: p => void problems.push(p),
      tornTail: () => {
        torn += 1;
      },
    });
    for (let at = 0; at < bytes.byteLength; at += size) scanner.push(bytes.slice(at, at + size));
    scanner.end();
    const whole = scanJsonl(bytes);
    expect(records).toEqual([...whole.records]);
    expect(problems).toEqual([...whole.problems]);
    expect(torn).toBe(whole.tornTail ? 1 : 0);
  });

  test('a line over the cap is counted across pieces and never held', () => {
    const problems: { line: number; byteOffset: number }[] = [];
    const scanner = new JsonlScanner(
      { record: () => undefined, problem: p => void problems.push(p), tornTail: () => undefined },
      { maxRecordBytes: 10 },
    );
    for (const piece of ['aaaa', 'aaaa', 'aaaa', '\nok', '\n']) scanner.push(new TextEncoder().encode(piece));
    scanner.end();
    expect(problems.map(p => p.line)).toEqual([1, 2]);
    expect(problems[1]?.byteOffset).toBe(13);
  });

  test('bytes the caller reuses after a push do not change the line in progress', () => {
    const records: unknown[] = [];
    const scanner = new JsonlScanner({
      record: r => void records.push(r.value),
      problem: () => undefined,
      tornTail: () => undefined,
    });
    const buffer = new Uint8Array(4);
    buffer.set(new TextEncoder().encode('{"a"'));
    scanner.push(buffer);
    buffer.set(new TextEncoder().encode('XXXX'));
    scanner.push(new TextEncoder().encode(':1}\n'));
    expect(records).toEqual([{ a: 1 }]);
  });
});
