import { describe, it } from 'bun:test';
import { ApiError, type CallContext, decodeParameter } from '@ferretry/kernel/contract';
import should from 'should';
import { PinService } from '../../../../../daemon/lib/pins/index.ts';
import type { Pin, PinSnapshot } from '../../../../../daemon/lib/protocol/pins.ts';
import { PIN_SCHEMA_VERSION } from '../../../../../daemon/lib/protocol/pins.ts';
import { type PinCaller, pinActor, pinRoutes } from '../../../../../daemon/lib/runtime/mounts/pins.ts';
import { bodyOf, callOf, refusalOf } from '../../support/calls.ts';

const AT = '2026-07-31T00:00:00.000Z';
const IDS = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'] as const;
const human: PinCaller = { isAgent: false };
const agentIn = (ferret: string): PinCaller => ({ isAgent: true, ferret });

function fixture(options: { readonly instant?: string } = {}) {
  const boards = new Map<string, Pin[]>();
  let next = 0;
  const pins = new PinService(
    { has: async id => ['s1', 's2'].includes(id) },
    {
      snapshot: async id => ({ v: 1, sessionId: id, pins: boards.get(id) ?? [], updatedAt: AT }) as PinSnapshot,
      mutate: async (id, transform) => {
        boards.set(id, [...transform(boards.get(id) ?? [])]);
        return { v: 1, sessionId: id, pins: boards.get(id) ?? [], updatedAt: AT } as PinSnapshot;
      },
    },
    { now: () => options.instant ?? AT },
    { next: () => IDS[next++] ?? 'spent' },
  );
  const callers = new WeakMap<CallContext, PinCaller>();
  const routes = pinRoutes({
    pins,
    ferretOf: async call => {
      const decoded = decodeParameter(call.params.get('ferretId') ?? '');
      if (decoded === undefined)
        throw new ApiError(400, 'the ferret id in the path is not usable', 'invalid_session_id');
      return decoded;
    },
    callerOf: call => callers.get(call) ?? human,
  });
  const call = (ferret: string, body?: unknown, caller: PinCaller = human): CallContext => {
    const made = callOf({ ferretId: ferret }, body);
    callers.set(made, caller);
    return made;
  };
  return { routes, call };
}

describe('pinActor', () => {
  it('should take an agent from its own credential, and a person as nobody', () => {
    should(pinActor(agentIn('s1'))).deepEqual({ sessionId: 's1' });
    should(pinActor(human)).deepEqual({});
  });

  it('should refuse an agent with no ferret to name rather than take it for a person', () => {
    // A bare warden is an agent; it must never edit the owner's pins as "human".
    should(() => pinActor({ isAgent: true })).throw(/an agent pins only from its own session/u);
  });
});

describe('pin routes', () => {
  it("should list a ferret's board for the human", async () => {
    const { routes, call } = fixture();
    const response = await routes.list(call('s1'));
    should(response.status).equal(200);
    should(bodyOf(response)).deepEqual({ v: PIN_SCHEMA_VERSION, sessionId: 's1', pins: [], updatedAt: AT });
  });

  it('should refuse a path ferret id that decodes to a traversal step', async () => {
    const { routes, call } = fixture();
    should(await refusalOf(routes.list(call('%2e%2e')))).deepEqual({ status: 400, code: 'invalid_session_id' });
  });

  it('should report an unknown ferret as not found, and a malformed id as a client error', async () => {
    const { routes, call } = fixture();
    should(await refusalOf(routes.list(call('nope')))).deepEqual({ status: 404, code: 'not-found' });
    should(await refusalOf(routes.list(call('S1')))).deepEqual({ status: 400, code: 'invalid' });
  });

  it('should add a note pin attributed to the human', async () => {
    const { routes, call } = fixture();
    const response = await routes.apply(call('s1', { action: 'add', kind: 'note', text: 'ship the gate' }));
    should(bodyOf(response).pins).deepEqual([
      {
        id: IDS[0],
        at: Date.parse(AT),
        kind: 'note',
        text: 'ship the gate',
        by: 'human',
        createdBy: null,
        createdByName: null,
      },
    ]);
  });

  it('should add a message pin attributed to the agent that sent it', async () => {
    const { routes, call } = fixture();
    const response = await routes.apply(
      call(
        's1',
        { action: 'add', kind: 'message', blockId: 'b1', blockKind: 'assistant', preview: '  the   plan  ' },
        agentIn('s1'),
      ),
    );
    should(bodyOf(response).pins).deepEqual([
      {
        id: IDS[0],
        at: Date.parse(AT),
        kind: 'message',
        blockId: 'b1',
        blockKind: 'assistant',
        // Whitespace is flattened by the domain, so a preview cannot smuggle layout into a client.
        preview: 'the plan',
        by: 'agent',
        createdBy: 's1',
        createdByName: null,
      },
    ]);
  });

  it('should let the human edit a note the agent created, and remove a pin', async () => {
    const { routes, call } = fixture();
    await routes.apply(call('s1', { action: 'add', kind: 'note', text: 'first' }, agentIn('s1')));
    const edited = await routes.apply(call('s1', { action: 'edit', id: IDS[0], text: 'second' }));
    should((bodyOf(edited).pins as readonly { text: string }[])[0]?.text).equal('second');
    const removed = await routes.apply(call('s1', { action: 'remove', id: IDS[0] }));
    should(bodyOf(removed).pins).be.empty();
  });

  it('should refuse an agent pinning to a ferret that is not its own, or editing a pin it did not create', async () => {
    const { routes, call } = fixture();
    should(
      await refusalOf(routes.apply(call('s1', { action: 'add', kind: 'note', text: 'not mine' }, agentIn('s2')))),
    ).deepEqual({ status: 403, code: 'forbidden' });
    await routes.apply(call('s1', { action: 'add', kind: 'note', text: 'the human wrote this' }));
    should(
      await refusalOf(routes.apply(call('s1', { action: 'edit', id: IDS[0], text: 'hijacked' }, agentIn('s1')))),
    ).deepEqual({ status: 403, code: 'forbidden' });
  });

  it('should refuse a body the schema rejects, and a body that is not JSON', async () => {
    const { routes, call } = fixture();
    should(await refusalOf(routes.apply(call('s1', { action: 'add', kind: 'note', text: '' })))).deepEqual({
      status: 400,
      code: 'invalid_request',
    });
    should(await refusalOf(routes.apply(call('s1', '{not json')))).deepEqual({ status: 400, code: 'invalid_json' });
  });

  it('should surface a genuine daemon fault as itself, not as a client error', async () => {
    // A clock that cannot produce an instant is a bug in the daemon; blaming the caller would send an operator
    // hunting through their own request for a fault that is not there.
    const { routes, call } = fixture({ instant: 'not-an-instant' });
    const thrown = await routes.apply(call('s1', { action: 'add', kind: 'note', text: 'anything' })).catch(e => e);
    should(thrown).be.instanceOf(Error);
    should(thrown).not.be.instanceOf(ApiError);
  });
});
