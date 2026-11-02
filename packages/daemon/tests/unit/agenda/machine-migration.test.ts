import { describe, it } from 'bun:test';
import should from 'should';
import { foldNoticesIntoMachineAgenda, type MachineMigrationPorts } from '../../../src/lib/agenda/index.ts';

const item = (id: string, sourceRef: string | null) =>
  ({ id, sourceRef, subject: `s-${id}`, task: { id: 'F1' } }) as never;

function fixture(
  options: {
    ran?: boolean;
    unreadable?: string;
    refuse?: boolean;
    seedFails?: boolean;
    throws?: boolean;
    listThrows?: boolean;
    budgetRef?: string;
  } = {},
) {
  const closed: string[] = [];
  const seeded: string[] = [];
  const warnings: string[] = [];
  const recorded: (readonly string[])[] = [];
  const ports: MachineMigrationPorts = {
    agenda: {
      list: async sessionId => {
        if (options.listThrows === true) throw new Error('unreadable');
        return sessionId === options.unreadable
          ? { ok: false }
          : {
              ok: true,
              value: {
                items: [
                  item(`${sessionId}-1`, 'warden-auto-migrate'),
                  item(`${sessionId}-2`, 'warden-orphan:F1'),
                  item(`${sessionId}-3`, options.budgetRef ?? 'budget:login:daily:x'),
                  item(`${sessionId}-4`, 'other'),
                  item(`${sessionId}-5`, null),
                ],
              } as never,
            };
      },
      resolve: async (sessionId, id) => {
        if (options.throws === true) throw new Error('refused');
        closed.push(`${sessionId}/${id}`);
        return { ok: options.refuse !== true };
      },
    },
    sessions: { all: async () => ['s1', 's2'] },
    seed: {
      autoMoveFailed: async (sessionId, found) => {
        if (options.seedFails === true) throw new Error('boom');
        seeded.push(`auto:${sessionId}:${found.subject}`);
      },
      orphan: async found => void seeded.push(`orphan:${found.subject}`),
      budget: async ref => void seeded.push(`budget:${ref}`),
    },
    marker: { ran: async () => options.ran === true, record: async (_at, list) => void recorded.push(list) },
    now: () => 'now',
    diagnostics: { warn: message => void warnings.push(message) },
  };
  return { ports, closed, seeded, warnings, recorded };
}

describe('folding notices into the machine agenda', () => {
  it('should carry every open cause item into its machine item, close it, and record the marker', async () => {
    const { ports, closed, seeded, recorded } = fixture();
    await foldNoticesIntoMachineAgenda(ports);
    should(seeded).containEql('auto:s1:s-s1-1');
    should(seeded).containEql('orphan:s-s2-2');
    should(seeded).containEql('budget:budget:login:daily:x');
    should(closed).have.length(6);
    should(recorded).have.length(1);
    should(recorded[0]).have.length(6);
  });

  it('should close a budget notice whose window already reset without making a machine item', async () => {
    // Arrange
    const { ports, closed, seeded } = fixture({ budgetRef: 'budget:login:daily:2026-01-01T00:00:00.000Z' });

    // Act
    await foldNoticesIntoMachineAgenda({ ...ports, now: () => '2026-07-31T10:00:00Z' });

    // Assert
    should(seeded.filter(entry => entry.startsWith('budget:'))).be.empty();
    should(closed).containEql('s1/s1-3');
  });

  it('should carry a budget notice whose window is still open', async () => {
    // Arrange
    const { ports, seeded } = fixture({ budgetRef: 'budget:login:daily:2026-08-01T00:00:00.000Z' });

    // Act
    await foldNoticesIntoMachineAgenda({ ...ports, now: () => '2026-07-31T10:00:00Z' });

    // Assert
    should(seeded).containEql('budget:budget:login:daily:2026-08-01T00:00:00.000Z');
  });

  it('should do nothing once the marker is written', async () => {
    const { ports, closed } = fixture({ ran: true });
    await foldNoticesIntoMachineAgenda(ports);
    should(closed).be.empty();
  });

  it('should not write the marker while an agenda is unreadable', async () => {
    const { ports, recorded, warnings } = fixture({ unreadable: 's2' });
    await foldNoticesIntoMachineAgenda(ports);
    should(recorded).be.empty();
    should(warnings).have.length(1);
  });

  it('should not write the marker when an item cannot be closed or carried', async () => {
    const refused = fixture({ refuse: true });
    await foldNoticesIntoMachineAgenda(refused.ports);
    should(refused.recorded).be.empty();
    const failing = fixture({ seedFails: true });
    await foldNoticesIntoMachineAgenda(failing.ports);
    should(failing.recorded).be.empty();
  });

  it('should not write the marker when reading or closing throws', async () => {
    for (const options of [{ throws: true }, { listThrows: true }]) {
      const { ports, recorded } = fixture(options);
      await foldNoticesIntoMachineAgenda(ports);
      should(recorded).be.empty();
    }
  });
});
