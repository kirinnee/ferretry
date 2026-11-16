import { afterEach, describe, it } from 'bun:test';
import type { StatePort } from '@ferretry/kernel/contract';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { FileAgendaLedgerRepository } from '../../../../daemon/adapters/agenda/file-agenda-ledger-repository.ts';
import { StateAgendaFiles } from '../../../../daemon/adapters/agenda/state-agenda-files.ts';
import { AGENDA_FILES, emptyAgendaLedger } from '../../../../daemon/lib/agenda/index.ts';
import { agendaLedgerDocument } from '../../../../daemon/lib/agenda/state-machine.ts';
import { asksStateAt } from '../../../support/daemon/agenda-state.ts';

const AT = '2026-11-09T10:00:00.000Z';
const SESSION = 'session-1';
const homes: string[] = [];

afterEach(async () => {
  await Promise.all(homes.splice(0).map(async home => await rm(home, { recursive: true, force: true })));
});

/** A real state port over a temp home, with every read of file CONTENTS counted (a stat is not one). */
async function world() {
  const home = await mkdtemp(join(tmpdir(), 'agenda-stat-identity-'));
  homes.push(home);
  const real = asksStateAt(home);
  const counts = { reads: 0 };
  const state = new Proxy(real, {
    get: (target, key, receiver) => {
      if (key === 'read')
        return async (...args: Parameters<StatePort['read']>) => {
          counts.reads += 1;
          return await target.read(...args);
        };
      return Reflect.get(target, key, receiver) as unknown;
    },
  }) as StatePort;
  const files = new StateAgendaFiles(state);
  const repository = new FileAgendaLedgerRepository(files, () => 'id', undefined, {
    now: () => 0,
    warn: () => undefined,
  });
  return { files, repository, counts };
}

describe('the agenda ledger identity', () => {
  it('should not read the file contents to check an unchanged ledger: a stat answers it', async () => {
    // Arrange
    const w = await world();
    await w.files.writeAtomic(SESSION, AGENDA_FILES.ledger, agendaLedgerDocument(emptyAgendaLedger(SESSION, AT)));
    await w.repository.read(SESSION);
    const afterFirst = w.counts.reads;

    // Act
    for (let i = 0; i < 50; i += 1) await w.repository.read(SESSION);

    // Assert: fifty more reads of an unchanged ledger read no bytes at all
    should(w.counts.reads).equal(afterFirst);
    should(await w.files.identity(SESSION, AGENDA_FILES.ledger)).be.a.String();
    should(w.counts.reads).equal(afterFirst);
  });

  it('should read a ledger again when it is rewritten with the same size', async () => {
    // Arrange
    const w = await world();
    const text = agendaLedgerDocument(emptyAgendaLedger(SESSION, AT));
    await w.files.writeAtomic(SESSION, AGENDA_FILES.ledger, text);
    const before = await w.files.identity(SESSION, AGENDA_FILES.ledger);
    await w.repository.read(SESSION);
    const afterFirst = w.counts.reads;

    // Act: the same bytes, a new file (the atomic write renames a new inode over it)
    await w.files.writeAtomic(SESSION, AGENDA_FILES.ledger, text);

    // Assert
    should(await w.files.identity(SESSION, AGENDA_FILES.ledger)).not.equal(before);
    await w.repository.read(SESSION);
    should(w.counts.reads).be.above(afterFirst);
  });

  it('should find no unfinished-change file once, and not look for it again on every read', async () => {
    // Arrange
    const w = await world();
    await w.files.writeAtomic(SESSION, AGENDA_FILES.ledger, agendaLedgerDocument(emptyAgendaLedger(SESSION, AT)));
    await w.repository.read(SESSION);
    const afterFirst = w.counts.reads;

    // Act
    for (let i = 0; i < 20; i += 1) await w.repository.read(SESSION);

    // Assert
    should(w.counts.reads).equal(afterFirst);
  });
});
