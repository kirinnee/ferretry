import { it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  FileAgendaLedgerRepository,
  InvalidAgendaLedgerError,
} from '../../src/adapters/agenda/file-agenda-ledger-repository.ts';
import { AGENDA_ARCHIVE_FILE } from '../../src/lib/agenda/archive.ts';
import { AGENDA_LEDGER_VERSION, applyAgendaCommandToSession } from '../../src/lib/agenda/state-machine.ts';

const SESSION = 'legacy-archive';
const AT = '2026-11-03T10:00:00.000Z';
const ACTOR = { kind: 'agent' as const, sessionId: SESSION, name: 'Ada' };
const WORDS = 'Keep the 雪 region exactly.';
const COMMITTED = `${JSON.stringify({ kind: 'owner-history', id: 'A1', entry: { at: AT, kind: 'replied', note: WORDS } })}\n`;

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'agenda-legacy-prefix-'));
  const directory = () => home;
  const repository = new FileAgendaLedgerRepository(directory);
  const raised = applyAgendaCommandToSession(null, SESSION, {
    action: 'raise',
    actor: ACTOR,
    at: AT,
    request: {
      source: 'agent-raised',
      sourceRef: null,
      subject: 'Which region?',
      why: 'The release waits.',
      premise: 'A release is ready.',
      context: 'The deploy needs a region.',
      howToResolve: 'Answer.',
      ask: { kind: 'open-question' },
    },
  });
  if (!raised.ok) throw new Error('invalid fixture');
  const legacy = {
    ...raised.ledger,
    version: 2,
    conversations: undefined,
    entries: raised.ledger.entries.map(entry => ({
      ...entry,
      item: { ...entry.item, conversation: undefined, conversationCount: undefined, conversationLastAt: undefined },
    })),
    archive: { bytes: Buffer.byteLength(COMMITTED), count: 1 },
  };
  await mkdir(home, { recursive: true });
  const ledger = repository.file(SESSION);
  const original = JSON.stringify(legacy);
  await writeFile(ledger, original);
  return { home, directory, repository, ledger, original, archive: join(home, AGENDA_ARCHIVE_FILE) };
}

/** The real migration IO boundary, shared by unit regressions and the daemon adapter coverage group. */
export function agendaLegacyArchiveContract() {
  it('migrates only the committed UTF-8 archive prefix, persists its words, and never rereads the archive after migration', async () => {
    const world = await fixture();
    try {
      await writeFile(world.archive, `${COMMITTED}{"uncommitted":"torn 雪`);
      const migrated = await world.repository.read(SESSION);
      should(migrated?.conversations?.A1?.map(entry => entry.text)).deepEqual([WORDS]);
      const changed = await world.repository.transact(SESSION, current =>
        applyAgendaCommandToSession(current, SESSION, {
          action: 'rest',
          actor: ACTOR,
          id: 'A1',
          why: 'I am checking the region.',
          at: AT,
        }),
      );
      should(changed.ok).be.true();
      should(JSON.parse(await readFile(world.ledger, 'utf8')).version).equal(AGENDA_LEDGER_VERSION);
      // A modern read must use the committed conversation, even with the old archive absent.
      await rm(world.archive);
      const reread = await new FileAgendaLedgerRepository(world.directory).read(SESSION);
      should(reread?.conversations?.A1?.filter(entry => entry.by === 'owner').map(entry => entry.text)).deepEqual([
        WORDS,
      ]);
    } finally {
      await rm(world.home, { recursive: true, force: true });
    }
  });

  it.each(['missing', 'short', 'malformed'] as const)(
    'refuses a %s committed legacy archive without replacing the ledger',
    async kind => {
      const world = await fixture();
      try {
        if (kind === 'short') await writeFile(world.archive, COMMITTED.slice(0, 10));
        if (kind === 'malformed') await writeFile(world.archive, 'x'.repeat(Buffer.byteLength(COMMITTED)));
        await should(world.repository.read(SESSION)).be.rejectedWith(InvalidAgendaLedgerError);
        should(await readFile(world.ledger, 'utf8')).equal(world.original);
      } finally {
        await rm(world.home, { recursive: true, force: true });
      }
    },
  );
}
