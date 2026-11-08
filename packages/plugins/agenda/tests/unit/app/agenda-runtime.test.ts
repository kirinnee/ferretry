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

  it('marks an opened ask seen, and does not mind when the mark does not land', async () => {
    const { client, calls } = build();
    const runtime = createAgendaRuntime(client);
    await runtime.itemOpened('f1', 'A1');
    expect(calls.map(call => call.route)).toContain('POST /v1/push/seen');
    runtime.ferrets.stop();
  });
});
