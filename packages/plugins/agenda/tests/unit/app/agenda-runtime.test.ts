import { describe, expect, it } from 'bun:test';
import { AsksChanged } from '@ferretry/core-asks/contract';
import { FerretsChanged } from '@ferretry/core-ferrets/contract';
import { createAgendaRuntime } from '../../../app/lib/agenda-runtime.ts';
import { callFromFetch } from '../../support/app/call-from-fetch.ts';

type Handler = (payload: unknown) => void;

/** A client that answers every call with a refusal and records the events the runtime listens to. */
const build = () => {
  const urls: string[] = [];
  const base = callFromFetch(async input => {
    urls.push(String(input));
    return new Response('{}', { status: 404 });
  });
  const handlers = new Map<unknown, Handler>();
  const client = {
    ...base,
    subscribe: ((event: unknown, handler: Handler) => {
      handlers.set(event, handler);
      return () => undefined;
    }) as never,
  };
  return { client, handlers, urls, calls: base.calls };
};

const settle = async (): Promise<void> => {
  for (let spin = 0; spin < 5; spin += 1) await new Promise(resolve => setTimeout(resolve, 0));
};

describe('createAgendaRuntime', () => {
  it('re-reads when Asks or Ferrets say something changed', async () => {
    const { client, handlers, urls } = build();
    const runtime = createAgendaRuntime(client);
    expect([...handlers.keys()]).toEqual([AsksChanged, FerretsChanged]);

    handlers.get(AsksChanged)?.({ ferret: 'machine-agenda' });
    handlers.get(FerretsChanged)?.({});
    await settle();
    expect(urls.some(url => url.endsWith('/v1/machine/agenda'))).toBe(true);
    expect(urls.some(url => url.endsWith('/v1/agenda/open'))).toBe(true);
    expect(urls.some(url => url.endsWith('/v1/ferrets'))).toBe(true);
    runtime.ferrets.stop();
  });

  it('disposes: its transport events are released and its ferret reads stop; a client with no events has nothing to release', async () => {
    const released: unknown[] = [];
    const { client: base } = build();
    const client = {
      ...base,
      subscribe: ((event: unknown) => {
        released.push(event);
        return () => {
          released.splice(released.indexOf(event), 1);
        };
      }) as never,
    };
    const runtime = createAgendaRuntime(client);
    expect(released).toEqual([AsksChanged, FerretsChanged]);
    runtime.dispose();
    expect(released).toEqual([]);
    runtime.dispose();
    await expect(runtime.ferrets.refresh()).rejects.toThrow('List refresh was cleared');

    const quiet = createAgendaRuntime({ call: build().client.call });
    quiet.dispose();
  });

  it('posts no seen mark of its own: opening an ask is told to the `agenda.item-opened` hook (use-item-opened)', async () => {
    const { client, calls } = build();
    const runtime = createAgendaRuntime(client);
    expect('itemOpened' in runtime).toBe(false);
    // The clear port reaches this machine's own client and no other.
    expect(runtime.clearPort.clientFor({ daemonId: runtime.connection.daemonId } as never)).toBe(client);
    expect(runtime.clearPort.clientFor({ daemonId: 'elsewhere' } as never)).toBeUndefined();
    await settle();
    expect(calls.map(call => call.route)).not.toContain('POST /v1/push/seen');
    runtime.ferrets.stop();
  });
});
