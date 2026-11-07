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
