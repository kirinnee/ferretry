import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { defineState } from '../../../contract/define.ts';
import { MemoryStateFolder } from '../../../testing/state.ts';

const Sealed = defineState({ name: 'sealed', path: 'vault.sealed', store: 'secret', format: 1 });
const Blob = defineState({ name: 'blob', path: 'blobs/*.bin', store: 'opaque', format: 1 });
const Doc = defineState({
  name: 'doc',
  path: 'doc.json',
  store: 'json',
  format: 1,
  schema: z.strictObject({ n: z.number() }),
});

describe('the test host state port mirrors the real one for secret and opaque stores', () => {
  test('bytes in, the same bytes out: no schema parse, no format stamp', async () => {
    const folder = new MemoryStateFolder();
    const port = folder.port([Sealed, Blob, Doc]);
    const bytes = new Uint8Array([0, 255, 123, 34, 102, 111, 114, 109, 97, 116, 34]);
    await port.write(Sealed, bytes as never);
    const read = await port.read(Sealed);
    expect(read.ok && read.value).toEqual(bytes);
    expect(read.ok && read.value instanceof Uint8Array).toBe(true);
    expect(folder.rawBytes(Sealed)).toEqual(bytes);
    expect(folder.raw(Sealed)).toBeUndefined();
  });

  test('a string is stored as its UTF-8 bytes and read back as bytes; collections list by name', async () => {
    const folder = new MemoryStateFolder();
    const port = folder.port([Blob]);
    await port.write(Blob, 'not json at all' as never, 'a');
    await port.write(Blob, new Uint8Array([1, 2]) as never, 'b');
    const read = await port.read(Blob, 'a');
    expect(read.ok && new TextDecoder().decode(read.value as Uint8Array)).toBe('not json at all');
    expect(await port.list(Blob)).toEqual(['a', 'b']);
    await port.remove(Blob, 'a');
    expect(await port.list(Blob)).toEqual(['b']);
  });

  test('a byte file refuses a non-byte value, update and append, as the real port does', async () => {
    const port = new MemoryStateFolder().port([Sealed]);
    await expect(port.write(Sealed, { n: 1 } as never)).rejects.toThrow(TypeError);
    await expect(port.update(Sealed, () => new Uint8Array() as never)).rejects.toThrow(TypeError);
    await expect(port.append(Sealed, new Uint8Array() as never)).rejects.toThrow(TypeError);
    expect((await port.read(Sealed)).ok).toBe(true);
  });

  test('a json file still stamps its format first', async () => {
    const folder = new MemoryStateFolder();
    await folder.port([Doc]).write(Doc, { n: 3 });
    expect(folder.raw(Doc)).toBe('{"format":1,"n":3}');
  });
});

describe('the test host state port: records() and tail() as the real one', () => {
  const Log = defineState({
    name: 'log',
    path: 'log.jsonl',
    store: 'jsonl',
    format: 1,
    schema: z.strictObject({ n: z.number() }),
  });
  test('2 valid + 2 malformed lines: 2 records and unreadable 2; a torn last line is not counted', async () => {
    const folder = new MemoryStateFolder();
    const port = folder.port([Log]);
    folder.plant(Log, '{"format":1,"n":1}\n{ bad\n{"format":1,"n":"x"}\n{"format":1,"n":2}\n{"format":1,"n');
    expect(await port.records(Log)).toEqual({ records: [{ n: 1 }, { n: 2 }], unreadable: 2 });
  });
  test('tail reads the end and drops the line its window cut', async () => {
    const folder = new MemoryStateFolder();
    const port = folder.port([Log]);
    folder.plant(Log, `${Array.from({ length: 100 }, (_, n) => `{"format":1,"n":${n}}`).join('\n')}\n`);
    const tail = await port.tail(Log, { maxBytes: 40 });
    expect(tail.records.at(-1)).toEqual({ n: 99 });
    expect(tail.unreadable).toBe(0);
    expect(tail.records.length).toBeLessThan(3);
  });
});

describe('the test host state port: lines() skips, update() declines, version()', () => {
  const Log = defineState({
    name: 'log',
    path: 'log.jsonl',
    store: 'jsonl',
    format: 1,
    schema: z.strictObject({ n: z.number() }),
  });
  test('lines skips a bad line; update with the same value writes nothing; version moves with the bytes', async () => {
    const folder = new MemoryStateFolder();
    const port = folder.port([Log, Doc]);
    folder.plant(Log, '{"format":1,"n":1}\n{ bad\n{"format":1,"n":2}\n');
    const seen: unknown[] = [];
    for await (const record of port.lines(Log)) seen.push(record);
    expect(seen).toEqual([{ n: 1 }, { n: 2 }]);
    await port.write(Doc, { n: 1 });
    const raw = folder.raw(Doc);
    const v1 = await port.version(Doc);
    expect(await port.update(Doc, async current => current as { n: number })).toEqual({ ok: true, value: { n: 1 } });
    expect(folder.raw(Doc)).toBe(raw);
    expect(await port.version(Doc)).toEqual(v1);
    await port.update(Doc, current => ({ n: (current?.n ?? 0) + 1 }));
    expect((await port.version(Doc))?.etag).not.toBe(v1?.etag);
  });
});

describe('LL the test host state port: opaque bytes and sqlite collections, as the real port', () => {
  const Db = defineState({ name: 'db', path: 'versions/*.sqlite', store: 'sqlite', format: 1 });
  test('an opaque file keeps its bytes (no JSON stamp); sqlite collection members are listed and removed', async () => {
    const folder = new MemoryStateFolder();
    const port = folder.port([Blob, Db]);
    const bytes = new Uint8Array([123, 34, 0, 255]);
    await port.write(Blob, bytes as never, 'x');
    expect(folder.rawBytes(Blob, 'x')).toEqual(bytes);
    expect(folder.raw(Blob, 'x')).toBeUndefined();
    port.sqlite(Db, 'a').run('CREATE TABLE t (n INTEGER)');
    port.sqlite(Db, 'b').run('CREATE TABLE t (n INTEGER)');
    expect(await port.list(Db)).toEqual(['a', 'b']);
    await port.remove(Db, 'a');
    expect(await port.list(Db)).toEqual(['b']);
  });
});

describe('SS the test host state port hands out an opaque file path only', () => {
  test('opaque yes, json no', () => {
    const port = new MemoryStateFolder().port([Blob]);
    expect(port.pathOf(Blob, 'x')).toContain('x');
    const Json = defineState({ name: 'j', path: 'j.json', store: 'json', format: 1, schema: z.strictObject({}) });
    expect(() => new MemoryStateFolder().port([Json]).pathOf(Json)).toThrow(TypeError);
  });
});
