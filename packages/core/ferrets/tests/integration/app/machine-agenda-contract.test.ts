/**
 * THE MACHINE AGENDA'S TWO HALVES AGREE ON ITS ID. The daemon keys the ledger and the snapshot it serves by
 * `MACHINE_AGENDA_ID`; the app asks for that scope and refuses a snapshot that names another session. Each side's own
 * tests used a constant of their own and passed while the Machine group never rendered against a real daemon.
 * This drives the daemon's real route and service and reads the answer with the app's real client.
 */
import { describe, it } from 'bun:test';
import { MACHINE_AGENDA_ID, type SessionView } from '@ferretry/protocol';
import should from 'should';
import {
  type AgendaLedger,
  type AgendaLedgerRepository,
  type AgendaMutation,
  AgendaService,
  MachineAgenda,
  type MachineMembersStore,
} from '../../../daemon/src/lib/agenda/index.ts';
import { ApiDispatcher } from '../../../daemon/src/lib/api/dispatcher.ts';
import { NO_GOVERNED_ROUTES_GUARD } from '../../../daemon/src/lib/api/capability.ts';
import { ApiRouter } from '../../../daemon/src/lib/api/router.ts';
import { agendaMachineRoutes } from '../../../daemon/src/lib/runtime/mounts/agenda-machine.ts';
import { request } from '../../../daemon/tests/unit/api/support.ts';
import { CREDENTIALS, human } from '../../../daemon/tests/unit/runtime/mounts/support.ts';
import { DaemonAgendaStore } from '../../src/lib/agenda-store.ts';
import { DaemonAgendaClient, fetchAgendaSnapshot } from '../../src/lib/agenda-client.ts';
import { daemonConnection } from '../../../app/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../../app/lib/daemon-scope.ts';
import { machineSessionView, withMachineAgendas } from '../../src/lib/machine-agenda.ts';

const NOW = '2026-07-31T10:00:00Z';
const DAEMON = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example.test', deviceId: 'token' });

class MemoryRepository implements AgendaLedgerRepository {
  readonly ledgers = new Map<string, AgendaLedger>();
  async read(sessionId: string): Promise<AgendaLedger | null> {
    return this.ledgers.get(sessionId) ?? null;
  }
  async transact(sessionId: string, apply: (current: AgendaLedger | null) => AgendaMutation): Promise<AgendaMutation> {
    const mutation = apply(await this.read(sessionId));
    if (mutation.ok && mutation.changed) this.ledgers.set(sessionId, mutation.ledger);
    return mutation;
  }
}

class Members implements MachineMembersStore {
  value: Record<string, readonly string[]> = {};
  async read(): Promise<Readonly<Record<string, readonly string[]>>> {
    return this.value;
  }
  async write(members: Readonly<Record<string, readonly string[]>>): Promise<void> {
    this.value = { ...members };
  }
}

async function daemonWithAMachineNotice() {
  const service = new AgendaService(
    new MemoryRepository(),
    { now: () => NOW },
    { has: async id => id === MACHINE_AGENDA_ID },
    { raised: async () => undefined },
  );
  await new MachineAgenda(service, new Members(), { now: () => NOW }).raiseOrUpdate('budget:login:week:1', {
    subject: 'A login hit its hard limit',
    why: 'Because.',
    premise: 'A premise.',
    context: 'Context.',
    howToResolve: 'Wait for the reset.',
    waitingSince: NOW,
    notice: true,
    kind: 'info',
  });
  const dispatcher = new ApiDispatcher(
    new ApiRouter([...agendaMachineRoutes(service)]),
    CREDENTIALS,
    NO_GOVERNED_ROUTES_GUARD,
  );
  const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const served = await dispatcher.dispatch(
      request({ method: init?.method ?? 'GET', path: url.pathname, headers: human, body: init?.body as string }),
    );
    return new Response(served.body, { status: served.status });
  };
  return fetcher;
}

describe('the machine agenda, from the daemon route to the app', () => {
  it('reads the daemon’s real snapshot as the Machine conversation', async () => {
    // Arrange
    const fetcher = await daemonWithAMachineNotice();
    const scope = daemonSessionScope(DAEMON, MACHINE_AGENDA_ID);

    // Act
    const snapshot = await fetchAgendaSnapshot(DAEMON, scope, fetcher);
    const view = machineSessionView(snapshot);

    // Assert
    should(snapshot.sessionId).equal(MACHINE_AGENDA_ID);
    should(snapshot.items.map(item => item.subject)).deepEqual(['A login hit its hard limit']);
    should(view?.config.id).equal(MACHINE_AGENDA_ID);
  });

  it('lands in the Inbox’s store and lists the Machine group first', async () => {
    // Arrange
    const fetcher = await daemonWithAMachineNotice();
    const store = new DaemonAgendaStore();
    const client = new DaemonAgendaClient(store, fetcher);
    const scope = daemonSessionScope(DAEMON, MACHINE_AGENDA_ID);

    // Act
    await client.revalidate(DAEMON, scope);
    const machines = withMachineAgendas(
      [{ connection: DAEMON, sessions: [] as readonly SessionView[] }],
      (_daemon, sessionId) => store.agenda(daemonSessionScope(DAEMON, sessionId)),
    );

    // Assert
    should(machines[0]?.sessions?.map(view => view.config.id)).deepEqual([MACHINE_AGENDA_ID]);
  });

  it('lets the owner clear a machine item through the same client', async () => {
    // Arrange
    const fetcher = await daemonWithAMachineNotice();
    const scope = daemonSessionScope(DAEMON, MACHINE_AGENDA_ID);
    const client = new DaemonAgendaClient(new DaemonAgendaStore(), fetcher);
    const before = await fetchAgendaSnapshot(DAEMON, scope, fetcher);

    // Act
    await client.dismiss(DAEMON, scope, before.items[0]?.id ?? '');
    const after = await fetchAgendaSnapshot(DAEMON, scope, fetcher);

    // Assert
    should(after.items).have.length(0);
  });
});
