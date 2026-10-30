import { describe, it } from 'bun:test';
import should from 'should';
import {
  AGENDA_FILES,
  type AgendaFilesMigrationCounts,
  type AgendaFileStore,
  MIGRATED_SUFFIX,
  migrateAgendaFile,
  migrateAgendaFiles,
  readAgendaFile,
} from '../../../src/lib/attention/agenda-files.ts';

const T1 = '2026-10-30T10:00:00.000Z';
const T2 = '2026-10-30T11:00:00.000Z';
const SESSION = 'session-1';

/** A session directory in memory, with the faults a disk can have. */
class MemoryStore implements AgendaFileStore {
  readonly files = new Map<string, string>();
  readonly writes: string[] = [];
  failWriteOf: string | undefined;
  failRenameOf: string | undefined;
  failRead = false;
  corruptWriteOf: string | undefined;

  put(sessionId: string, name: string, text: string): void {
    this.files.set(`${sessionId}/${name}`, text);
  }

  get(sessionId: string, name: string): string | undefined {
    return this.files.get(`${sessionId}/${name}`);
  }

  names(sessionId: string): string[] {
    return [...this.files.keys()]
      .filter(key => key.startsWith(`${sessionId}/`))
      .map(key => key.slice(sessionId.length + 1))
      .sort();
  }

  async read(sessionId: string, name: string): Promise<string | undefined> {
    if (this.failRead) throw new Error('disk unreadable');
    return this.get(sessionId, name);
  }

  async writeAtomic(sessionId: string, name: string, text: string): Promise<void> {
    if (this.failWriteOf === name) {
      // A crash after the temporary file and before the rename: the temporary file is left behind.
      this.put(sessionId, `.${name.replace('.json', '')}-crashed.tmp`, text);
      throw new Error('crashed before the rename');
    }
    this.writes.push(name);
    this.put(sessionId, name, this.corruptWriteOf === name ? '{"torn":' : text);
  }

  async rename(sessionId: string, from: string, to: string): Promise<void> {
    if (this.failRenameOf === from) throw new Error('rename refused');
    const text = this.get(sessionId, from);
    if (text === undefined) throw new Error('no such file');
    this.files.delete(`${sessionId}/${from}`);
    this.put(sessionId, to, text);
  }

  async remove(sessionId: string, name: string): Promise<void> {
    this.files.delete(`${sessionId}/${name}`);
  }
}

function ledger(updatedAt: string, nextId = 1, sessionId = SESSION): string {
  return `${JSON.stringify({ sessionId, nextId, entries: [], updatedAt }, null, 2)}\n`;
}

function outbox(at: string | undefined, sessionId = SESSION): string {
  const pending = at === undefined ? [] : [{ id: 'A1', message: 'yes', at }];
  return `${JSON.stringify({ v: 1, sessionId, pending, sending: [], delivered: [] }, null, 2)}\n`;
}

class Marker {
  done = false;
  readonly recorded: Array<{ at: string; counts: AgendaFilesMigrationCounts }> = [];
  failRead = false;

  async ran(): Promise<boolean> {
    if (this.failRead) throw new Error('marker unreadable');
    return this.done;
  }

  async record(at: string, counts: AgendaFilesMigrationCounts): Promise<void> {
    this.done = true;
    this.recorded.push({ at, counts });
  }
}

function world(store = new MemoryStore(), marker = new Marker()) {
  const lines: string[] = [];
  const ports = { marker, files: store, now: () => T2, log: (line: string) => void lines.push(line) };
  return { store, marker, lines, ports };
}

const LEDGER = AGENDA_FILES.ledger;
const OUTBOX = AGENDA_FILES.outbox;

describe('readAgendaFile', () => {
  it('should read the new name when both names exist', async () => {
    // Arrange
    const store = new MemoryStore();
    store.put(SESSION, LEDGER.legacy, ledger(T1));
    store.put(SESSION, LEDGER.current, ledger(T2));

    // Act
    const found = await readAgendaFile(store, SESSION, 'ledger');

    // Assert
    should(found).deepEqual({ name: 'agenda.json', text: ledger(T2) });
  });

  it('should fall back to the old name when the new one is absent', async () => {
    // Arrange
    const store = new MemoryStore();
    store.put(SESSION, OUTBOX.legacy, outbox(T1));

    // Act
    const found = await readAgendaFile(store, SESSION, 'outbox');

    // Assert
    should(found).deepEqual({ name: 'attention-replies.json', text: outbox(T1) });
  });

  it('should find nothing when neither name exists', async () => {
    // Act / Assert
    should(await readAgendaFile(new MemoryStore(), SESSION, 'ledger')).be.undefined();
  });
});

describe('migrateAgendaFile', () => {
  it('should do nothing for a session that never had the file', async () => {
    // Act / Assert
    should(await migrateAgendaFile(new MemoryStore(), SESSION, 'ledger')).equal('nothing');
  });

  it('should copy an old ledger to the new name, verify it, and keep the old one as .migrated', async () => {
    // Arrange
    const store = new MemoryStore();
    store.put(SESSION, LEDGER.legacy, ledger(T1, 3));

    // Act
    const result = await migrateAgendaFile(store, SESSION, 'ledger');

    // Assert
    should(result).equal('migrated');
    should(store.names(SESSION)).deepEqual(['agenda.json', `attention.json${MIGRATED_SUFFIX}`]);
    should(store.get(SESSION, 'agenda.json')).equal(ledger(T1, 3));
    should(store.get(SESSION, `attention.json${MIGRATED_SUFFIX}`)).equal(ledger(T1, 3));
  });

  it('should move an old outbox the same way', async () => {
    // Arrange
    const store = new MemoryStore();
    store.put(SESSION, OUTBOX.legacy, outbox(T1));

    // Act
    const result = await migrateAgendaFile(store, SESSION, 'outbox');

    // Assert
    should(result).equal('migrated');
    should(store.names(SESSION)).deepEqual(['agenda-replies.json', 'attention-replies.json.migrated']);
    should(store.get(SESSION, 'agenda-replies.json')).equal(outbox(T1));
  });

  it('should keep the new ledger and set the old aside when the new one is newer', async () => {
    // Arrange
    const store = new MemoryStore();
    store.put(SESSION, LEDGER.legacy, ledger(T1));
    store.put(SESSION, LEDGER.current, ledger(T2));

    // Act
    const result = await migrateAgendaFile(store, SESSION, 'ledger');

    // Assert
    should(result).equal('kept-new');
    should(store.get(SESSION, 'agenda.json')).equal(ledger(T2));
    should(store.get(SESSION, `attention.json${MIGRATED_SUFFIX}`)).equal(ledger(T1));
    should(store.get(SESSION, 'attention.json')).be.undefined();
  });

  it('should make the old ledger current and keep the other as .migrated when the old one is newer', async () => {
    // Arrange — a downgrade wrote the old file after the new one existed.
    const store = new MemoryStore();
    store.put(SESSION, LEDGER.legacy, ledger(T2));
    store.put(SESSION, LEDGER.current, ledger(T1));

    // Act
    const result = await migrateAgendaFile(store, SESSION, 'ledger');

    // Assert
    should(result).equal('migrated');
    should(store.get(SESSION, 'agenda.json')).equal(ledger(T2));
    should(store.get(SESSION, `agenda.json${MIGRATED_SUFFIX}`)).equal(ledger(T1));
    should(store.get(SESSION, `attention.json${MIGRATED_SUFFIX}`)).equal(ledger(T2));
    should(store.get(SESSION, 'attention.json')).be.undefined();
  });

  it('should keep the newer old ledger readable when its copy over the new name does not read back equal', async () => {
    // Arrange
    const store = new MemoryStore();
    store.put(SESSION, LEDGER.legacy, ledger(T2));
    store.put(SESSION, LEDGER.current, ledger(T1));
    store.corruptWriteOf = 'agenda.json';

    // Act
    const result = await migrateAgendaFile(store, SESSION, 'ledger');

    // Assert — the reader falls back to the old (newer) file; the next start migrates it again.
    should(result).equal('failed');
    should(store.get(SESSION, 'attention.json')).equal(ledger(T2));
    should(store.get(SESSION, 'agenda.json')).be.undefined();
    should(store.get(SESSION, `agenda.json${MIGRATED_SUFFIX}`)).equal(ledger(T1));
  });

  it('should break a tie on the same instant by the ledger that raised more items', async () => {
    // Arrange
    const store = new MemoryStore();
    store.put(SESSION, LEDGER.legacy, ledger(T1, 5));
    store.put(SESSION, LEDGER.current, ledger(T1, 4));

    // Act
    await migrateAgendaFile(store, SESSION, 'ledger');

    // Assert
    should(store.get(SESSION, 'agenda.json')).equal(ledger(T1, 5));
  });

  it('should keep the new ledger on a complete tie', async () => {
    // Arrange
    const store = new MemoryStore();
    store.put(SESSION, LEDGER.legacy, ledger(T1, 4));
    store.put(SESSION, LEDGER.current, ledger(T1, 4));

    // Act
    const result = await migrateAgendaFile(store, SESSION, 'ledger');

    // Assert
    should(result).equal('kept-new');
    should(store.writes).deepEqual([]);
  });

  it('should date an outbox by the latest instant of any answer in it', async () => {
    // Arrange — the new outbox holds a batch sent later than anything the old one holds.
    const store = new MemoryStore();
    store.put(SESSION, OUTBOX.legacy, outbox(T1));
    store.put(
      SESSION,
      OUTBOX.current,
      `${JSON.stringify({
        v: 1,
        sessionId: SESSION,
        pending: [],
        sending: [
          {
            sendId: 'agenda-s-A1',
            ids: ['A1'],
            message: 'm',
            replies: [{ id: 'A1', message: 'm', at: T1 }],
            sentAt: T2,
          },
          { sendId: 'agenda-s-A2', ids: ['A2'], message: 'm' },
        ],
        delivered: [],
      })}\n`,
    );

    // Act
    const result = await migrateAgendaFile(store, SESSION, 'outbox');

    // Assert
    should(result).equal('kept-new');
  });

  it('should date an outbox batch by its answers when it was never sent', async () => {
    // Arrange
    const store = new MemoryStore();
    store.put(
      SESSION,
      OUTBOX.legacy,
      `${JSON.stringify({
        v: 1,
        sessionId: SESSION,
        pending: [],
        sending: [
          { sendId: 'attention-s-A1', ids: ['A1'], message: 'm', replies: [{ id: 'A1', message: 'm', at: T2 }] },
        ],
        delivered: [],
      })}\n`,
    );
    store.put(SESSION, OUTBOX.current, outbox(T1));

    // Act
    const result = await migrateAgendaFile(store, SESSION, 'outbox');

    // Assert
    should(result).equal('migrated');
    should(store.get(SESSION, 'agenda-replies.json')).containEql('attention-s-A1');
  });

  it('should leave an empty old outbox from outranking a new one that holds an answer', async () => {
    // Arrange
    const store = new MemoryStore();
    store.put(SESSION, OUTBOX.legacy, outbox(undefined));
    store.put(SESSION, OUTBOX.current, outbox(T1));

    // Act
    const result = await migrateAgendaFile(store, SESSION, 'outbox');

    // Assert
    should(result).equal('kept-new');
  });

  it('should leave a damaged old ledger exactly where it is and fail the session', async () => {
    // Arrange
    const store = new MemoryStore();
    store.put(SESSION, LEDGER.legacy, '{"torn":');

    // Act
    const result = await migrateAgendaFile(store, SESSION, 'ledger');

    // Assert
    should(result).equal('failed');
    should(store.names(SESSION)).deepEqual(['attention.json']);
    should(store.get(SESSION, 'attention.json')).equal('{"torn":');
  });

  it('should fail, and leave both files, when the old ledger is for another session', async () => {
    // Arrange
    const store = new MemoryStore();
    store.put(SESSION, LEDGER.legacy, ledger(T1, 1, 'someone-else'));

    // Act / Assert
    should(await migrateAgendaFile(store, SESSION, 'ledger')).equal('failed');
    should(store.names(SESSION)).deepEqual(['attention.json']);
  });

  it('should fail an old outbox for another session or of an unknown shape', async () => {
    // Arrange
    const store = new MemoryStore();
    store.put(SESSION, OUTBOX.legacy, outbox(T1, 'someone-else'));

    // Act / Assert
    should(await migrateAgendaFile(store, SESSION, 'outbox')).equal('failed');
    store.put(SESSION, OUTBOX.legacy, '{"v":2}');
    should(await migrateAgendaFile(store, SESSION, 'outbox')).equal('failed');
    should(store.names(SESSION)).deepEqual(['attention-replies.json']);
  });

  it('should fail, and leave both files, when the new file is damaged', async () => {
    // Arrange
    const store = new MemoryStore();
    store.put(SESSION, LEDGER.legacy, ledger(T1));
    store.put(SESSION, LEDGER.current, '{"torn":');

    // Act
    const result = await migrateAgendaFile(store, SESSION, 'ledger');

    // Assert
    should(result).equal('failed');
    should(store.names(SESSION)).deepEqual(['agenda.json', 'attention.json']);
  });

  it('should leave the old file and no half-made new one when the copy does not read back equal', async () => {
    // Arrange
    const store = new MemoryStore();
    store.put(SESSION, LEDGER.legacy, ledger(T1));
    store.corruptWriteOf = 'agenda.json';

    // Act
    const result = await migrateAgendaFile(store, SESSION, 'ledger');

    // Assert
    should(result).equal('failed');
    should(store.names(SESSION)).deepEqual(['attention.json']);
  });

  it('should leave the old file and no new one when the copy is gone on read-back', async () => {
    // Arrange
    const store = new MemoryStore();
    store.put(SESSION, LEDGER.legacy, ledger(T1));
    const read = store.read.bind(store);
    store.read = async (sessionId, name) =>
      name === 'agenda.json' && store.writes.length > 0 ? undefined : await read(sessionId, name);

    // Act
    const result = await migrateAgendaFile(store, SESSION, 'ledger');

    // Assert
    should(result).equal('failed');
    should(store.names(SESSION)).deepEqual(['attention.json']);
  });

  it('should survive a crash before the rename: the tmp is left, the old file is intact, the next start finishes', async () => {
    // Arrange
    const store = new MemoryStore();
    store.put(SESSION, LEDGER.legacy, ledger(T1, 2));
    store.failWriteOf = 'agenda.json';

    // Act
    const crashed = await migrateAgendaFile(store, SESSION, 'ledger');
    store.failWriteOf = undefined;
    const retried = await migrateAgendaFile(store, SESSION, 'ledger');

    // Assert
    should(crashed).equal('failed');
    should(retried).equal('migrated');
    should(store.get(SESSION, 'agenda.json')).equal(ledger(T1, 2));
    should(store.get(SESSION, `attention.json${MIGRATED_SUFFIX}`)).equal(ledger(T1, 2));
    should(store.names(SESSION).filter(name => name.endsWith('.tmp'))).have.length(1);
  });

  it('should lose nothing when the rename of the old file fails, and finish on the next start', async () => {
    // Arrange
    const store = new MemoryStore();
    store.put(SESSION, LEDGER.legacy, ledger(T1, 2));
    store.failRenameOf = 'attention.json';

    // Act
    const failed = await migrateAgendaFile(store, SESSION, 'ledger');
    const bothPresent = [store.get(SESSION, 'agenda.json'), store.get(SESSION, 'attention.json')];
    store.failRenameOf = undefined;
    const retried = await migrateAgendaFile(store, SESSION, 'ledger');

    // Assert
    should(failed).equal('failed');
    should(bothPresent).deepEqual([ledger(T1, 2), ledger(T1, 2)]);
    should(retried).equal('kept-new');
    should(store.names(SESSION)).deepEqual(['agenda.json', `attention.json${MIGRATED_SUFFIX}`]);
  });

  it('should fail, and change nothing, when the store cannot be read', async () => {
    // Arrange
    const store = new MemoryStore();
    store.put(SESSION, LEDGER.legacy, ledger(T1));
    store.failRead = true;

    // Act / Assert
    should(await migrateAgendaFile(store, SESSION, 'ledger')).equal('failed');
    should(store.names(SESSION)).deepEqual(['attention.json']);
  });
});

describe('migrateAgendaFiles', () => {
  it('should write the marker on a fresh install with nothing to migrate', async () => {
    // Arrange
    const { marker, lines, ports } = world();

    // Act
    const outcome = await migrateAgendaFiles([], ports);

    // Assert
    should(outcome).deepEqual({ ran: true, sessions: 0, migrated: 0, keptNew: 0, failed: 0 });
    should(marker.recorded).deepEqual([{ at: T2, counts: { sessions: 0, migrated: 0, keptNew: 0, failed: 0 } }]);
    should(lines).deepEqual(['agenda files: 0 sessions, 0 migrated, 0 already current, 0 failed']);
  });

  it('should migrate each session, count them, and write the marker once', async () => {
    // Arrange
    const { store, marker, lines, ports } = world();
    store.put('s-old', LEDGER.legacy, ledger(T1, 1, 's-old'));
    store.put('s-old', OUTBOX.legacy, outbox(T1, 's-old'));
    store.put('s-both', LEDGER.legacy, ledger(T1, 1, 's-both'));
    store.put('s-both', LEDGER.current, ledger(T2, 1, 's-both'));
    store.put('s-none', 'config.json', '{}');

    // Act
    const outcome = await migrateAgendaFiles(['s-old', 's-both', 's-none'], ports);

    // Assert
    should(outcome).deepEqual({ ran: true, sessions: 3, migrated: 1, keptNew: 1, failed: 0 });
    should(store.names('s-old')).deepEqual([
      'agenda-replies.json',
      'agenda.json',
      'attention-replies.json.migrated',
      'attention.json.migrated',
    ]);
    should(marker.done).be.true();
    should(lines).deepEqual(['agenda files: 3 sessions, 1 migrated, 1 already current, 0 failed']);
  });

  it('should write no marker when a session failed, and retry it next start', async () => {
    // Arrange
    const { store, marker, lines, ports } = world();
    store.put('s-bad', LEDGER.legacy, '{"torn":');
    store.put('s-good', LEDGER.legacy, ledger(T1, 1, 's-good'));

    // Act
    const first = await migrateAgendaFiles(['s-bad', 's-good'], ports);
    store.put('s-bad', LEDGER.legacy, ledger(T1, 1, 's-bad'));
    const second = await migrateAgendaFiles(['s-bad', 's-good'], ports);

    // Assert
    should(first).deepEqual({ ran: false, sessions: 2, migrated: 1, keptNew: 0, failed: 1 });
    should(lines[0]).equal('agenda files: 2 sessions, 1 migrated, 0 already current, 1 failed (retried next start)');
    should(second).deepEqual({ ran: true, sessions: 2, migrated: 1, keptNew: 0, failed: 0 });
    should(marker.recorded).have.length(1);
    should(store.get('s-bad', 'agenda.json')).equal(ledger(T1, 1, 's-bad'));
  });

  it('should do no work once the marker is present', async () => {
    // Arrange
    const { store, marker, lines, ports } = world();
    marker.done = true;
    store.put(SESSION, LEDGER.legacy, ledger(T1));

    // Act
    const outcome = await migrateAgendaFiles([SESSION], ports);

    // Assert
    should(outcome).deepEqual({ ran: false, sessions: 0, migrated: 0, keptNew: 0, failed: 0 });
    should(store.names(SESSION)).deepEqual(['attention.json']);
    should(lines).deepEqual([]);
  });

  it('should never reject: an unreadable marker or a marker that cannot be written is only a failed run', async () => {
    // Arrange
    const unreadable = world();
    unreadable.marker.failRead = true;
    const unwritable = world();
    unwritable.marker.record = async () => {
      throw new Error('disk full');
    };

    // Act / Assert
    should(await migrateAgendaFiles([SESSION], unreadable.ports)).deepEqual({
      ran: false,
      sessions: 0,
      migrated: 0,
      keptNew: 0,
      failed: 0,
    });
    should((await migrateAgendaFiles([SESSION], unwritable.ports)).ran).be.false();
  });

  it('should count a session once however many of its files failed', async () => {
    // Arrange
    const { store, ports } = world();
    store.put(SESSION, LEDGER.legacy, '{"torn":');
    store.put(SESSION, OUTBOX.legacy, '{"torn":');

    // Act
    const outcome = await migrateAgendaFiles([SESSION], ports);

    // Assert
    should(outcome.failed).equal(1);
  });
});
