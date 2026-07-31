import { describe, it } from 'bun:test';
import should from 'should';
import type { Pin, PinSnapshot } from '@ferretry/protocol';
import { PinError, PinService, type PinRepository } from '../../../src/lib/pins/index.ts';

class MemoryPins implements PinRepository {
  private pins: Pin[] = [];

  async snapshot(sessionId: string): Promise<PinSnapshot> {
    return { v: 1, sessionId, pins: this.pins, updatedAt: '2026-07-31T00:00:00.000Z' };
  }

  async mutate(sessionId: string, transform: (current: readonly Pin[]) => readonly Pin[]): Promise<PinSnapshot> {
    this.pins = [...transform(this.pins)];
    return await this.snapshot(sessionId);
  }
}

const subject = (sessions = new Set(['agent-1', 'other'])) =>
  new PinService(
    { has: async sessionId => sessions.has(sessionId) },
    new MemoryPins(),
    { now: () => '2026-07-31T00:00:00.000Z' },
    (() => {
      let next = 0;
      return { next: () => `00000000-0000-4000-8000-${String(++next).padStart(12, '0')}` };
    })(),
  );

describe('PinService', () => {
  it('should stamp trusted human provenance, preserve note text, and make duplicate adds idempotent', async () => {
    // Arrange
    const pins = subject();

    // Act
    const added = await pins.add('agent-1', { kind: 'note', text: 'Decision', source: { blockId: 'block-1' } }, {});
    const duplicate = await pins.add('agent-1', { kind: 'note', text: ' Decision ' }, {});

    // Assert
    should(added.pins[0]).deepEqual({
      id: '00000000-0000-4000-8000-000000000001',
      at: 1785456000000,
      kind: 'note',
      text: 'Decision',
      source: { blockId: 'block-1' },
      by: 'human',
      createdBy: null,
      createdByName: null,
    });
    should(duplicate.pins).have.length(1);
  });

  it('should make message pins idempotent and validate their boundary fields', async () => {
    // Arrange
    const pins = subject();

    // Act
    const added = await pins.add(
      'agent-1',
      {
        kind: 'message',
        blockId: 'block-1',
        blockKind: 'assistant',
        preview: ' a\n b ',
        ts: '2026-07-31T00:00:00.000Z',
      },
      { sessionId: 'agent-1', name: 'Ada' },
    );
    const duplicate = await pins.add(
      'agent-1',
      { kind: 'message', blockId: 'block-1', blockKind: 'assistant', preview: 'different' },
      { sessionId: 'agent-1' },
    );

    // Assert
    should(added.pins[0]).match({
      kind: 'message',
      preview: 'a b',
      by: 'agent',
      createdBy: 'agent-1',
      createdByName: 'Ada',
    });
    should(duplicate.pins).have.length(1);
    await should(
      pins.add('agent-1', { kind: 'message', blockId: '', blockKind: 'assistant', preview: '' }, {}),
    ).be.rejectedWith(PinError);
    await should(
      pins.add('agent-1', { kind: 'message', blockId: 'x', blockKind: 'bad', preview: '' }, {}),
    ).be.rejectedWith(PinError);
  });

  it('should allow agents to alter only their own pins while retaining human authority', async () => {
    // Arrange
    const pins = subject();
    const agent = { sessionId: 'agent-1', name: 'Ada' };
    const mine = await pins.add('agent-1', { kind: 'note', text: 'mine' }, agent);
    const human = await pins.add('agent-1', { kind: 'note', text: 'human' }, {});
    const humanPin = human.pins.find(
      (pin): pin is Extract<Pin, { kind: 'note' }> => pin.kind === 'note' && pin.text === 'human',
    );

    // Act + Assert
    await should(pins.edit('agent-1', mine.pins[0]!.id, 'changed', agent)).be.fulfilled();
    await should(pins.remove('agent-1', humanPin!.id, agent)).be.rejectedWith(PinError);
    const afterHuman = await pins.remove('agent-1', humanPin!.id, {});
    should(afterHuman.pins.map(pin => (pin.kind === 'note' ? pin.text : ''))).deepEqual(['changed']);
  });

  it('should reject invalid, absent, cross-session, and inappropriate edit requests', async () => {
    // Arrange
    const pins = subject();
    const message = await pins.add(
      'agent-1',
      { kind: 'message', blockId: 'block', blockKind: 'assistant', preview: '' },
      {},
    );

    // Act + Assert
    await should(pins.list('../escape')).be.rejectedWith(PinError);
    await should(pins.list('missing')).be.rejectedWith(PinError);
    await should(pins.list('agent-1')).be.fulfilled();
    await should(pins.add('other', { kind: 'note', text: 'no' }, { sessionId: 'agent-1' })).be.rejectedWith(PinError);
    await should(pins.edit('agent-1', message.pins[0]!.id, 'no', {})).be.rejectedWith(PinError);
    const missing = await pins.remove('agent-1', 'not-here', {});
    should(missing.pins).have.length(1);
  });
});
