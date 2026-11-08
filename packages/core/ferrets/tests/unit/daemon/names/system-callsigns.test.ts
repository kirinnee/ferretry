import { describe, it } from 'bun:test';
import should from 'should';
import { StateCallsignCounters } from '../../../../daemon/adapters/names/state-callsign-counters.ts';
import { SYSTEM_CALLSIGN_MAX_SEQUENCE } from '../../../../daemon/lib/protocol/system-callsigns.ts';
import { issuerOver, MemoryCounters } from './system-callsigns-support.ts';

/** A state port holding the one `system-callsigns.json` document, or reporting it damaged. */
function memoryState() {
  const state = {
    document: undefined as Record<string, number> | undefined,
    damaged: false,
    port: {
      read: async () =>
        state.damaged
          ? { ok: false, error: { file: 'system-callsigns.json', reason: 'unparsable', sentence: 'damaged' } }
          : { ok: true, value: state.document },
      write: async (_file: unknown, value: Record<string, number>) => {
        state.document = value;
      },
    } as never,
  };
  return state;
}

describe('issuing system callsigns', () => {
  it('should count on from one for each prefix on its own', async () => {
    // Arrange
    const subject = issuerOver();

    // Act
    const names = [await subject.next('learning'), await subject.next('learning'), await subject.next('pack')];

    // Assert
    should(names).deepEqual(['learning-000001', 'learning-000002', 'pack-000001']);
  });

  it('should step past ids the fleet still holds, and only those of its own prefix', async () => {
    // Arrange
    const subject = issuerOver(new MemoryCounters(), () => [
      'learning-000001',
      'learning-000002',
      'pack-000001',
      'ada',
    ]);

    // Act
    const learning = await subject.next('learning');
    const pack = await subject.next('pack');

    // Assert
    should(learning).equal('learning-000003');
    should(pack).equal('pack-000002');
  });

  it('should wrap from ffffff to 000001', async () => {
    // Arrange
    const subject = issuerOver(new MemoryCounters({ pack: SYSTEM_CALLSIGN_MAX_SEQUENCE }));

    // Act + Assert
    should(await subject.next('pack')).equal('pack-000001');
  });

  it('should never give two concurrent starts the same id', async () => {
    // Arrange
    const subject = issuerOver();

    // Act
    const names = await Promise.all([subject.next('learning'), subject.next('learning'), subject.next('learning')]);

    // Assert
    should(new Set(names).size).equal(3);
  });
});

describe('the persisted counters', () => {
  it('should carry on after a restart, through system-callsigns.json (F-0349)', async () => {
    // Arrange
    const state = memoryState();
    const first = issuerOver(new StateCallsignCounters(state.port));
    await first.next('learning');
    await first.next('learning');
    await first.next('pack');

    // Act
    const second = issuerOver(new StateCallsignCounters(state.port));

    // Assert
    should(state.document).deepEqual({ learning: 2, pack: 1 });
    should(await second.next('learning')).equal('learning-000003');
    should(await second.next('pack')).equal('pack-000002');
  });

  it('should start again from nothing when the document is damaged (F-0349)', async () => {
    // Arrange
    const state = memoryState();
    const counters = new StateCallsignCounters(state.port);

    // Act + Assert
    should(await counters.read()).deepEqual({});
    state.damaged = true;
    should(await counters.read()).deepEqual({});
    state.damaged = false;
    state.document = { learning: 7 };
    should(await counters.read()).deepEqual({ learning: 7 });
  });
});
