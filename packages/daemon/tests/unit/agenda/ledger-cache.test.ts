import { describe, it } from 'bun:test';
import should from 'should';
import { FileAgendaLedgerRepository } from '../../../src/adapters/agenda/file-agenda-ledger-repository.ts';
import { AGENDA_FILES, emptyAgendaLedger } from '../../../src/lib/agenda/index.ts';
import { AgendaService } from '../../../src/lib/agenda/service.ts';

/**
 * The agenda repository's parsed copy: kept per session against the identity of the file it was read from,
 * dropped by every write, and never trusted over the file. The file store here is in memory, and a file
 * changed "outside the daemon" is one given new text and a new identity behind the repository's back.
 */

const NOW = '2026-10-31T10:00:00.000Z';
const SESSION = 'session-1';
const { current, legacy } = AGENDA_FILES.ledger;

class MemoryFiles {
  readonly files = new Map<string, { text: string; identity: string }>();
  parses = 0;
  private stamp = 0;

  file(sessionId: string, name: string): string {
    return `/state/sessions/${sessionId}/${name}`;
  }

  async read(sessionId: string, name: string): Promise<string | undefined> {
    return this.files.get(`${sessionId}/${name}`)?.text;
  }

  async writeAtomic(sessionId: string, name: string, text: string): Promise<void> {
    this.put(sessionId, name, text);
  }

  async rename(sessionId: string, from: string, to: string): Promise<void> {
    const file = this.files.get(`${sessionId}/${from}`);
    this.files.delete(`${sessionId}/${from}`);
    if (file !== undefined) this.files.set(`${sessionId}/${to}`, file);
  }

  async remove(sessionId: string, name: string): Promise<void> {
    this.files.delete(`${sessionId}/${name}`);
  }

  async identity(sessionId: string, name: string): Promise<string | undefined> {
    return this.files.get(`${sessionId}/${name}`)?.identity;
  }

  async readIdentified(sessionId: string, name: string) {
    const file = this.files.get(`${sessionId}/${name}`);
    if (file !== undefined) this.parses += 1;
    return file;
  }

  /** A whole new file: what an atomic write, an editor or another process leaves behind. */
  put(sessionId: string, name: string, text: string): void {
    this.stamp += 1;
    this.files.set(`${sessionId}/${name}`, { text, identity: `file-${this.stamp}` });
  }
}

const request = {
  source: 'agent-raised' as const,
  sourceRef: null,
  subject: 'Choose deployment region',
  why: 'The rollout is blocked.',
  premise: 'A rollout is ready.',
  context: 'It cannot start until a region is chosen.',
  howToResolve: 'Choose a region.',
  ask: { kind: 'multiple-choice' as const, options: [{ label: 'eu' }, { label: 'us' }] },
};

const subject = () => {
  const files = new MemoryFiles();
  const repository = new FileAgendaLedgerRepository(id => `/state/sessions/${id}`, undefined, undefined, files);
  const service = new AgendaService(
    repository,
    { now: () => NOW },
    { has: async sessionId => sessionId === SESSION },
    { raised: async () => undefined },
  );
  return { files, repository, service };
};

const raise = async (service: AgendaService, subject = request.subject) =>
  await service.raise(SESSION, { ...request, subject }, { kind: 'agent', sessionId: SESSION, name: 'Ada' });

describe('the agenda repository cache', () => {
  it('should parse an unchanged agenda once, and hand every reader the same frozen copy', async () => {
    // Arrange
    const { files, repository, service } = subject();
    await raise(service);
    const parsed = files.parses;

    // Act
    const first = await repository.read(SESSION);
    const second = await repository.read(SESSION);

    // Assert
    should(files.parses).equal(parsed + 1);
    should(second).equal(first);
    should(Object.isFrozen(first)).be.true();
    should(Object.isFrozen(first?.entries[0]?.item)).be.true();
  });

  it('should see an agenda rewritten outside the daemon on the next read', async () => {
    // Arrange
    const { files, repository, service } = subject();
    await raise(service);
    should((await repository.read(SESSION))?.entries).have.length(1);

    // Act — a person (or another process) empties the file.
    files.put(SESSION, current, `${JSON.stringify(emptyAgendaLedger(SESSION, NOW))}\n`);
    const read = await repository.read(SESSION);

    // Assert
    should(read?.entries).have.length(0);
  });

  it("should see the daemon's own write at once, though a copy was kept a moment before", async () => {
    // Arrange
    const { repository, service } = subject();
    await raise(service);
    should((await service.list(SESSION)).ok).be.true();

    // Act
    await raise(service, 'Choose a second region');
    const listed = await service.list(SESSION);

    // Assert
    should(listed.ok && listed.value.count).equal(2);
    should((await repository.read(SESSION))?.entries).have.length(2);
  });

  it('should read the old name when only it exists, and nothing once neither does', async () => {
    // Arrange
    const { files, repository, service } = subject();
    await raise(service);
    await files.rename(SESSION, current, legacy);

    // Act
    const fromLegacy = await repository.read(SESSION);
    await files.remove(SESSION, legacy);
    const gone = await repository.read(SESSION);

    // Assert
    should(fromLegacy?.entries).have.length(1);
    should(gone).be.null();
  });

  it('should refuse a damaged agenda every time it is read, never serving the last good copy', async () => {
    // Arrange
    const { files, repository, service } = subject();
    await raise(service);
    await repository.read(SESSION);

    // Act
    files.put(SESSION, current, '{ "not": "a ledger"');

    // Assert
    await should(repository.read(SESSION)).be.rejectedWith({ name: 'Error', file: files.file(SESSION, current) });
    await should(repository.read(SESSION)).be.rejectedWith({ file: files.file(SESSION, current) });
  });
});
