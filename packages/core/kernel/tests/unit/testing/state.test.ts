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
