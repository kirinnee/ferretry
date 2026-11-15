import { describe, expect, test } from 'bun:test';
import { MACHINE_AGENDA_ID } from '@ferretry/core-asks/contract';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { RouteAgendaGateway } from '../../../cli/lib/gateway.ts';
import { agentItem, SESSION, snapshot } from './fixtures.ts';

type Call = { route: string; init?: Parameters<PluginClient['call']>[1] };

const world = (answer: unknown, ownFerretId: string | undefined = undefined) => {
  const calls: Call[] = [];
  const client = {
    call: async (route: string, init?: Call['init']) => {
      calls.push({ route, ...(init === undefined ? {} : { init }) });
      return answer;
    },
  } as unknown as PluginClient;
  return { calls, gateway: new RouteAgendaGateway(client, ownFerretId) };
};

const item = agentItem('A1', 'Use the proposed wording?');
const board = snapshot([item]);

describe('RouteAgendaGateway speaks the agenda routes through the plugin client', () => {
  test('snapshot reads a ferret’s board from its own route and the machine’s from the machine route', async () => {
    const ferret = world({ ...board, resolved: [] });
    expect((await ferret.gateway.snapshot(SESSION)).sessionId).toBe(SESSION);
    expect(ferret.calls).toEqual([
      { route: 'GET /v1/ferrets/:ferretId/agenda', init: { params: { ferretId: SESSION } } },
    ]);

    const machine = world({ ...snapshot([], { sessionId: MACHINE_AGENDA_ID }), resolved: [] });
    await machine.gateway.snapshot(MACHINE_AGENDA_ID);
    expect(machine.calls.map(call => call.route)).toEqual(['GET /v1/machine/agenda']);
  });

  test('readItem returns the item asked for from either board', async () => {
    const ferret = world(item);
    expect((await ferret.gateway.readItem(SESSION, 'A1')).id).toBe('A1');
    expect(ferret.calls[0]).toEqual({
      route: 'GET /v1/ferrets/:ferretId/agenda/:id',
      init: { params: { ferretId: SESSION, id: 'A1' } },
    });

    const machine = world(item);
    await machine.gateway.readItem(MACHINE_AGENDA_ID, 'A1');
    expect(machine.calls[0]).toEqual({ route: 'GET /v1/machine/agenda/:id', init: { params: { id: 'A1' } } });
  });

  test('readItem refuses a daemon that answers with another item', async () => {
    const { gateway } = world(item);
    await expect(gateway.readItem(SESSION, 'A2')).rejects.toThrow('daemon returned another agenda item');
  });

  test('apply posts the checked request to the right board and returns the new snapshot', async () => {
    const request = { action: 'dismiss', id: 'A1' } as const;
    const ferret = world({ ...board, resolved: [] });
    expect((await ferret.gateway.apply(SESSION, request)).count).toBe(1);
    expect(ferret.calls[0]).toEqual({
      route: 'POST /v1/ferrets/:ferretId/agenda',
      init: { params: { ferretId: SESSION }, body: request },
    });

    const machine = world({ ...board, resolved: [] });
    await machine.gateway.apply(MACHINE_AGENDA_ID, request);
    expect(machine.calls[0]).toEqual({ route: 'POST /v1/machine/agenda', init: { body: request } });
  });

  test('apply refuses a request the contract does not know, before anything is sent', async () => {
    const { gateway, calls } = world({});
    await expect(gateway.apply(SESSION, { action: 'nonsense' } as never)).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  test('sendReplies sends a ferret’s held replies, and the machine agenda has none to send', async () => {
    const ferret = world({ ...board, resolved: [] });
    await ferret.gateway.sendReplies(SESSION);
    expect(ferret.calls[0]).toEqual({
      route: 'POST /v1/ferrets/:ferretId/agenda/replies',
      init: { params: { ferretId: SESSION }, body: {} },
    });

    const machine = world({});
    await expect(machine.gateway.sendReplies(MACHINE_AGENDA_ID)).rejects.toThrow(
      'the machine agenda has no held replies to send',
    );
    expect(machine.calls).toEqual([]);
  });

  test('a ferret never touches the machine agenda: it is the owner’s', async () => {
    const { gateway, calls } = world({}, SESSION);
    const owners = "the machine agenda is the owner's; ask them";
    await expect(gateway.snapshot(MACHINE_AGENDA_ID)).rejects.toThrow(owners);
    await expect(gateway.readItem(MACHINE_AGENDA_ID, 'A1')).rejects.toThrow(owners);
    await expect(gateway.apply(MACHINE_AGENDA_ID, { action: 'dismiss', id: 'A1' })).rejects.toThrow(owners);
    await expect(gateway.sendReplies(MACHINE_AGENDA_ID)).rejects.toThrow(owners);
    expect(calls).toEqual([]);
  });
});
