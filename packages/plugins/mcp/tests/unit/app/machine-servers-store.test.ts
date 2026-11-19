/** The machine's MCP inventory, read once for every row that asks, and forgotten when the last row goes. */
import { describe, expect, it } from 'bun:test';
import { interact } from '@ferretry/app/testing';
import { createElement } from 'react';
import {
  createMachineServersStore,
  machineServersStore,
  useMachineServers,
} from '../../../app/lib/machine-servers-store.ts';
import { type Call, MCP, scriptedClient } from './mcp-fixtures.ts';
import { mountSettled } from './mcp-view-support.tsx';

const ROUTE = 'GET /v1/mcp';
const tick = async (): Promise<void> => {
  for (let turn = 0; turn < 5; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
};

describe('the machine servers store', () => {
  it('sends a Try again (press) as the person’s own read, and the page’s own reads unmarked', async () => {
    const inits: unknown[] = [];
    let fail = true;
    const store = createMachineServersStore({
      call: async (_route: string, init?: unknown) => {
        inits.push(init);
        if (fail) throw new Error('the machine is offline');
        return MCP;
      },
    } as never);
    const stop = store.subscribe(() => undefined);
    await tick();
    fail = false;
    store.press();
    await tick();
    store.reload();
    await tick();
    expect(inits).toEqual([{}, { quiet: false }, {}]);
    stop();
  });

  it('reads ONE inventory for every row that subscribes, and tells each of them', async () => {
    const calls: Call[] = [];
    const store = createMachineServersStore(scriptedClient({ [ROUTE]: MCP }, calls));
    const told: string[] = [];
    const first = store.subscribe(() => told.push('first'));
    const second = store.subscribe(() => told.push('second'));
    expect(store.snapshot()).toEqual({ kind: 'loading' });
    await tick();
    expect(calls.filter(call => call.route === ROUTE)).toHaveLength(1);
    expect(store.snapshot()).toEqual({ kind: 'ready', inventory: MCP });
    expect(told).toEqual(['first', 'second']);
    first();
    second();
  });

  it('says why a read failed, and goes back to reading when told to read again', async () => {
    let fail = true;
    const calls: Call[] = [];
    const store = createMachineServersStore(
      scriptedClient(
        {
          [ROUTE]: () => {
            if (fail) throw new Error('the machine is offline');
            return MCP;
          },
        },
        calls,
      ),
    );
    const stop = store.subscribe(() => undefined);
    await tick();
    expect(store.snapshot().kind).toBe('failed');
    fail = false;
    store.reload();
    expect(store.snapshot()).toEqual({ kind: 'loading' });
    await tick();
    expect(store.snapshot().kind).toBe('ready');
    expect(calls).toHaveLength(2);
    stop();
  });

  it('keeps the rows on screen while a good read is read again', async () => {
    const store = createMachineServersStore(scriptedClient({ [ROUTE]: MCP }));
    const stop = store.subscribe(() => undefined);
    await tick();
    store.reload();
    expect(store.snapshot().kind).toBe('ready');
    await tick();
    expect(store.snapshot().kind).toBe('ready');
    stop();
  });

  it('forgets what it read when its last row goes, so the next library reads the machine as it is then', async () => {
    const calls: Call[] = [];
    const store = createMachineServersStore(scriptedClient({ [ROUTE]: MCP }, calls));
    const stay = store.subscribe(() => undefined);
    const leave = store.subscribe(() => undefined);
    await tick();
    leave();
    expect(store.snapshot().kind).toBe('ready');
    stay();
    expect(store.snapshot()).toEqual({ kind: 'loading' });
    const again = store.subscribe(() => undefined);
    await tick();
    expect(calls).toHaveLength(2);
    again();
  });

  it('tells nobody of a read that finishes after the last row left, or after a newer read began', async () => {
    const answers: ((value: unknown) => void)[] = [];
    const client = scriptedClient({ [ROUTE]: () => new Promise(resolve => answers.push(resolve)) });
    const store = createMachineServersStore(client);
    const told: string[] = [];
    const leave = store.subscribe(() => told.push('late'));
    leave();
    answers[0]?.(MCP);
    await tick();
    expect(told).toEqual([]);
    expect(store.snapshot()).toEqual({ kind: 'loading' });

    const stay = store.subscribe(() => told.push('now'));
    store.reload();
    expect(answers).toHaveLength(3);
    answers[2]?.(MCP);
    await tick();
    answers[1]?.({ problems: [], servers: [] });
    await tick();
    expect(store.snapshot()).toEqual({ kind: 'ready', inventory: MCP });
    expect(told).toEqual(['now']);
    stay();
  });

  it('does not read on a reload nobody is waiting for', async () => {
    const calls: Call[] = [];
    const store = createMachineServersStore(scriptedClient({ [ROUTE]: MCP }, calls));
    store.reload();
    await tick();
    expect(calls).toEqual([]);
  });

  it('serves a row through useMachineServers: reading first, then the inventory, and a reload reads again', async () => {
    const calls: Call[] = [];
    const client = scriptedClient({ [ROUTE]: MCP }, calls);
    const seen: string[] = [];
    let reload: () => void = () => undefined;
    const Probe = () => {
      const read = useMachineServers(client);
      reload = read.reload;
      seen.push(read.servers.kind);
      return null;
    };
    const view = await mountSettled(createElement(Probe));
    expect(seen[0]).toBe('loading');
    expect(seen.at(-1)).toBe('ready');
    await interact(async () => {
      reload();
      await tick();
    });
    expect(calls).toHaveLength(2);
    await view.unmount();
  });

  it('is one store per client, however many rows ask for it', () => {
    const client = scriptedClient({});
    expect(machineServersStore(client)).toBe(machineServersStore(client));
    expect(machineServersStore(scriptedClient({}))).not.toBe(machineServersStore(client));
  });
});
