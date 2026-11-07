import { afterEach, describe, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MACHINE_AGENDA_ID } from '../../../../daemon/lib/protocol/agenda.ts';
import should from 'should';
import { FileAgendaLedgerRepository } from '../../../../daemon/adapters/agenda/file-agenda-ledger-repository.ts';
import {
  assertMachineAgendaIsolation,
  assertOwnerAndSessionRoutes,
  machineAgendaWorld,
} from '../../support/machine-agenda-isolation.ts';

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});

async function world() {
  const home = await mkdtemp(join(tmpdir(), 'machine-agenda-isolation-'));
  homes.push(home);
  const sessions = new FileAgendaLedgerRepository(id => join(home, 'sessions', id));
  const machine = new FileAgendaLedgerRepository(() => join(home, 'machine'));
  return await machineAgendaWorld(sessions, machine);
}

describe('session agenda aliases with independent durable ledgers', () => {
  it('refuses every session route and action without changing the machine file', async () => {
    const fixture = await world();
    const file = (fixture.machineRepository as FileAgendaLedgerRepository).file(MACHINE_AGENDA_ID);
    const before = await readFile(file, 'utf8');
    await assertMachineAgendaIsolation(fixture);
    should(await readFile(file, 'utf8')).equal(before);
  });

  it('serves only the owner on the machine routes while ordinary sessions still work', async () => {
    await assertOwnerAndSessionRoutes(await world());
  });
});
