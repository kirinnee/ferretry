import { expect, test } from 'bun:test';
import { ApiError } from '@ferretry/kernel/contract';
import { HarnessTranscriptReplaced } from '../../../../contract/index.ts';
import { additivesFixture } from './additives-fixture.ts';

const BYTES = new TextEncoder().encode('{"a":1}\n{"b":2}\n');

test('G162: the seam surfaces the bytes its ferret’s harness proved, bound to that ferret', async () => {
  const f = additivesFixture();
  f.harness.bytes.set(f.id, BYTES);
  const seam = (await f.service.harness(f.id))!;
  const handle = await seam.transcriptBytes!();
  expect(handle).toBeDefined();
  expect(handle!.format).toBe('claude');
  expect(handle!.size).toBe(BYTES.length);
  expect(await handle!.read(0, 7)).toEqual(BYTES.slice(0, 7));
  // Short only where the file ends.
  expect(await handle!.read(BYTES.length - 3, 100)).toEqual(BYTES.slice(-3));
  expect(await handle!.stat()).toEqual({ size: BYTES.length, mtimeMs: handle!.mtimeMs });
  // Bound: the harness is asked about the seam's own ferret, and the seam takes no ferret argument.
  expect(f.harness.bytesAsked).toEqual([f.id]);
  expect(seam.transcriptBytes!.length).toBe(0);
});

test('G162: the handle names no path', async () => {
  const f = additivesFixture();
  f.harness.bytes.set(f.id, BYTES);
  const handle = (await (await f.service.harness(f.id))!.transcriptBytes!())!;
  expect(Object.keys(handle).sort()).toEqual(['close', 'file', 'format', 'mtimeMs', 'read', 'size', 'stat']);
  expect(handle.file).not.toContain('/');
});

test('G162: a ferret whose harness proves no transcript has no bytes (undefined, not a throw)', async () => {
  const f = additivesFixture();
  const seam = (await f.service.harness(f.id))!;
  expect(await seam.transcriptBytes!()).toBeUndefined();
});

test('G162: a harness that offers no transcriptBytes yields undefined (entries only)', async () => {
  const f = additivesFixture();
  f.harness.bytes.set(f.id, BYTES);
  (f.harness as { transcriptBytes: unknown }).transcriptBytes = undefined;
  const seam = (await f.service.harness(f.id))!;
  expect(await seam.transcriptBytes!()).toBeUndefined();
});

test('G162: a harness plugin that is off is a 503 plugin_unavailable', async () => {
  const f = additivesFixture();
  const seam = (await f.service.harness(f.id))!;
  f.ports.harness = () => undefined;
  const failure = await seam.transcriptBytes!().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(ApiError);
  expect((failure as ApiError).status).toBe(503);
  expect((failure as ApiError).code).toBe('plugin_unavailable');
});

test('G162: a replaced file rejects HarnessTranscriptReplaced and stat answers undefined', async () => {
  const f = additivesFixture();
  f.harness.bytes.set(f.id, BYTES);
  const handle = (await (await f.service.harness(f.id))!.transcriptBytes!())!;
  f.harness.bytes.set(f.id, new TextEncoder().encode('{"c":3}\n'));
  await expect(handle.read(0, 4)).rejects.toBeInstanceOf(HarnessTranscriptReplaced);
  expect(await handle.stat()).toBeUndefined();
});
