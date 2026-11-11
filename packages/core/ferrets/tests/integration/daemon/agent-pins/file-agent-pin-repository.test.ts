import { describe, it } from 'bun:test';
import { defineState } from '@ferretry/kernel/contract';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import should from 'should';
import { StateAgentPinRepository } from '../../../../daemon/adapters/agent-pins/index.ts';

/** The declaration the contract is to hold for `agent-pins.json` (stood in here until it does). */
const AgentPinsFile = defineState({ name: 'agent-pins', path: 'agent-pins.json', store: 'json', format: 1 });

function fixture() {
  const folder = new MemoryStateFolder();
  return { folder, repository: new StateAgentPinRepository(folder.port([AgentPinsFile]), AgentPinsFile as never) };
}

/** The port with every `read` counted, so "how many times was the file read" is a number. */
function counted() {
  const folder = new MemoryStateFolder();
  const port = folder.port([AgentPinsFile]);
  const counts = { reads: 0 };
  const counting = new Proxy(port, {
    get: (target, key) => {
      const value = Reflect.get(target, key, target) as unknown;
      if (key !== 'read' || typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        counts.reads += 1;
        return (value as (...all: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { folder, counts, repository: new StateAgentPinRepository(counting, AgentPinsFile as never) };
}

describe('StateAgentPinRepository read cache', () => {
  const pin = (id: string) => ({ sessionId: id, pinnedAt: '2026-11-01T10:00:00.000Z' });

  it('should read the file once for any number of loads, concurrent or not, while nothing writes', async () => {
    const subject = counted();
    subject.folder.plant(AgentPinsFile, JSON.stringify({ format: 1, pins: [pin('agent-1')] }));

    const burst = await Promise.all(Array.from({ length: 500 }, async () => await subject.repository.load()));
    await subject.repository.load();

    should(subject.counts.reads).equal(1);
    for (const each of burst) should(each).deepEqual([pin('agent-1')]);
  });

  it('should read the new pins after a save through the repository', async () => {
    const subject = counted();
    await subject.repository.save([pin('agent-1')]);
    should(await subject.repository.load()).deepEqual([pin('agent-1')]);
    const before = subject.counts.reads;

    await subject.repository.save([pin('agent-1'), pin('agent-2')]);

    should(await subject.repository.load()).deepEqual([pin('agent-1'), pin('agent-2')]);
    should(subject.counts.reads).equal(before + 1);
  });

  it('should read again when the file changed behind the repository, and answer none once it is gone', async () => {
    const subject = counted();
    subject.folder.plant(AgentPinsFile, JSON.stringify({ format: 1, pins: [pin('agent-1')] }));
    await subject.repository.load();

    subject.folder.plant(AgentPinsFile, JSON.stringify({ format: 1, pins: [pin('agent-9')] }));

    should(await subject.repository.load()).deepEqual([pin('agent-9')]);
  });
});

describe('StateAgentPinRepository', () => {
  it('should find no pins before anything was pinned', async () => {
    should(await fixture().repository.load()).deepEqual([]);
  });

  it('should keep pins across a new repository over the same state, stamped format 1', async () => {
    const subject = fixture();
    const pins = [{ sessionId: 'agent-1', pinnedAt: '2026-11-01T10:00:00.000Z' }];
    await subject.repository.save(pins);

    const again = new StateAgentPinRepository(subject.folder.port([AgentPinsFile]), AgentPinsFile as never);
    should(await again.load()).deepEqual(pins);
    should(JSON.parse(subject.folder.raw(AgentPinsFile) ?? '{}')).deepEqual({ format: 1, pins });
  });

  it('should treat a damaged or other-format file as an empty list rather than failing the roster', async () => {
    const subject = fixture();
    subject.folder.plant(AgentPinsFile, '{not json');
    should(await subject.repository.load()).deepEqual([]);
    subject.folder.plant(AgentPinsFile, JSON.stringify({ format: 2, pins: [] }));
    should(await subject.repository.load()).deepEqual([]);
  });
});
