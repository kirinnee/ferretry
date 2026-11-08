import { describe, it } from 'bun:test';
import { state } from '@ferretry/kernel/host';
import should from 'should';
import { KeyedSerialExecutor } from '../../../../daemon/adapters/storage/keyed-serial-executor.ts';
import { SystemCallsignIssuer } from '../../../../daemon/lib/names/index.ts';
import { SystemCallsignsFile } from '../../../../contract/state.ts';
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

describe('a damaged system-callsigns.json (F-0349)', () => {
  it('should be a narrower file that never flags the subsystem, as today read it as nothing issued', () => {
    // Act + Assert
    should(typeof SystemCallsignsFile.onDamaged).equal('object');
  });

  it('should cost a skipped id and never a collision when the kernel refuses to write over it', async () => {
    // Arrange
    const refusing = {
      read: async () => ({ ok: true, value: undefined }),
      write: async () => {
        throw Object.assign(new Error('damaged'), { name: 'StoreDamagedError' });
      },
    } as never;
    const counters = new StateCallsignCounters(refusing);

    // Act + Assert: the kernel's refusal is swallowed, and the daemon still remembers how far it got
    await counters.write({ pack: 3 });
    should(await counters.read()).deepEqual({ pack: 3 });
  });

  it('should issue two different ids over a damaged file on the kernel state port, and leave the file as it was', async () => {
    // Arrange: the kernel's real state port over a memory fs, with garbage planted where the counters live
    const fs = state.createMemoryHostFs();
    const path = '/home/fy/state/ferrets/system-callsigns.json';
    fs.seed(path, '{not json');
    const port = state.createStatePort({ home: '/home/fy', pluginId: 'ferrets', files: [SystemCallsignsFile], fs });
    const issuer = new SystemCallsignIssuer({
      counters: new StateCallsignCounters(port),
      held: async () => [],
      serial: new KeyedSerialExecutor(),
    });

    // Act
    const first = await issuer.next('learning');
    const second = await issuer.next('learning');

    // Assert
    should(first).equal('learning-000001');
    should(second).equal('learning-000002');
    should(fs.snapshot().get(path)).equal('{not json');
  });

  it('should hold the larger of the file and the daemon\'s own mark', async () => {
    // Arrange
    const fs = state.createMemoryHostFs();
    const port = state.createStatePort({ home: '/home/fy', pluginId: 'ferrets', files: [SystemCallsignsFile], fs });
    const counters = new StateCallsignCounters(port);

    // Act
    await counters.write({ pack: 4 });
    await counters.write({ pack: 2 });

    // Assert
    should(await counters.read()).deepEqual({ pack: 4 });
  });

  it('should still raise any other write fault', async () => {
    // Arrange
    const failing = {
      read: async () => ({ ok: true, value: undefined }),
      write: async () => {
        throw new Error('disk full');
      },
    } as never;

    // Act + Assert
    await new StateCallsignCounters(failing).write({ pack: 3 }).should.be.rejectedWith('disk full');
  });
});
