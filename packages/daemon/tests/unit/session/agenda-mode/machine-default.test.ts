import { describe, it } from 'bun:test';
import should from 'should';
import {
  type AgendaDefaultPorts,
  adoptAgendaDefault,
} from '../../../../src/lib/session/agenda-mode/machine-default.ts';

function world(options: { readonly machine: boolean; readonly recorded?: boolean }) {
  const enabled: string[] = [];
  const reads: string[] = [];
  const ports: AgendaDefaultPorts = {
    machineDefault: async () => {
      reads.push('machine');
      return options.machine;
    },
    recorded: async () => options.recorded,
    enable: async sessionId => {
      enabled.push(sessionId);
    },
  };
  return { ports, enabled, reads };
}

describe('adoptAgendaDefault', () => {
  it('should turn agenda mode on for a new ordinary ferret when the machine default is on', async () => {
    // Arrange
    const { ports, enabled } = world({ machine: true });

    // Act
    const actual = await adoptAgendaDefault(ports, 's1', true);

    // Assert
    should(actual).be.true();
    should(enabled).deepEqual(['s1']);
  });

  it('should leave a ferret alone when the machine default is off', async () => {
    // Arrange
    const { ports, enabled } = world({ machine: false });

    // Act
    const actual = await adoptAgendaDefault(ports, 's1', true);

    // Assert
    should(actual).be.false();
    should(enabled).deepEqual([]);
  });

  it('should never overrule a switch the ferret already recorded, on or off', async () => {
    // Arrange
    const off = world({ machine: true, recorded: false });
    const on = world({ machine: true, recorded: true });

    // Act
    const offResult = await adoptAgendaDefault(off.ports, 's1', true);
    const onResult = await adoptAgendaDefault(on.ports, 's2', true);

    // Assert
    should(offResult).be.false();
    should(onResult).be.false();
    should(off.enabled).deepEqual([]);
    should(on.enabled).deepEqual([]);
  });

  it('should skip a ferret the daemon runs for itself without reading the machine', async () => {
    // Arrange
    const { ports, enabled, reads } = world({ machine: true });

    // Act
    const actual = await adoptAgendaDefault(ports, 's1', false);

    // Assert
    should(actual).be.false();
    should(enabled).deepEqual([]);
    should(reads).deepEqual([]);
  });
});
