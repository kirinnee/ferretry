import { expect, test } from 'bun:test';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import { FerretPinsFile } from '../../../../contract/index.ts';
import { StatePinRepository } from '../../../../daemon/adapters/pins/file-pin-repository.ts';

/**
 * Where a pin enters 5.0 — the stored file read and every write — duplicate pin ids and duplicate message block ids are
 * normalized away (the first of each kept), so the uniqueness the retired snapshot schema used to state still holds.
 */

const note = (id: string, text: string) => ({
  id,
  at: 1,
  kind: 'note' as const,
  text,
  by: 'human' as const,
  createdBy: null,
  createdByName: null,
});
const message = (id: string, blockId: string) => ({
  id,
  at: 2,
  kind: 'message' as const,
  blockId,
  blockKind: 'assistant' as const,
  preview: 'a reply',
  by: 'human' as const,
  createdBy: null,
  createdByName: null,
});

const ID_A = '00000000-0000-4000-8000-00000000000a';
const ID_B = '00000000-0000-4000-8000-00000000000b';
const ID_C = '00000000-0000-4000-8000-00000000000c';

const fixture = () => {
  const folder = new MemoryStateFolder();
  const port = folder.port([FerretPinsFile]);
  return { port, repository: new StatePinRepository(port, FerretPinsFile, { now: () => '2026-11-06T09:00:00.000Z' }) };
};

test('a stored pins file with a repeated pin id and a repeated message block reads back with the first of each', async () => {
  const { port, repository } = fixture();
  await port.write(
    FerretPinsFile,
    { pins: [note(ID_A, 'first'), note(ID_A, 'repeat'), message(ID_B, 'block-1'), message(ID_C, 'block-1')] } as never,
    'f1',
  );
  const snapshot = await repository.snapshot('f1');
  expect(snapshot.pins.map(pin => pin.id)).toEqual([ID_A, ID_B]);
  expect(snapshot.pins[0]).toMatchObject({ text: 'first' });
});

test('a write that would repeat a pin id or a message block stores each once', async () => {
  const { port, repository } = fixture();
  const written = await repository.mutate('f1', () => [
    note(ID_A, 'first'),
    note(ID_A, 'repeat'),
    message(ID_B, 'block-1'),
    message(ID_C, 'block-1'),
  ]);
  expect(written.pins.map(pin => pin.id)).toEqual([ID_A, ID_B]);
  const stored = await port.read(FerretPinsFile, 'f1');
  expect(stored.ok && (stored.value as { pins: { id: string }[] }).pins.map(pin => pin.id)).toEqual([ID_A, ID_B]);
});
