import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineState } from '../../../contract/index.ts';
import { StoreDamagedError, UndeclaredStateFileError } from '../../../host/state/errors.ts';
import {
  allFiles,
  blobFile,
  cardFile,
  counterFile,
  keyFile,
  logFile,
  memoryStore,
  requiredFile,
  rulesFile,
} from './support.ts';

describe('StatePort: json files and the one-format rule', () => {
  test('a write puts "format" first and a read hands back the value without it', async () => {
    const { port, fs, path } = memoryStore();
    await port.write(counterFile, { count: 3 });
    const text = fs.snapshot().get(path('counter.json')) ?? '';
    expect(text.trimStart().startsWith('{\n  "format": 2,')).toBe(true);
    expect(await port.read(counterFile)).toEqual({ ok: true, value: { count: 3 } });
  });

  test('a file that does not exist reads as undefined, not as damage', async () => {
    const { port } = memoryStore();
    expect(await port.read(counterFile)).toEqual({ ok: true, value: undefined });
    expect(port.damaged()).toEqual([]);
  });

  const refusals: ReadonlyArray<readonly [string, string, string]> = [
    ['unparsable', '{ not json', 'unparsable'],
    ['no_format (no key)', '{"count":1}', 'no_format'],
    ['no_format (not an object)', '[1,2]', 'no_format'],
    ['lower_format', '{"format":1,"count":1}', 'lower_format'],
    ['higher_format', '{"format":3,"count":1}', 'higher_format'],
    ['schema', '{"format":2,"count":"many"}', 'schema'],
  ];
  for (const [name, text, reason] of refusals) {
    test(`a ${name} file is damaged with a sentence naming it, and nothing is rewritten`, async () => {
      const { port, fs, path } = memoryStore();
      fs.seed(path('counter.json'), text);
      const read = await port.read(counterFile);
      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.error.reason).toBe(reason as typeof read.error.reason);
      expect(read.error.file).toBe('state/demo/counter.json');
      expect(read.error.sentence).toContain('state/demo/counter.json');
      expect(port.damaged()).toEqual([read.error]);
      expect(fs.snapshot().get(path('counter.json'))).toBe(text);
    });
  }

  test('a required file that is missing is damaged (missing), not empty', async () => {
    const { port } = memoryStore();
    const read = await port.read(requiredFile);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error.reason).toBe('missing');
  });

  test('a read fault is damaged (io)', async () => {
    const { port, fs } = memoryStore();
    fs.readText = async () => {
      throw new Error('EIO: disk gone');
    };
    const read = await port.read(counterFile);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error.reason).toBe('io');
  });

  test('a damaged file is never written over, update included; repairing it clears the damage', async () => {
    const { port, fs, path } = memoryStore();
    fs.seed(path('counter.json'), '{ broken');
    await port.read(counterFile);
    await expect(port.write(counterFile, { count: 1 })).rejects.toBeInstanceOf(StoreDamagedError);
    const updated = await port.update(counterFile, () => ({ count: 9 }));
    expect(updated.ok).toBe(false);
    expect(fs.snapshot().get(path('counter.json'))).toBe('{ broken');
    fs.seed(path('counter.json'), '{"format":2,"count":5}');
    await port.write(counterFile, { count: 6 });
    expect(port.damaged()).toEqual([]);
  });

  test('a schema-less file is read as the object it holds', async () => {
    const free = defineState({ name: 'free', path: 'free.json', store: 'json', format: 1 });
    const { port } = memoryStore({ files: [free] });
    await port.write(free, { anything: [1, 2] });
    expect(await port.read(free)).toEqual({ ok: true, value: { anything: [1, 2] } });
  });

  test('a value that fails its schema is refused before it is written', async () => {
    const { port, fs, path } = memoryStore();
    await expect(port.write(counterFile, { count: 'x' } as never)).rejects.toBeInstanceOf(TypeError);
    expect(fs.snapshot().has(path('counter.json'))).toBe(false);
  });
});

describe('StatePort: narrower damaged policy', () => {
  test('a damaged file with a narrower policy reads as empty, and the subsystem stays up', async () => {
    const events: string[] = [];
    const { port, fs, path } = memoryStore({ report: event => events.push(`${event.policy}:${event.damage.reason}`) });
    fs.seed(path('sign-in-rules.json'), '{"format":1,"rules":42}');
    expect(await port.read(rulesFile)).toEqual({ ok: true, value: undefined });
    expect(port.damaged()).toEqual([]);
    expect(port.narrowed().map(d => d.reason)).toEqual(['schema']);
    expect(events).toEqual(['narrower:schema']);
  });

  test('a damaged file with the default policy damages the subsystem', async () => {
    const { port, fs, path } = memoryStore();
    fs.seed(path('counter.json'), 'nope');
    await port.read(counterFile);
    expect(port.damaged()).toHaveLength(1);
    expect(port.narrowed()).toEqual([]);
  });

  test('a narrower file is not overwritten either while it is damaged', async () => {
    const { port, fs, path } = memoryStore();
    fs.seed(path('sign-in-rules.json'), 'garbage');
    await port.read(rulesFile);
    await expect(port.write(rulesFile, { rules: [] })).rejects.toBeInstanceOf(StoreDamagedError);
  });
});

describe('StatePort: update, collections, refusals', () => {
  test('update is one serialization chain per file: concurrent increments all land', async () => {
    const { port } = memoryStore();
    await port.write(counterFile, { count: 0 });
    await Promise.all(
      Array.from({ length: 20 }, () => port.update(counterFile, current => ({ count: (current?.count ?? 0) + 1 }))),
    );
    expect(await port.read(counterFile)).toEqual({ ok: true, value: { count: 20 } });
  });

  test('update that throws writes nothing and does not poison the chain', async () => {
    const { port } = memoryStore();
    await port.write(counterFile, { count: 1 });
    await expect(
      port.update(counterFile, () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const next = await port.update(counterFile, c => ({ count: (c?.count ?? 0) + 1 }));
    expect(next).toEqual({ ok: true, value: { count: 2 } });
  });

  test('a collection fills the * with a name, lists names sorted, and removes one', async () => {
    const { port } = memoryStore();
    await port.write(cardFile, { count: 1 }, 'b');
    await port.write(cardFile, { count: 2 }, 'a');
    expect(await port.list(cardFile)).toEqual(['a', 'b']);
    expect(await port.read(cardFile, 'a')).toEqual({ ok: true, value: { count: 2 } });
    await port.remove(cardFile, 'a');
    expect(await port.list(cardFile)).toEqual(['b']);
  });

  test('a collection needs a name, a single file takes none, and a name cannot climb out', async () => {
    const { port } = memoryStore();
    await expect(port.read(cardFile)).rejects.toBeInstanceOf(UndeclaredStateFileError);
    await expect(port.read(counterFile, 'x')).rejects.toBeInstanceOf(UndeclaredStateFileError);
    for (const bad of ['..', '../x', 'a/b', '', '.hidden']) {
      await expect(port.read(cardFile, bad)).rejects.toBeInstanceOf(UndeclaredStateFileError);
    }
  });

  test('a file the plugin did not declare is refused', async () => {
    const { port } = memoryStore();
    const stranger = defineState({ name: 'stranger', path: 'stranger.json', store: 'json', format: 1 });
    await expect(port.read(stranger)).rejects.toBeInstanceOf(UndeclaredStateFileError);
    await expect(port.write(stranger, {})).rejects.toBeInstanceOf(UndeclaredStateFileError);
    const sameNameOtherPath = defineState({ name: 'counter', path: '../escape.json', store: 'json', format: 2 });
    await expect(port.read(sameNameOtherPath)).rejects.toBeInstanceOf(UndeclaredStateFileError);
  });

  test('declaring a path that leaves the plugin folder, or two files on one path, is refused at creation', () => {
    const outside = defineState({ name: 'outside', path: '../x.json', store: 'json', format: 1 });
    expect(() => memoryStore({ files: [outside] })).toThrow(UndeclaredStateFileError);
    const one = defineState({ name: 'one', path: 'same.json', store: 'json', format: 1 });
    const two = defineState({ name: 'two', path: 'same.json', store: 'json', format: 1 });
    expect(() => memoryStore({ files: [one, two] })).toThrow(UndeclaredStateFileError);
  });

  test('every store writes under state/<id>/ with the def mode, secrets 0600', async () => {
    const roomy = defineState({ name: 'roomy', path: 'roomy.json', store: 'json', format: 1, mode: 0o640 });
    const { port, fs, path } = memoryStore({ files: [...allFiles, roomy] });
    await port.write(roomy, { a: 1 });
    await port.write(keyFile, new Uint8Array([1, 2, 3]));
    expect(fs.modeOf(path('roomy.json'))).toBe(0o640);
    expect(fs.modeOf(path('message-token.key'))).toBe(0o600);
  });
});

describe('StatePort: secret and opaque files', () => {
  test('a secret is byte for byte what was written and is never parsed', async () => {
    const { port } = memoryStore();
    const bytes = new Uint8Array([0, 255, 10, 13, 123, 125]);
    await port.write(keyFile, bytes);
    const read = await port.read(keyFile);
    expect(read.ok && [...(read.value as Uint8Array)]).toEqual([...bytes]);
  });

  test('a secret and an opaque file are not updated in place (never re-sealed)', async () => {
    const { port } = memoryStore();
    await expect(port.update(keyFile as never, () => new Uint8Array() as never)).rejects.toBeInstanceOf(TypeError);
    await expect(port.update(blobFile as never, () => new Uint8Array() as never)).rejects.toBeInstanceOf(TypeError);
  });

  test('opaque bytes with no "format" are fine, and a required one missing is damaged', async () => {
    const need = defineState({ name: 'need', path: 'need.bin', store: 'opaque', format: 1, required: true });
    const { port, fs, path } = memoryStore({ files: [need] });
    expect((await port.read(need)).ok).toBe(false);
    fs.seed(path('need.bin'), 'raw text, not json');
    expect(await port.read(need)).toMatchObject({ ok: true });
  });
});

describe('StatePort: jsonl files', () => {
  test('each appended line carries its format first and lines() hands the entries back', async () => {
    const { port, fs, path } = memoryStore();
    await port.append(logFile, { count: 1 });
    await port.append(logFile, { count: 2 });
    const text = fs.snapshot().get(path('log.jsonl')) ?? '';
    expect(
      text
        .split('\n')
        .filter(Boolean)
        .map(line => line.startsWith('{"format":1,')),
    ).toEqual([true, true]);
    const got: unknown[] = [];
    for await (const entry of port.lines(logFile)) got.push(entry);
    expect(got).toEqual([{ count: 1 }, { count: 2 }]);
  });

  test('a crash that cut the last line short is a torn tail: ignored, and the next append starts a new line', async () => {
    const { port, fs, path } = memoryStore();
    fs.seed(path('log.jsonl'), '{"format":1,"count":1}\n{"format":1,"cou');
    const got: unknown[] = [];
    for await (const entry of port.lines(logFile)) got.push(entry);
    expect(got).toEqual([{ count: 1 }]);
    await port.append(logFile, { count: 2 });
    const again: unknown[] = [];
    for await (const entry of port.lines(logFile)) again.push(entry);
    expect(again).toEqual([{ count: 1 }, { count: 2 }]);
  });

  test('a bad line in the middle, a lower format line or a schema failure damages the whole file', async () => {
    const cases = [
      '{"format":1,"count":1}\nnot json\n{"format":1,"count":2}\n',
      '{"format":1,"count":1}\n{"format":0,"count":2}\n',
      '{"format":1,"count":1}\n{"format":1,"count":"x"}\n',
    ];
    for (const text of cases) {
      const { port, fs, path } = memoryStore();
      fs.seed(path('log.jsonl'), text);
      await expect(
        (async () => {
          for await (const _ of port.lines(logFile)) void _;
        })(),
      ).rejects.toBeInstanceOf(StoreDamagedError);
      expect(port.damaged()).toHaveLength(1);
    }
  });

  test('an oversized record is refused at append, so a read never meets one', async () => {
    const big = defineState({
      name: 'big',
      path: 'big.jsonl',
      store: 'jsonl',
      format: 1,
      schema: z.strictObject({ text: z.string() }),
    });
    const { port } = memoryStore({ files: [big] });
    await expect(port.append(big, { text: 'x'.repeat(1 << 20) })).rejects.toThrow('exceeds the maximum');
  });

  test('read() on a jsonl file is a programming error', async () => {
    const { port } = memoryStore();
    await expect(port.read(logFile)).rejects.toBeInstanceOf(TypeError);
  });
});

describe('StatePort: records() and tail() check each line on its own', () => {
  const two = '{"format":1,"count":1}\n{"format":1,"count":2}\n';
  test('T 2 valid + 2 malformed lines: 2 records and unreadable 2, and the file is not damaged', async () => {
    const { port, fs, path } = memoryStore();
    fs.seed(
      path('log.jsonl'),
      `{"format":1,"count":1}\n{ not json\n{"format":1,"count":"x"}\n{"format":1,"count":2}\n`,
    );
    expect(await port.records(logFile)).toEqual({ records: [{ count: 1 }, { count: 2 }], unreadable: 2 });
    expect(port.damaged()).toEqual([]);
  });

  test('a torn last line is not counted; a missing file is no records', async () => {
    const { port, fs, path } = memoryStore();
    expect(await port.records(logFile)).toEqual({ records: [], unreadable: 0 });
    fs.seed(path('log.jsonl'), `${two}{"format":1,"cou`);
    expect(await port.records(logFile)).toEqual({ records: [{ count: 1 }, { count: 2 }], unreadable: 0 });
  });

  test('U tail reads only the end of a large file, drops the line its window cut, and checks each line', async () => {
    const { port, fs, path } = memoryStore();
    const many = Array.from({ length: 5000 }, (_, i) => `{"format":1,"count":${i}}`).join('\n');
    fs.seed(path('log.jsonl'), `${many}\n{ bad\n{"format":1,"count":5000}\n`);
    const tail = await port.tail(logFile, { maxBytes: 64 });
    expect(tail.records.at(-1)).toEqual({ count: 5000 });
    expect(tail.unreadable).toBe(1);
    expect(tail.records.length).toBeLessThan(4);
    // the whole file fits: every record, nothing dropped
    expect((await port.tail(logFile, { maxBytes: 1024 * 1024 })).records).toHaveLength(5001);
  });

  test('tail refuses a window outside 1..MAX_STATE_TAIL_BYTES, and a non-jsonl file', async () => {
    const { port } = memoryStore();
    await expect(port.tail(logFile, { maxBytes: 0 })).rejects.toThrow(TypeError);
    await expect(port.tail(logFile, { maxBytes: 2 ** 40 })).rejects.toThrow(TypeError);
    await expect(port.records(counterFile as never)).rejects.toThrow(TypeError);
  });
});
