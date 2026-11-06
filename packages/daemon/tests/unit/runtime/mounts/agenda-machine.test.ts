import { describe, it } from 'bun:test';
import { MACHINE_AGENDA_ID } from '@ferretry/protocol';
import should from 'should';
import { NO_GOVERNED_ROUTES_GUARD } from '../../../../src/lib/api/capability.ts';
import { ApiDispatcher, ApiRouter } from '../../../../src/lib/api/index.ts';
import {
  type AgendaLedger,
  type AgendaLedgerRepository,
  type AgendaMutation,
  AgendaService,
} from '../../../../src/lib/agenda/index.ts';
import { agendaMachineRoutes } from '../../../../src/lib/runtime/mounts/agenda-machine.ts';
import { jsonBody, request } from '../../api/support.ts';
import { agentIn, CREDENTIALS, human } from './support.ts';

const NOW = '2026-07-31T10:00:00Z';

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

async function fixture(options: { readonly broken?: boolean; readonly long?: boolean } = {}) {
  const repository = new MemoryRepository();
  const service = new AgendaService(
    options.broken === true
      ? {
          read: async () => {
            throw new Error('unreadable');
          },
          transact: async () => ({ ok: false, error: { code: 'corrupt', message: 'unreadable' } }),
        }
      : repository,
    { now: () => NOW },
    { has: async id => id === MACHINE_AGENDA_ID },
    { raised: async () => undefined },
  );
  const raised = await service.raise(
    MACHINE_AGENDA_ID,
    {
      source: 'agent-raised',
      sourceRef: 'warden:orphans',
      subject: '2 cards',
      why: 'Because.',
      premise: 'A premise.',
      context: 'Context.',
      howToResolve: 'Do it.',
      waitingSince: NOW,
      notice: true,
      kind: 'info',
      ...(options.long === true ? { body: 'b'.repeat(50_000), whereWeAre: 'Halfway there.' } : {}),
    },
    { kind: 'daemon', cause: 'system' },
  );
  const id = raised.ok ? (raised.item?.id ?? '') : '';
  const dispatcher = new ApiDispatcher(
    new ApiRouter([...agendaMachineRoutes(service)]),
    CREDENTIALS,
    NO_GOVERNED_ROUTES_GUARD,
  );
  const get = async (headers: Readonly<Record<string, string>> = human) =>
    await dispatcher.dispatch(request({ method: 'GET', path: '/v1/machine/agenda', headers }));
  const post = async (body: unknown, headers: Readonly<Record<string, string>> = human) =>
    await dispatcher.dispatch(
      request({ method: 'POST', path: '/v1/machine/agenda', headers, body: JSON.stringify(body) }),
    );
  return { id, get, post };
}

describe('the machine agenda routes', () => {
  it('should list the machine items for the owner', async () => {
    const { get } = await fixture();
    const response = await get();
    should(response.status).equal(200);
    should((jsonBody(response) as { items: unknown[] }).items).have.length(1);
  });

  it('should refuse a ferret on both routes', async () => {
    const { get, post, id } = await fixture();
    should((await get(agentIn('s1'))).status).equal(403);
    should((await post({ action: 'dismiss', id }, agentIn('s1'))).status).equal(403);
  });

  it('should let the owner dismiss, and refuse the verbs that are not theirs', async () => {
    const { post, id, get } = await fixture();
    should((await post({ action: 'progress', id, note: 'x' })).status).equal(400);
    should((await post({ action: 'edit', id, subject: 'x' })).status).equal(400);
    should((await post({ action: 'resolve', id, response: { kind: 'text', text: 'x' } })).status).equal(400);
    should((await post({ action: 'dismiss', id })).status).equal(200);
    should((jsonBody(await get()) as { items: unknown[] }).items).have.length(0);
  });

  it('should resolve, and map an unknown item to 404', async () => {
    const { post, id } = await fixture();
    should((await post({ action: 'resolve', id })).status).equal(200);
    should((await post({ action: 'dismiss', id: 'A99' })).status).equal(404);
  });

  it('should refuse snooze on a notice with the agenda’s own reason, and accept unsnooze as a no-op error', async () => {
    const { post, id } = await fixture();
    should((await post({ action: 'snooze', id, until: '2026-08-01T10:00:00Z' })).status).equal(400);
    should([200, 400, 409]).containEql((await post({ action: 'unsnooze', id })).status);
  });

  it('should answer with the agenda’s own error when the ledger cannot be read', async () => {
    const { get, post } = await fixture({ broken: true });
    should((await get()).status).equal(500);
    should((await post({ action: 'dismiss', id: 'A1' })).status).equal(500);
  });
});

describe('the machine agenda item shape', () => {
  type Served = { items: { body?: string; whereWeAre?: string }[] };

  it('should serve the whole item', async () => {
    // Arrange
    const { get } = await fixture({ long: true });

    // Act
    const response = await get();

    // Assert
    const [item] = (jsonBody(response) as Served).items;
    should(item?.body).have.length(50_000);
    should(item?.whereWeAre).equal('Halfway there.');
  });
});
