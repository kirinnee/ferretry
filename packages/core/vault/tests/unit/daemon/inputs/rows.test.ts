import { createHash } from 'node:crypto';
import { describe, it } from 'bun:test';
import type { CallerGovernance } from '@ferretry/core-gate/contract';
import { deviceStanding, ferretStanding } from '@ferretry/core-gate/contract/testing';
import { ApiError, type ApiResponse, type CallContext, type FerretId } from '@ferretry/kernel/contract';
import should from 'should';
import { closeAck } from '../../../../contract/index.ts';
import { inputTools } from '../../../../daemon/lib/runtime/tools/input-wait.ts';
import { digestLine } from '../../../../daemon/lib/inputs/digest.ts';
import type { InputRequestService } from '../../../../daemon/lib/inputs/service.ts';
import { padInputValue } from '../../../../daemon/lib/inputs/wire.ts';
import { inputRequestRoutes } from '../../../../daemon/lib/runtime/mounts/inputs.ts';
import { inputRequestService, RAISE, SESSION } from './support.ts';

/** Rows the input routes and the digest enforce, said through the routes and the module themselves. */

const FERRET = 'ferret-1';
const REQUEST_ID = 'a'.repeat(32);
const DIGEST = 'b'.repeat(64);

/** A device whose grants allow everything but the `secrets` axes named in `refused`. */
function governance(refused: readonly ('use' | 'configure')[]): CallerGovernance {
  return {
    governed: true,
    decide: demand =>
      demand.capability === 'secrets' && refused.includes(demand.axis)
        ? { allowed: false, refusal: 'device-not-granted' }
        : { allowed: true, refusal: 'granted' },
  };
}

interface Calls {
  readonly reads: number[];
  readonly delivered: unknown[];
}

function callOf(standing: object, body: unknown, calls: Calls): CallContext {
  return {
    request: {
      method: 'POST',
      path: '/',
      query: new Map(),
      headers: new Map(),
      arrival: { kind: 'remote' },
      text: async () => {
        calls.reads.push(1);
        return JSON.stringify(body);
      },
    },
    params: new Map([
      ['ferretId', FERRET],
      ['requestId', REQUEST_ID],
    ]),
    ...standing,
  } as unknown as CallContext;
}

function serviceOf(calls: Calls): InputRequestService {
  return {
    list: async () => [{ id: REQUEST_ID, saved: { accounts: [{ id: 'EXAMPLE' }] } }],
    resealed: (request: unknown) => request,
    targetOf: () => ({ kind: 'terminal', key: 'dev' }),
    deliver: async (_ferret: string, id: string, body: unknown) => {
      calls.delivered.push(body);
      return { id, deliveryId: crypto.randomUUID(), state: 'delivered', submitted: true };
    },
  } as unknown as InputRequestService;
}

const fresh = (): Calls => ({ reads: [], delivered: [] });
const json = (response: ApiResponse): Record<string, unknown> => JSON.parse(response.body);
const DELIVER = 'POST /v1/ferrets/:ferretId/input-requests/:requestId/deliver';

describe('the input routes', () => {
  it('G89 should list a card without its saved accounts for a caller with no secrets.use, and with them otherwise', async () => {
    const calls = fresh();
    const routes = inputRequestRoutes(serviceOf(calls));
    const list = routes['GET /v1/ferrets/:ferretId/input-requests'];

    const without = json(await list(callOf({ ...deviceStanding('d1'), governance: governance(['use']) }, {}, calls)));
    const withNames = json(await list(callOf({ ...deviceStanding('d1'), governance: governance([]) }, {}, calls)));

    should(without).deepEqual({ requests: [{ id: REQUEST_ID }] });
    should(withNames).deepEqual({ requests: [{ id: REQUEST_ID, saved: { accounts: [{ id: 'EXAMPLE' }] } }] });
  });

  it('I43 should refuse typing a saved account without secrets.use and saving one without secrets.configure', async () => {
    const calls = fresh();
    const routes = inputRequestRoutes(serviceOf(calls));
    const typed = { deliveryId: crypto.randomUUID(), observedDigest: DIGEST, entry: 'EXAMPLE', submit: true };
    const saved = {
      deliveryId: crypto.randomUUID(),
      observedDigest: DIGEST,
      padded: padInputValue('hunter2-UNIQUE'),
      save: { entry: 'EXAMPLE', label: 'example' },
      submit: true,
    };

    const noUse = await routes[DELIVER](
      callOf({ ...deviceStanding('d1'), governance: governance(['use']) }, typed, calls),
    );
    const noConfigure = await routes[DELIVER](
      callOf({ ...deviceStanding('d1'), governance: governance(['configure']) }, saved, calls),
    );
    const allowed = await routes[DELIVER](
      callOf({ ...deviceStanding('d1'), governance: governance([]) }, typed, calls),
    );

    should(noUse.status).equal(403);
    should(json(noUse).code).equal('grant_device_not_granted');
    should(noConfigure.status).equal(403);
    should(noConfigure.body).not.containEql('hunter2-UNIQUE');
    should(allowed.status).equal(200);
    should(calls.delivered).have.length(1);
  });

  it('I44 should refuse a ferret at the route before its body is read', async () => {
    const calls = fresh();
    const routes = inputRequestRoutes(serviceOf(calls));
    const body = { deliveryId: crypto.randomUUID(), observedDigest: DIGEST, padded: padInputValue('x'), submit: true };

    const error = await routes[DELIVER](callOf(ferretStanding(FERRET as FerretId), body, calls)).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    should(error).be.instanceOf(ApiError);
    should((error as ApiError).status).equal(403);
    should(calls.reads).deepEqual([]);
    should(calls.delivered).deepEqual([]);
  });
});

describe('the digests a card carries', () => {
  it('I107 should digest a prompt line under a key held by this process, never as a plain sha-256', () => {
    const line = '[sudo] password for kirin:';

    should(digestLine(line)).equal(digestLine(line));
    should(digestLine(line)).not.equal(createHash('sha256').update(line).digest('hex'));
    should(digestLine(line)).match(/^[0-9a-f]{64}$/u);
  });
});

const HOST = { kind: 'owner', actor: { kind: 'host' }, carrier: 'loopback' } as const;

describe('the input_wait tool', () => {
  it('I17 should tell the ferret where its card stands and nothing the daemon observed, and refuse anyone else', async () => {
    const { service } = inputRequestService();
    const view = await service.raise(SESSION, RAISE);
    const [request] = await service.list(HOST);
    await service.cancel(SESSION, request?.id ?? '', HOST);
    const tools = inputTools(service);

    const answer = await tools.input_wait(callOf(ferretStanding(SESSION as FerretId), {}, fresh()), {
      id: `!${view.id}`,
      timeoutMs: 100,
    });
    const owner = await tools.input_wait(callOf(deviceStanding('d1'), {}, fresh()), { id: view.id });

    should(answer.isError).be.undefined();
    should(answer.text).startWith(`!${view.id} was cancelled`);
    should(answer.data).have.property('state', 'cancelled');
    should(answer.data).not.have.property('observed');
    should(owner.isError).be.true();
  });
});

describe('a write-only op’s answer', () => {
  it('should be a strict Ack and nothing else: no bit about a password field reaches the ferret', () => {
    const minted = {
      has: () => false,
      get: () => {
        throw new Error('no ids');
      },
    } as never;

    should(closeAck({ status: 'done', passwordField: true, typed: 'secret' }, minted)).deepEqual({ status: 'done' });
  });
});
