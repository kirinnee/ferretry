import { describe, it } from 'bun:test';
import should from 'should';
import { MACHINE_AGENDA_ID } from '@ferretry/protocol';
import { AgendaCardLinks } from '../../../src/lib/board/index.ts';
import { card, MACHINE } from '../board/support.ts';
import {
  type AgendaLedger,
  type AgendaLedgerRepository,
  type AgendaMutation,
  AgendaService,
  type MachineAgendaPort,
  type RaiseAgendaRequest,
} from '../../../src/lib/agenda/index.ts';

const NOW = '2026-10-01T10:00:00.000Z';

class Ledgers implements AgendaLedgerRepository {
  readonly ledgers = new Map<string, AgendaLedger>();
  async read(sessionId: string): Promise<AgendaLedger | null> {
    return this.ledgers.get(sessionId) ?? null;
  }
  async transact(sessionId: string, apply: (current: AgendaLedger | null) => AgendaMutation): Promise<AgendaMutation> {
    const mutation = apply(this.ledgers.get(sessionId) ?? null);
    if (mutation.ok) this.ledgers.set(sessionId, mutation.ledger);
    return mutation;
  }
}

const request = (overrides: Partial<RaiseAgendaRequest> = {}): RaiseAgendaRequest => ({
  source: 'task',
  sourceRef: 'ref:1',
  subject: 'Something',
  why: 'Because.',
  howToResolve: 'Answer.',
  kind: 'info',
  ...overrides,
});

/** A directory that knows the sessions it is given, and throws for the ones whose documents are damaged. */
class Directory {
  readonly known = new Set<string>();
  readonly damaged = new Set<string>();
  readonly proved: string[] = [];
  async has(id: string): Promise<boolean> {
    this.proved.push(id);
    if (this.damaged.has(id)) throw new Error(`session ${id} has an unusable document`);
    return this.known.has(id);
  }
}

const build = (machine?: MachineAgendaPort) => {
  const ledgers = new Ledgers();
  const directory = new Directory();
  const service = new AgendaService(
    ledgers,
    { now: () => NOW },
    directory,
    { raised: async () => undefined },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    machine,
  );
  return { service, directory, ledgers };
};

/** A session whose ledger holds one open item. */
const withLedger = async (id: string) => {
  const built = build();
  built.directory.known.add(id);
  await built.service.raise(id, request(), { kind: 'daemon', cause: 'system' });
  built.directory.proved.length = 0;
  return built;
};

describe('AgendaService.openItemsOf', () => {
  it('should answer a session with no ledger as no items, without proving it in the directory', async () => {
    // Arrange
    const { service, directory } = build();

    // Act
    const read = await service.openItemsOf('ghost');

    // Assert
    should(read).deepEqual({ ok: true, value: [] });
    should(directory.proved).deepEqual([]);
  });

  it('should answer the items list answers for a session the directory knows', async () => {
    // Arrange
    const { service, directory } = await withLedger('kid');

    // Act
    const read = await service.openItemsOf('kid');
    const listed = await service.list('kid');

    // Assert
    should(listed.ok).equal(true);
    should(read.ok && read.value).have.length(1);
    should(read).deepEqual({ ok: true, value: listed.ok ? listed.value.items : [] });
    should(directory.proved).deepEqual(['kid', 'kid']);
  });

  it('should refuse a surviving ledger whose session the directory no longer has, as list does', async () => {
    // Arrange — config/state loss or an index removal left the ledger behind.
    const { service, directory } = await withLedger('ghost');
    directory.known.delete('ghost');

    // Act
    const read = await service.openItemsOf('ghost');
    const listed = await service.list('ghost');

    // Assert
    should(listed).match({ ok: false, error: { code: 'not-found' } });
    should(read).deepEqual(listed);
    should(directory.proved).deepEqual(['ghost', 'ghost']);
  });

  it('should refuse a surviving ledger whose session documents are damaged, as list does', async () => {
    // Arrange
    const { service, directory } = await withLedger('hurt');
    directory.damaged.add('hurt');

    // Act
    const read = await service.openItemsOf('hurt').then(
      () => 'answered',
      (error: Error) => error.message,
    );
    const listed = await service.list('hurt').then(
      () => 'answered',
      (error: Error) => error.message,
    );

    // Assert
    should(listed).equal('session hurt has an unusable document');
    should(read).equal(listed);
  });

  it('should refuse an id no session can have, and the reserved machine ledger', async () => {
    // Arrange
    const port: MachineAgendaPort = {
      raiseOrUpdate: async () => undefined,
      resolve: async () => undefined,
      list: async () => {
        throw new Error('the machine port is not read by a board read');
      },
    };
    const { service } = build(port);

    // Act
    const invalid = await service.openItemsOf('not valid!');
    const machine = await service.openItemsOf(MACHINE_AGENDA_ID);

    // Assert
    should(invalid).match({ ok: false, error: { code: 'invalid' } });
    should(machine).match({ ok: false, error: { code: 'not-found' } });
  });
});

describe('the board reading cards through AgendaService.openItemsOf', () => {
  /** The wiring bin/fyd.ts gives the board: an agenda that cannot be read costs its asks, never the board read. */
  const linksOver = (service: AgendaService) =>
    new AgendaCardLinks(
      {
        open: async sessionId => {
          const listed = await service.openItemsOf(sessionId);
          if (!listed.ok) throw new Error(listed.error.message);
          return listed.value;
        },
      },
      () => MACHINE,
      { warn: () => undefined },
    );
  const ASKING = request({ task: { id: 'F1' } });

  it('should show the ask of a card whose ferret the directory knows', async () => {
    // Arrange
    const { service, directory } = build();
    directory.known.add('ferret');
    await service.raise('ferret', ASKING, { kind: 'daemon', cause: 'system' });

    // Act
    const asks = await linksOver(service).asksFor([card({ id: 'F1', owner: 'ferret' })]);

    // Assert
    should(asks.get('F1')?.open).have.length(1);
  });

  it('should show no ask for a ledger that outlived its session, which the agenda list refuses', async () => {
    // Arrange — the ledger survived config/state loss; the directory no longer has the session.
    const { service, directory } = build();
    directory.known.add('ghost');
    await service.raise('ghost', ASKING, { kind: 'daemon', cause: 'system' });
    directory.known.delete('ghost');

    // Act
    const asks = await linksOver(service).asksFor([card({ id: 'F1', owner: 'ghost' })]);

    // Assert
    should(asks.get('F1')).equal(undefined);
  });

  it('should show no ask for a ledger whose session documents are damaged, and still answer the board', async () => {
    // Arrange
    const { service, directory } = build();
    directory.known.add('hurt');
    await service.raise('hurt', ASKING, { kind: 'daemon', cause: 'system' });
    directory.damaged.add('hurt');

    // Act
    const asks = await linksOver(service).asksFor([card({ id: 'F1', owner: 'hurt' })]);

    // Assert
    should(asks.get('F1')).equal(undefined);
  });
});
