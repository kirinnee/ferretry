import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { FileAgendaFileStore } from '../../../src/adapters/agenda/file-agenda-file-store.ts';
import { FileAgendaFilesMigrationMarker } from '../../../src/adapters/agenda/file-agenda-files-migration-marker.ts';
import { FileAgendaLedgerRepository } from '../../../src/adapters/agenda/file-agenda-ledger-repository.ts';
import { FileAgendaOutboxRepository } from '../../../src/adapters/agenda/file-agenda-outbox-repository.ts';
import { emptyAgendaLedger, emptyAgendaOutbox, migrateAgendaFiles } from '../../../src/lib/agenda/index.ts';

const homes: string[] = [];
const AT = '2026-10-28T17:00:00.000Z';

async function createHome() {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-agenda-files-'));
  homes.push(home);
  const directory = (sessionId: string) => join(home, 'sessions', sessionId);
  const logs: string[] = [];
  const run = async (sessionIds: readonly string[]) =>
    await migrateAgendaFiles(sessionIds, {
      marker: new FileAgendaFilesMigrationMarker(join(home, 'agenda-files-migration.json')),
      files: new FileAgendaFileStore(directory),
      now: () => AT,
      log: line => logs.push(line),
    });
  const put = async (sessionId: string, name: string, text: string) => {
    await mkdir(directory(sessionId), { recursive: true });
    await writeFile(join(directory(sessionId), name), text);
  };
  return { home, directory, logs, run, put };
}

const ledgerText = (sessionId: string, updatedAt: string) =>
  `${JSON.stringify({ ...emptyAgendaLedger(sessionId, updatedAt), nextId: 3 }, null, 2)}\n`;
const outboxText = (sessionId: string) =>
  `${JSON.stringify({ ...emptyAgendaOutbox(sessionId), pending: [{ id: 'A1', message: 'yes', at: AT }] }, null, 2)}\n`;

afterEach(async () => {
  await Promise.all(homes.splice(0).map(async home => await rm(home, { recursive: true, force: true })));
});

describe('the agenda files migration at daemon start', () => {
  it('should write the marker and touch nothing on a fresh install', async () => {
    // Arrange
    const { home, run, logs } = await createHome();

    // Act
    const outcome = await run([]);

    // Assert
    should(outcome).containDeep({ ran: true, sessions: 0, failed: 0 });
    should(JSON.parse(await readFile(join(home, 'agenda-files-migration.json'), 'utf8'))).containDeep({
      v: 1,
      ranAt: AT,
      sessions: 0,
    });
    should(logs).have.length(1);
  });

  it('should move a session’s old ledger and outbox to the new names, keeping the old ones as .migrated', async () => {
    // Arrange
    const { directory, run, put } = await createHome();
    await put('session-1', 'attention.json', ledgerText('session-1', AT));
    await put('session-1', 'attention-replies.json', outboxText('session-1'));

    // Act
    const outcome = await run(['session-1']);

    // Assert
    should(outcome).containDeep({ ran: true, migrated: 1, failed: 0 });
    should((await readdir(directory('session-1'))).sort()).deepEqual([
      'agenda-replies.json',
      'agenda.json',
      'attention-replies.json.migrated',
      'attention.json.migrated',
    ]);
    should(await readFile(join(directory('session-1'), 'agenda.json'), 'utf8')).equal(
      await readFile(join(directory('session-1'), 'attention.json.migrated'), 'utf8'),
    );
  });

  it('should keep the newer ledger when both exist, whichever name it has', async () => {
    // Arrange
    const { directory, run, put } = await createHome();
    await put('session-1', 'attention.json', ledgerText('session-1', '2026-10-28T18:00:00.000Z'));
    await put('session-1', 'agenda.json', ledgerText('session-1', AT));

    // Act
    await run(['session-1']);

    // Assert
    should(JSON.parse(await readFile(join(directory('session-1'), 'agenda.json'), 'utf8')).updatedAt).equal(
      '2026-10-28T18:00:00.000Z',
    );
    should(JSON.parse(await readFile(join(directory('session-1'), 'agenda.json.migrated'), 'utf8')).updatedAt).equal(
      AT,
    );
  });

  it('should leave a damaged old file where it is, write no marker, and finish on the next start', async () => {
    // Arrange
    const { home, directory, run, put } = await createHome();
    await put('session-bad', 'attention.json', '{ not json');
    await put('session-ok', 'attention.json', ledgerText('session-ok', AT));

    // Act
    const first = await run(['session-bad', 'session-ok']);
    await writeFile(join(directory('session-bad'), 'attention.json'), ledgerText('session-bad', AT));
    const second = await run(['session-bad', 'session-ok']);

    // Assert
    should(first).containDeep({ ran: false, migrated: 1, failed: 1 });
    should(second).containDeep({ ran: true, migrated: 1, failed: 0 });
    should(await readdir(directory('session-bad'))).containDeep(['agenda.json', 'attention.json.migrated']);
    should(await readdir(home)).containEql('agenda-files-migration.json');
  });

  it('should finish after a crash that left the new file written and the old one in place', async () => {
    // Arrange
    const { directory, run, put } = await createHome();
    const text = ledgerText('session-1', AT);
    await put('session-1', 'attention.json', text);
    await put('session-1', 'agenda.json', text);
    await put('session-1', '.agenda-crashed.tmp', 'half');

    // Act
    const outcome = await run(['session-1']);

    // Assert
    should(outcome).containDeep({ ran: true, failed: 0 });
    should(await readFile(join(directory('session-1'), 'agenda.json'), 'utf8')).equal(text);
    should(await readdir(directory('session-1'))).containEql('attention.json.migrated');
  });

  it('should do no work once the marker exists', async () => {
    // Arrange
    const { directory, run, put } = await createHome();
    await run([]);
    await put('session-1', 'attention.json', ledgerText('session-1', AT));

    // Act
    const outcome = await run(['session-1']);

    // Assert
    should(outcome.ran).be.false();
    should(await readdir(directory('session-1'))).deepEqual(['attention.json']);
  });
});

describe('the repositories after the migration', () => {
  it('should read an old-named ledger and outbox, and write only the new names', async () => {
    // Arrange
    const { directory, put } = await createHome();
    await put('session-1', 'attention.json', ledgerText('session-1', AT));
    await put('session-1', 'attention-replies.json', outboxText('session-1'));
    const ledgers = new FileAgendaLedgerRepository(directory);
    const outboxes = new FileAgendaOutboxRepository(directory, () => 'fixed');

    // Act
    const ledger = await ledgers.read('session-1');
    const outbox = await outboxes.read('session-1');
    if (ledger === null || outbox === null) throw new Error('the old files were not read');
    await ledgers.transact('session-1', () => ({ ok: true, changed: true, ledger: { ...ledger, nextId: 4 } }) as never);
    await outboxes.write({ ...outbox, pending: [] });

    // Assert
    should(ledger.nextId).equal(3);
    should(outbox.pending).have.length(1);
    should((await readdir(directory('session-1'))).sort()).deepEqual([
      'agenda-replies.json',
      'agenda.json',
      'attention-replies.json',
      'attention.json',
    ]);
    should((await ledgers.read('session-1'))?.nextId).equal(4);
    should((await outboxes.read('session-1'))?.pending).deepEqual([]);
  });

  it('should prefer the new name over the old one', async () => {
    // Arrange
    const { directory, put } = await createHome();
    await put('session-1', 'attention.json', ledgerText('session-1', AT));
    await put('session-1', 'agenda.json', `${JSON.stringify({ ...emptyAgendaLedger('session-1', AT), nextId: 9 })}\n`);

    // Act
    const ledger = await new FileAgendaLedgerRepository(directory).read('session-1');

    // Assert
    should(ledger?.nextId).equal(9);
  });
});

describe('FileAgendaFilesMigrationMarker', () => {
  it('should report no run until a run is recorded, then keep the counts', async () => {
    // Arrange
    const { home } = await createHome();
    const marker = new FileAgendaFilesMigrationMarker(join(home, 'nested', 'marker.json'));

    // Act
    const before = await marker.ran();
    await marker.record(AT, { sessions: 2, migrated: 1, keptNew: 1, failed: 0 });

    // Assert
    should(before).be.false();
    should(await marker.ran()).be.true();
    should(JSON.parse(await readFile(join(home, 'nested', 'marker.json'), 'utf8'))).deepEqual({
      v: 1,
      ranAt: AT,
      sessions: 2,
      migrated: 1,
      keptNew: 1,
      failed: 0,
    });
  });
});

describe('the agenda file store and marker at their edges', () => {
  it('should refuse to say whether the migration ran when the marker cannot be read', async () => {
    // Arrange — a directory where the marker file should be is not "no run": it is an error to report.
    const { home } = await createHome();
    const path = join(home, 'agenda-files-migration.json');
    await mkdir(path);

    // Act
    const actual = await new FileAgendaFilesMigrationMarker(path).ran().then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert
    should(actual).be.instanceOf(Error);
    should((actual as NodeJS.ErrnoException).code).equal('EISDIR');
  });

  it('should remove a file, and remove nothing quietly when it is already gone', async () => {
    // Arrange
    const { directory, put } = await createHome();
    const store = new FileAgendaFileStore(directory);
    await put('session-1', 'agenda.json', '{}');

    // Act
    await store.remove('session-1', 'agenda.json');
    await store.remove('session-1', 'agenda.json');

    // Assert
    should(await readdir(directory('session-1'))).deepEqual([]);
  });
});
