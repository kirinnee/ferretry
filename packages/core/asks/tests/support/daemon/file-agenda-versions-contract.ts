import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, it, spyOn } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  FileAgendaSeenStore as StateAgendaSeenStore,
  SqliteAgendaVersionStore,
} from '../../../daemon/adapters/agenda/file-agenda-versions.ts';
import { agendaFilePath, agendaFilesAt, asksStateAt, versionArchivePath } from './agenda-state.ts';
import {
  type AgendaActor,
  type AgendaEntry,
  type AgendaLedger,
  type AgendaMutation,
  applyAgendaCommand,
  applyAgendaCommandToSession,
} from '../../../daemon/lib/agenda/state-machine.ts';
import { type AgendaVersionDraft, versionDrafts } from '../../../daemon/lib/agenda/versions.ts';

const SESSION = 'session-1';
/** The version store over a home's kernel state folder; `home` is read once, as a daemon opens its state. */
class FileAgendaVersionStore extends SqliteAgendaVersionStore {
  constructor(home: () => string) {
    super(asksStateAt(home()));
  }

  /** Every connection closes after its operation: there is nothing to close. */
  close(): void {}
}
/** The seen marks of a home's ferrets, as the daemon keeps them. */
class FileAgendaSeenStore extends StateAgendaSeenStore {
  constructor(home: () => string, uniqueId: () => string = () => 'id', warn: (message: string) => void = () => undefined) {
    super(agendaFilesAt(home()), uniqueId, warn);
  }
}
const VERSIONS = (root: string): string => join(root, 'state', 'asks', 'versions');
const SEEN = (root: string): string => agendaFilePath(root, SESSION, 'agenda-seen.json');
const T = (minute: number): string => `2026-07-30T10:${String(minute).padStart(2, '0')}:00Z`;
const HUMAN: AgendaActor = { kind: 'human' };
const AGENT: AgendaActor = { kind: 'agent', sessionId: SESSION, name: 'Ada' };

const ok = (result: AgendaMutation): Extract<AgendaMutation, { ok: true }> => {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result;
};

const raised = ok(
  applyAgendaCommandToSession(null, SESSION, {
    action: 'raise',
    actor: AGENT,
    request: {
      source: 'agent-raised',
      sourceRef: null,
      subject: 'Which region do we deploy to?',
      why: 'The release waits on the region.',
      context: 'The deploy changes the public service.',
      premise: 'A release is ready to go out.',
      howToResolve: 'Answer in words.',
      ask: { kind: 'open-question' },
    },
    at: T(0),
  }),
);

const entryOf = (ledger: AgendaLedger): AgendaEntry => {
  const entry = ledger.entries[0];
  if (entry === undefined) throw new Error('no entry');
  return entry;
};

const draft = (entry: AgendaEntry, change: string, at: string, before?: AgendaEntry): AgendaVersionDraft => ({
  entry,
  at,
  by: 'ferret',
  change,
  ...(before === undefined ? {} : { before }),
});

/** Shared behavior contract: unit regressions and the IO tier both prove these storage boundaries. */
export function agendaVersionStoreContract() {
  describe('FileAgendaVersionStore', () => {
    let root: string;
    let store: FileAgendaVersionStore;
    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'agenda-versions-'));
      store = new FileAgendaVersionStore(() => root);
    });
    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it('should keep every version whole and numbered from 1, with no cap', async () => {
      // Arrange
      const entry = entryOf(raised.ledger);

      // Act
      for (let index = 0; index < 40; index += 1) await store.record(SESSION, [draft(entry, 'edited', T(index % 60))]);
      const list = await store.list(SESSION, 'A1');
      const last = await store.get(SESSION, 'A1', 40);

      // Assert
      should(list).have.length(40);
      should(list.map(row => row.version)).deepEqual(Array.from({ length: 40 }, (_, index) => index + 1));
      should(last?.item.id).equal('A1');
      should(await store.get(SESSION, 'A1', 41)).be.undefined();
    });

    it('should keep an item from before versions as its first version, so a change has something to read against', async () => {
      // Arrange
      const before = entryOf(raised.ledger);
      const after = entryOf(
        ok(applyAgendaCommand(raised.ledger, { action: 'reply', actor: HUMAN, id: 'A1', note: 'eu', at: T(1) })).ledger,
      );

      // Act
      await store.record(SESSION, [draft(after, 'replied', T(1), before)]);
      const list = await store.list(SESSION, 'A1');

      // Assert
      should(list.map(row => [row.version, row.change])).deepEqual([
        [1, 'carried'],
        [2, 'replied'],
      ]);
    });

    it('should read an item with no versions as an empty list, and refuse a name that is not an id', async () => {
      // Arrange
      const missing = await store.list(SESSION, 'A7');

      // Act
      const refused = store.list(SESSION, '../x' as never);

      // Assert
      should(missing).deepEqual([]);
      await refused.then(
        () => should.fail(undefined, undefined, 'expected a refusal'),
        error => should(String(error)).containEql('not a valid agenda id'),
      );
    });

    it('should create no archive file by being asked about an id nothing was recorded for', async () => {
      // Arrange
      const file = versionArchivePath(root, SESSION, 'A7');

      // Act
      await store.list(SESSION, 'A7');
      await store.get(SESSION, 'A7', 1);
      await store.conversation(SESSION, 'A7', 1);
      const asked = await stat(file).then(
        () => true,
        () => false,
      );
      const entry = entryOf(raised.ledger);
      await store.record(SESSION, [
        draft({ ...entry, item: { ...entry.item, id: 'A7' } } as AgendaEntry, 'created', T(0)),
      ]);
      const recorded = await stat(file).then(
        () => true,
        () => false,
      );

      // Assert
      should([asked, recorded]).deepEqual([false, true]);
    });

    describe('voiding what a change that never committed recorded', () => {
      const identified = (each: AgendaVersionDraft, mutationId: string): AgendaVersionDraft => ({
        ...each,
        mutationId,
      });
      const replied = entryOf(
        ok(applyAgendaCommand(raised.ledger, { action: 'reply', actor: HUMAN, id: 'A1', note: 'eu', at: T(1) })).ledger,
      );
      const first = identified(draft(entryOf(raised.ledger), 'created', T(0)), 'm1:0');
      const second = identified(draft(replied, 'replied', T(1)), 'm2:0');

      it('should take the version a mutation made off the end, and let the same change be recorded again', async () => {
        // Arrange
        await store.record(SESSION, [first]);
        await store.record(SESSION, [second]);
        await store.get(SESSION, 'A1', 2);

        // Act
        await store.discard(SESSION, [second]);
        const after = await store.list(SESSION, 'A1');
        const gone = await store.get(SESSION, 'A1', 2);
        await store.record(SESSION, [second]);

        // Assert
        should(after.map(row => [row.version, row.change])).deepEqual([[1, 'created']]);
        should(gone).be.undefined();
        should((await store.list(SESSION, 'A1')).map(row => [row.version, row.change])).deepEqual([
          [1, 'created'],
          [2, 'replied'],
        ]);
      });

      it('should peel an intent that made several versions of one item, latest first, and keep the carried one before', async () => {
        // Arrange: the intent's change was the item's first, so it made the carried version and its own.
        const before = entryOf(raised.ledger);
        const carrying = identified(draft(replied, 'replied', T(1), before), 'm3:0');
        const next = identified(draft(replied, 'edited', T(2)), 'm3:1');
        await store.record(SESSION, [carrying, next]);

        // Act
        await store.discard(SESSION, [carrying, next]);

        // Assert
        should((await store.list(SESSION, 'A1')).map(row => [row.version, row.change])).deepEqual([[1, 'carried']]);
      });

      it('should leave an item with no store, a draft with no mutation and a mutation it never held as they are', async () => {
        // Arrange
        await store.record(SESSION, [first, second]);
        const other = entryOf(raised.ledger);
        const elsewhere = identified(
          draft({ ...other, item: { ...other.item, id: 'A7' } } as AgendaEntry, 'created', T(0)),
          'm9:0',
        );

        // Act
        await store.discard(SESSION, [elsewhere, draft(replied, 'replied', T(1)), identified(second, 'm-never')]);

        // Assert
        should((await store.list(SESSION, 'A7')).length).equal(0);
        should((await store.list(SESSION, 'A1')).map(row => row.version)).deepEqual([1, 2]);
      });

      it('should void only a version that is still the latest, and refuse a name that is not an id', async () => {
        // Arrange
        await store.record(SESSION, [first]);
        await store.record(SESSION, [second]);

        // Act: the first mutation is no longer the tail; one whose time and change differ is not its version either.
        await store.discard(SESSION, [first]);
        await store.discard(SESSION, [{ ...second, at: T(7) }]);
        const refused = await store
          .discard(SESSION, [
            { ...second, entry: { ...second.entry, item: { ...second.entry.item, id: '../x' } } } as AgendaVersionDraft,
          ])
          .then(
            () => 'discarded',
            error => String(error),
          );

        // Assert
        should((await store.list(SESSION, 'A1')).map(row => row.version)).deepEqual([1, 2]);
        should(refused).containEql('not a valid agenda id');
      });
    });

    it('should make a version of each entry a committed change touched', () => {
      // Arrange
      const replied = ok(
        applyAgendaCommand(raised.ledger, { action: 'reply', actor: HUMAN, id: 'A1', note: 'eu', at: T(1) }),
      );

      // Act
      const drafts = versionDrafts(raised.ledger, replied, 'owner');

      // Assert
      should(drafts.map(each => each.entry.item.id)).deepEqual(['A1']);
    });
  });

  describe('FileAgendaSeenStore', () => {
    let root: string;
    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), 'agenda-seen-'));
    });
    afterEach(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it('should keep the latest version a device opened, and never go back', async () => {
      // Arrange
      const seen = new FileAgendaSeenStore(() => root);

      // Act
      const first = await seen.mark(SESSION, 'A1', 'phone', 3);
      const earlier = await seen.mark(SESSION, 'A1', 'phone', 2);
      const later = await seen.mark(SESSION, 'A1', 'phone', 5);

      // Assert
      should([first, earlier, later]).deepEqual([3, 3, 5]);
      should(await seen.seen(SESSION, 'A1', 'phone')).equal(5);
    });

    it('should keep a mark per device and per item', async () => {
      // Arrange
      const seen = new FileAgendaSeenStore(() => root);
      await seen.mark(SESSION, 'A1', 'phone', 4);

      // Act
      const other = await seen.seen(SESSION, 'A1', 'laptop');
      const item = await seen.seen(SESSION, 'A2', 'phone');

      // Assert
      should([other, item]).deepEqual([undefined, undefined]);
    });

    it('should set aside a seen document that is not marks, say so, and start from none', async () => {
      // Arrange
      const warnings: string[] = [];
      const seen = new FileAgendaSeenStore(
        () => root,
        () => 'id1',
        message => warnings.push(message),
      );
      await seen.mark(SESSION, 'A1', 'laptop', 4);
      const file = SEEN(root);
      await writeFile(file, '{"laptop":{"A1":4},');
      const damaged = await readFile(file, 'utf8');
      const marksSeenWhileDamaged = await seen.seen(SESSION, 'A1', 'laptop');

      // Act
      const marked = await seen.mark(SESSION, 'A1', 'phone', 2);
      await writeFile(file, '{"phone":{"A1":"two"}}');
      const again = await seen.mark(SESSION, 'A1', 'phone', 3);

      // Assert
      should(marksSeenWhileDamaged).be.undefined();
      should([marked, again]).deepEqual([2, 3]);
      should(await readFile(join(root, 'state', 'asks', 'set-aside', `${SESSION}~agenda-seen.json.corrupt-id1`), 'utf8')).equal('{"phone":{"A1":"two"}}');
      should(JSON.parse(await readFile(file, 'utf8'))).deepEqual({ phone: { A1: 3 } });
      should(warnings).have.length(2);
      should(warnings[0]).containEql('set aside as');
      should(damaged).equal('{"laptop":{"A1":4},');
    });

    it('should refuse to mark over a seen document it cannot read at all, and leave it untouched', async () => {
      // Arrange: a directory where the file should be is an unreadable file, not a damaged one.
      const seen = new FileAgendaSeenStore(() => root);
      await mkdir(SEEN(root), { recursive: true });

      // Act
      const marked = await seen.mark(SESSION, 'A1', 'phone', 2).then(
        () => 'marked',
        () => 'refused',
      );

      // Assert
      should(marked).equal('refused');
      should((await stat(SEEN(root))).isDirectory()).be.true();
    });

    it('should hold up under marks made at once, and leave a readable file', async () => {
      // Arrange
      const seen = new FileAgendaSeenStore(() => root);

      // Act
      await Promise.all([1, 2, 3, 4, 5, 6].map(version => seen.mark(SESSION, 'A1', 'phone', version)));
      const text = await readFile(SEEN(root), 'utf8');

      // Assert
      should(JSON.parse(text)).deepEqual({ phone: { A1: 6 } });
    });
  });

  it('keeps the full historical conversation outside each bounded version snapshot', async () => {
    // Arrange
    const root = await mkdtemp(join(tmpdir(), 'agenda-version-words-'));
    try {
      const store = new FileAgendaVersionStore(() => root);
      const source = `    ${'x'.repeat(1_100_000)}Z\n`;
      const first = ok(
        applyAgendaCommand(raised.ledger, {
          action: 'log',
          actor: AGENT,
          id: 'A1',
          mode: 'reply',
          words: 'OK',
          chat: { messageId: 'new', at: T(5), text: source },
          at: T(6),
        }),
      );
      await store.record(SESSION, versionDrafts(raised.ledger, first, 'ferret'));
      const second = ok(
        applyAgendaCommand(first.ledger, {
          action: 'log',
          actor: AGENT,
          id: 'A1',
          mode: 'reply',
          words: 'OK',
          chat: { messageId: 'old', at: T(1), text: 'Earlier words' },
          at: T(7),
        }),
      );
      await store.record(SESSION, versionDrafts(first.ledger, second, 'ferret'));

      // Act
      const frozen = await store.conversation(SESSION, 'A1', 2);
      const current = await store.conversation(SESSION, 'A1', 3);
      const snapshot = await store.get(SESSION, 'A1', 2);

      // Assert
      should(frozen?.map(entry => entry.text)).deepEqual([source, 'OK']);
      should(current?.map(entry => entry.text)).deepEqual(['Earlier words', source, 'OK', 'OK']);
      should(JSON.stringify(snapshot).length).be.below(1_000_000);
      should(snapshot?.item.conversationCount).equal(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reads a malformed seen document as empty and refuses a mark it cannot write', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const root = await mkdtemp(join(tmpdir(), 'agenda-seen-recovery-'));
    try {
      const file = SEEN(root);
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(file, '[]');
      const store = new FileAgendaSeenStore(() => root);
      should(await store.seen(SESSION, 'A1', 'phone')).be.undefined();
      await rm(file);
      await mkdir(file);
      await should(store.mark(SESSION, 'A1', 'phone', 1)).be.rejected();
      await rm(file, { recursive: true });
      should(await store.mark(SESSION, 'A1', 'phone', 2)).equal(2);
      should(await store.seen(SESSION, 'A1', 'phone')).equal(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps cold reads and append parsing independent of version count, and shares immutable text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agenda-version-scaling-'));
    try {
      const directory = () => root;
      const store = new FileAgendaVersionStore(directory);
      const text = `    ${'x'.repeat(1_100_000)}END\n`;
      const conversation = [{ at: T(1), by: 'owner' as const, via: 'reply' as const, text }];
      const next = { ...draft(entryOf(raised.ledger), 'edited', T(2)), conversation };
      await store.record(SESSION, [next]);
      const file = versionArchivePath(root, SESSION, 'A1');
      const firstSize = (await stat(file)).size;
      const parse = JSON.parse;
      const measured = async (read: () => Promise<unknown>): Promise<number> => {
        let bytes = 0;
        const spy = spyOn(JSON, 'parse').mockImplementation((source, reviver) => {
          bytes += Buffer.byteLength(source);
          return parse(source, reviver);
        });
        try {
          await read();
          return bytes;
        } finally {
          spy.mockRestore();
        }
      };
      const page = async (reader: FileAgendaVersionStore, version: number) => {
        await reader.get(SESSION, 'A1', version);
        return (await reader.conversation(SESSION, 'A1', version))?.[0]?.text.slice(16_384, 32_768);
      };
      const initialRead = await measured(() => page(new FileAgendaVersionStore(directory), 1));
      const initialAppend = await measured(() => store.record(SESSION, [next]));
      for (let index = 0; index < 98; index += 1) await store.record(SESSION, [next]);
      const laterRead = await measured(() => page(new FileAgendaVersionStore(directory), 1));
      const laterAppend = await measured(() => store.record(SESSION, [next]));
      should(laterRead).equal(initialRead);
      should(initialRead).be.below(Buffer.byteLength(text) + 10_000);
      should([initialAppend, laterAppend]).deepEqual([0, 0]);
      const reader = new FileAgendaVersionStore(directory);
      should(await page(reader, 1)).equal(text.slice(16_384, 32_768));
      should(await measured(() => page(reader, 1))).equal(0);
      should((await stat(file)).size - firstSize).be.below(400_000);
      should((await stat(file)).mode & 0o777).equal(0o600);
      const db = new Database(file, { readonly: true });
      try {
        should(db.query('SELECT COUNT(*) AS n FROM words').get()).deepEqual({ n: 1 });
        // SQLite's actual plans must seek keys, so the parse budget cannot hide a payload scan.
        for (const sql of [
          'SELECT snapshot FROM versions WHERE version = 1',
          'SELECT MAX(version) FROM versions',
          'SELECT words.entry FROM version_words JOIN words ON words.hash = version_words.hash WHERE version_words.version = 1 ORDER BY version_words.position',
        ]) {
          const plan = db.query<{ detail: string }, []>(`EXPLAIN QUERY PLAN ${sql}`).all();
          should(plan.every(row => row.detail.startsWith('SEARCH '))).be.true();
        }
      } finally {
        db.close();
      }
      should(await reader.conversation(SESSION, 'A1', 999)).be.undefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rolls back a failed version with its references, and refuses a store of a version it does not read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agenda-version-atomic-'));
    try {
      const store = new FileAgendaVersionStore(() => root);
      await should(store.list('../bad', 'A1')).be.rejectedWith(/not a valid agenda session id/u);
      const next = draft(entryOf(raised.ledger), 'created', T(1));
      await should(
        store.record(SESSION, [
          {
            ...next,
            conversation: [
              { at: T(1), by: 'owner', via: 'reply', text: 'A word written before the failure' },
              { at: T(1), by: 'owner', via: 'reply', text: '' },
            ],
          },
        ]),
      ).be.rejected();
      should(await store.list(SESSION, 'A1')).deepEqual([]);
      const db = new Database(versionArchivePath(root, SESSION, 'A1'), { readonly: true });
      try {
        should(db.query('SELECT COUNT(*) AS n FROM words').get()).deepEqual({ n: 0 });
        should(db.query('SELECT COUNT(*) AS n FROM version_words').get()).deepEqual({ n: 0 });
      } finally {
        db.close();
      }
      await store.record(SESSION, [next]);
      should((await store.list(SESSION, 'A1')).map(row => row.version)).deepEqual([1]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a store at a format it does not read (its user_version), by name, and leaves the file untouched', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agenda-version-unsupported-'));
    try {
      const directory = VERSIONS(root);
      await mkdir(directory, { recursive: true });
      const file = join(directory, `${SESSION}~A1.sqlite`);
      for (const stored of [2, 3]) {
        const db = new Database(file);
        db.exec(`CREATE TABLE versions (version INTEGER PRIMARY KEY); PRAGMA user_version = ${stored}`);
        db.close();
        const before = await readFile(file);
        const store = new FileAgendaVersionStore(() => root);
        try {
          await should(store.record(SESSION, [draft(entryOf(raised.ledger), 'created', T(1))])).be.rejectedWith(
            /session-1~A1\.sqlite was written by a newer Ferretry/u,
          );
          await should(store.list(SESSION, 'A1')).be.rejectedWith(/newer Ferretry/u);
        } finally {
          store.close();
        }
        should(Buffer.compare(await readFile(file), before)).equal(0);
        await rm(file);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a nonempty store with no user_version and leaves it byte-identical', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agenda-version-unversioned-'));
    try {
      const directory = VERSIONS(root);
      await mkdir(directory, { recursive: true });
      const file = join(directory, `${SESSION}~A1.sqlite`);
      const db = new Database(file);
      db.exec('CREATE TABLE somebody_elses (id TEXT PRIMARY KEY)');
      db.close();
      const before = await readFile(file);
      const store = new FileAgendaVersionStore(() => root);
      try {
        await should(store.record(SESSION, [draft(entryOf(raised.ledger), 'created', T(1))])).be.rejectedWith(
          /session-1~A1\.sqlite has no "format" number/u,
        );
        await should(store.list(SESSION, 'A1')).be.rejectedWith(/no "format" number/u);
      } finally {
        store.close();
      }
      should(Buffer.compare(await readFile(file), before)).equal(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('initializes an empty store a crash left between create and commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agenda-version-empty-'));
    try {
      const directory = VERSIONS(root);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, `${SESSION}~A1.sqlite`), '');
      const store = new FileAgendaVersionStore(() => root);
      try {
        await store.record(SESSION, [draft(entryOf(raised.ledger), 'created', T(1))]);
        should((await store.list(SESSION, 'A1')).map(row => row.version)).deepEqual([1]);
      } finally {
        store.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
