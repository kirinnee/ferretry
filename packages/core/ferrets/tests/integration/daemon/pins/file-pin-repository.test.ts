import { describe, it } from 'bun:test';
import { defineState } from '@ferretry/kernel/contract';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import should from 'should';
import { RegistryPinSessionDirectory, StatePinRepository } from '../../../../daemon/adapters/pins/index.ts';

const clock = { now: () => '2026-07-31T00:00:00.000Z' };

/** The declaration the contract is to hold for `<ferret>/pins.json` (stood in here until it does). */
const PinFiles = defineState({ name: 'pins', path: '*/pins.json', store: 'json', format: 1 });

function fixture() {
  const folder = new MemoryStateFolder();
  const state = folder.port([PinFiles]);
  return { folder, repository: new StatePinRepository(state, PinFiles as never, clock) };
}

const note = (id: string, text: string, at: number) => ({
  id,
  at,
  kind: 'note' as const,
  text,
  by: 'human' as const,
  createdBy: null,
  createdByName: null,
});

describe('StatePinRepository', () => {
  it('should serialize per-ferret mutations through the store and retain concurrent changes', async () => {
    const subject = fixture();
    const [first, second] = await Promise.all([
      subject.repository.mutate('agent-1', current => [
        note('00000000-0000-4000-8000-000000000001', 'first', 1),
        ...current,
      ]),
      subject.repository.mutate('agent-1', current => [
        note('00000000-0000-4000-8000-000000000002', 'second', 2),
        ...current,
      ]),
    ]);
    const reread = await subject.repository.snapshot('agent-1');

    should(first.pins).have.length(1);
    should(second.pins).have.length(2);
    should(reread.pins.map(pin => pin.id)).deepEqual([
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000001',
    ]);
    should(JSON.parse(subject.folder.raw(PinFiles, 'agent-1') ?? '{}').format).equal(1);
  });

  it('should degrade absent, corrupt and malformed documents to an empty board', async () => {
    const subject = fixture();
    should((await subject.repository.snapshot('agent-1')).pins).deepEqual([]);
    subject.folder.plant(PinFiles, '{not-json', 'agent-1');
    should((await subject.repository.snapshot('agent-1')).pins).deepEqual([]);
    subject.folder.plant(PinFiles, JSON.stringify({ format: 1, pins: [{ id: 'not-a-uuid' }] }), 'agent-1');
    should((await subject.repository.snapshot('agent-1')).pins).deepEqual([]);
  });

  it('should recognise only a ferret the registry holds', async () => {
    const known = new Set(['agent-1']);
    const sessions = new RegistryPinSessionDirectory(id => known.has(id));
    should(await sessions.has('agent-1')).be.true();
    should(await sessions.has('agent-2')).be.false();
  });
});
