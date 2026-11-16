/** The gzip adapter compresses on the thread pool and keeps its last answer. */
import { describe, expect, test } from 'bun:test';
import { gunzipSync } from 'node:zlib';
import { NodeGzip } from '../../../host/adapters/node-gzip.ts';

describe('NodeGzip', () => {
  test('makes real gzip that decompresses to the text it was given', async () => {
    const text = JSON.stringify({ items: Array.from({ length: 200 }, (_, index) => ({ index })) });
    const bytes = await new NodeGzip().gzip(text);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.byteLength).toBeLessThan(text.length);
    expect(gunzipSync(bytes).toString('utf8')).toBe(text);
  });

  test('a repeat of the same body is answered with the bytes already made, and a different body is made anew', async () => {
    const gzip = new NodeGzip();
    const first = await gzip.gzip('same body');
    expect(await gzip.gzip('same body')).toBe(first);
    const other = await gzip.gzip('another body');
    expect(other).not.toBe(first);
    expect(gunzipSync(other).toString('utf8')).toBe('another body');
  });

  test('a failure is passed on, and is not kept as the last answer', async () => {
    const gzip = new NodeGzip();
    // zlib refuses a body that is not text or bytes, and says so asynchronously, after the answer slot was taken
    await expect(gzip.gzip(5 as unknown as string)).rejects.toThrow();
    await expect(gzip.gzip(5 as unknown as string)).rejects.toThrow();
    expect(gunzipSync(await gzip.gzip('recovered')).toString('utf8')).toBe('recovered');
  });
});
