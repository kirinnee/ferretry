import { describe, it } from 'bun:test';
import type { CallerGovernance } from '@ferretry/core-gate/contract';
import { deviceStanding, ownerStanding } from '@ferretry/core-gate/contract/testing';
import type { ApiResponse, CallContext } from '@ferretry/kernel/contract';
import should from 'should';
import { InputRequestError } from '../../../../../daemon/lib/inputs/errors.ts';
import type { InputRequestService } from '../../../../../daemon/lib/inputs/service.ts';
import { padInputValue } from '../../../../../daemon/lib/inputs/wire.ts';
import { inputRequestRoutes } from '../../../../../daemon/lib/runtime/mounts/inputs.ts';

const FERRET = 'ferret-1';
const REQUEST_ID = 'a'.repeat(32);
const DIGEST = 'b'.repeat(64);
const LIST = 'GET /v1/input-requests';
const SHOT = 'GET /v1/ferrets/:ferretId/input-requests/:requestId/shot';
const DELIVER = 'POST /v1/ferrets/:ferretId/input-requests/:requestId/deliver';
const QUARANTINES = 'GET /v1/ferrets/:ferretId/input-quarantines';
const END = 'POST /v1/ferrets/:ferretId/input-quarantines/:key/end';
const CANCEL = 'POST /v1/ferrets/:ferretId/input-requests/:requestId/cancel';

type Params = Record<string, string>;

function callOf(standing: object, body: string | object | undefined, params: Params = {}): CallContext {
  return {
    request: {
      method: 'POST',
      path: '/',
      query: new Map(),
      headers: new Map(),
      arrival: { kind: 'remote' },
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body ?? {})),
    },
    params: new Map(Object.entries({ ferretId: FERRET, requestId: REQUEST_ID, ...params })),
    ...standing,
  } as unknown as CallContext;
}

const json = (response: ApiResponse): Record<string, unknown> => JSON.parse(response.body);
const refusal = async (work: Promise<ApiResponse>) =>
  await work.then(
    () => undefined,
    (error: unknown) => error as { status: number; code?: string; message: string },
  );

interface Spent {
  fresh: number;
}

function serviceOf(over: Record<string, unknown> = {}): {
  service: InputRequestService;
  seen: Record<string, unknown[][]>;
} {
  const seen: Record<string, unknown[][]> = { list: [], deliver: [], cancel: [], end: [], quarantines: [], shot: [] };
  const service = {
    list: async (caller: unknown, ferret: unknown) => {
      seen.list?.push([caller, ferret]);
      return [{ id: REQUEST_ID }];
    },
    resealed: (request: unknown) => request,
    targetOf: () => ({ kind: 'terminal', key: 'dev' }),
    shot: (caller: unknown, ferret: string, id: string) => {
      seen.shot?.push([caller, ferret, id]);
      return { mime: 'image/png', base64: 'AA==' };
    },
    deliver: async (ferret: string, id: string, body: unknown, caller: unknown) => {
      seen.deliver?.push([ferret, id, body, caller]);
      return { id, deliveryId: crypto.randomUUID(), state: 'delivered', submitted: true };
    },
    quarantines: (caller: unknown, ferret: string) => {
      seen.quarantines?.push([caller, ferret]);
      return [];
    },
    endQuarantine: async (caller: unknown, ferret: string, key: string) => void seen.end?.push([caller, ferret, key]),
    cancel: async (ferret: string, id: string, caller: unknown) => {
      seen.cancel?.push([ferret, id, caller]);
      return { id, state: 'cancelled' };
    },
    ...over,
  } as unknown as InputRequestService;
  return { service, seen };
}

const typed = { deliveryId: crypto.randomUUID(), observedDigest: DIGEST, padded: padInputValue('x'), submit: true };

/** A governed device that is allowed everything, spending a fresh step-up proof when a write asks to. */
function governedDevice(decide: CallerGovernance['decide'], spent: Spent) {
  return {
    ...deviceStanding('d1'),
    governance: { governed: true, decide } satisfies CallerGovernance,
    spendFreshStepUp: () => {
      spent.fresh += 1;
    },
  };
}

describe('the input routes: who is asking', () => {
  it('should hand the service the host for the admin token on this machine, and the device for a paired device', async () => {
    const { service, seen } = serviceOf();
    const routes = inputRequestRoutes(service);

    await routes[LIST](callOf(ownerStanding(), undefined));
    await routes[LIST](callOf(deviceStanding('d1'), undefined));

    should(seen.list).eql([
      [{ kind: 'owner', actor: { kind: 'host' }, carrier: 'loopback' }, undefined],
      [{ kind: 'owner', actor: { kind: 'device', deviceId: 'd1' }, carrier: 'direct' }, undefined],
    ]);
  });

  it('should list one ferret’s cards under its id, and re-seal the list again when the dispatcher sends it', async () => {
    const { service, seen } = serviceOf();
    const response = await inputRequestRoutes(service)['GET /v1/ferrets/:ferretId/input-requests'](
      callOf(ownerStanding(), undefined),
    );

    should(seen.list?.[0]?.[1]).equal(FERRET);
    should(json(response)).eql({ requests: [{ id: REQUEST_ID }] });
    should(JSON.parse((response as unknown as { late: () => ApiResponse }).late().body)).eql({
      requests: [{ id: REQUEST_ID }],
    });
  });

  it('should refuse a ferret id or request id in the path that is not usable, before the service is asked', async () => {
    const { service, seen } = serviceOf();
    const routes = inputRequestRoutes(service);
    const owner = ownerStanding();

    const badFerret = await refusal(routes[SHOT](callOf(owner, undefined, { ferretId: '../etc' })));
    const noFerret = await refusal(routes[SHOT](callOf(owner, undefined, { ferretId: '' })));
    const badRequest = await refusal(routes[SHOT](callOf(owner, undefined, { requestId: 'not-hex' })));

    should([badFerret?.status, badFerret?.code]).eql([400, 'bad_request']);
    should(noFerret?.status).equal(400);
    should([badRequest?.status, badRequest?.code]).eql([400, 'bad_request']);
    should(seen.shot).eql([]);
  });
});

describe('the input routes: what the service says', () => {
  it('should answer the picture of a request, and the service’s refusal as its HTTP status', async () => {
    const ok = inputRequestRoutes(serviceOf().service);
    const gone = inputRequestRoutes(
      serviceOf({
        shot: () => {
          throw new InputRequestError('gone', 'the picture is gone', 'shot_gone');
        },
      }).service,
    );
    const broken = new Error('a genuine bug');
    const bug = inputRequestRoutes(
      serviceOf({
        shot: () => {
          throw broken;
        },
      }).service,
    );

    should(json(await ok[SHOT](callOf(ownerStanding(), undefined)))).eql({ mime: 'image/png', base64: 'AA==' });
    const refused = await refusal(gone[SHOT](callOf(ownerStanding(), undefined)));
    should([refused?.status, refused?.code, refused?.message]).eql([410, 'shot_gone', 'the picture is gone']);
    should(await refusal(bug[SHOT](callOf(ownerStanding(), undefined)))).equal(broken);
  });

  it('should map every service refusal code to its status, falling back to the code as the reason', async () => {
    const statuses: [InputRequestError['code'], number][] = [
      ['bad_request', 400],
      ['not_found', 404],
      ['conflict', 409],
      ['forbidden', 403],
      ['capacity', 429],
      ['unavailable', 503],
      ['gone', 410],
    ];
    for (const [code, status] of statuses) {
      const routes = inputRequestRoutes(
        serviceOf({
          cancel: async () => {
            throw new InputRequestError(code, 'refused');
          },
        }).service,
      );
      const error = await refusal(routes[CANCEL](callOf(ownerStanding(), {})));
      should([error?.status, error?.code]).eql([status, code]);
    }
  });

  it('should list and end the quarantines of a ferret for the owner, and cancel a card', async () => {
    const { service, seen } = serviceOf();
    const routes = inputRequestRoutes(service);

    should(json(await routes[QUARANTINES](callOf(ownerStanding(), undefined)))).eql({ quarantines: [] });
    should(json(await routes[END](callOf(ownerStanding(), undefined, { key: 'dev' })))).eql({ ended: true });
    should(json(await routes[CANCEL](callOf(ownerStanding(), {})))).eql({ id: REQUEST_ID, state: 'cancelled' });

    should(seen.end?.[0]?.slice(1)).eql([FERRET, 'dev']);
    should(seen.cancel?.[0]?.slice(0, 2)).eql([FERRET, REQUEST_ID]);
  });
});

describe('the input routes: reading a body', () => {
  it('should refuse a body that is not JSON, or does not fit its schema, without naming it', async () => {
    const routes = inputRequestRoutes(serviceOf().service);

    const notJson = await refusal(routes[DELIVER](callOf(ownerStanding(), '{ nope: hunter2-UNIQUE')));
    const wrongShape = await refusal(routes[DELIVER](callOf(ownerStanding(), { padded: 'hunter2-UNIQUE' })));
    const extra = await refusal(routes[CANCEL](callOf(ownerStanding(), { surprise: true })));

    should([notJson?.status, notJson?.code]).eql([400, 'bad_request']);
    should(notJson?.message).not.containEql('hunter2');
    should([wrongShape?.status, wrongShape?.code]).eql([400, 'bad_request']);
    should(wrongShape?.message).not.containEql('hunter2');
    should(extra?.status).equal(400);
  });

  it('should read an empty body as an empty object, so a cancel needs none', async () => {
    const routes = inputRequestRoutes(serviceOf().service);

    should(json(await routes[CANCEL](callOf(ownerStanding(), '  ')))).eql({ id: REQUEST_ID, state: 'cancelled' });
  });
});

describe('the input routes: a deliver that needs more than the route’s own permission', () => {
  const allow: CallerGovernance['decide'] = () => ({ allowed: true, refusal: 'granted' });

  it('I43 should refuse a paste into a page when the caller’s grants cannot be told, saying so', async () => {
    const { service, seen } = serviceOf({ targetOf: () => ({ kind: 'page', key: 'app' }) });
    // A device standing with no governance at all: an undetermined document fails closed.
    const response = await inputRequestRoutes(service)[DELIVER](callOf(deviceStanding('d1'), typed));

    should(response.status).equal(403);
    should(json(response).code).equal('forbidden');
    should(String(json(response).error)).containEql('allow a value into a page');
    should(seen.deliver).eql([]);
  });

  it('I43 should ask for a passkey confirmation when the browser grant needs a step-up, and say which demand', async () => {
    const spent = { fresh: 0 };
    const { service, seen } = serviceOf({ targetOf: () => ({ kind: 'page', key: 'app' }) });
    const standing = governedDevice(
      demand =>
        demand.capability === 'browser'
          ? { allowed: false, refusal: 'step-up-required' }
          : { allowed: true, refusal: 'granted' },
      spent,
    );

    const response = await inputRequestRoutes(service)[DELIVER](callOf(standing, typed));

    should(response.status).equal(403);
    should(json(response).code).equal('grant_step_up_required');
    should(json(response).demand).eql({ capability: 'browser', axis: 'use' });
    should(seen.deliver).eql([]);
  });

  it('I43 should refuse a paste into the secret store without secrets.configure, and spend nothing', async () => {
    const spent = { fresh: 0 };
    const { service, seen } = serviceOf({ targetOf: () => ({ kind: 'secret', key: 'TOKEN' }) });
    const standing = governedDevice(
      demand =>
        demand.capability === 'secrets' && demand.axis === 'configure'
          ? { allowed: false, refusal: 'device-not-granted' }
          : { allowed: true, refusal: 'granted' },
      spent,
    );

    const response = await inputRequestRoutes(service)[DELIVER](
      callOf(standing, { ...typed, sealed: true, padded: undefined }),
    );

    should(response.status).equal(403);
    should(json(response).code).equal('grant_device_not_granted');
    should(String(json(response).error)).containEql('allow a paste into the secret store');
    should(seen.deliver).eql([]);
    should(spent.fresh).equal(0);
  });

  it('I43 should spend the caller’s fresh proof once a paste into the secret store, or a saved value, was delivered', async () => {
    const stored = { fresh: 0 };
    const { service } = serviceOf({ targetOf: () => ({ kind: 'secret', key: 'TOKEN' }) });
    await inputRequestRoutes(service)[DELIVER](
      callOf(governedDevice(allow, stored), {
        deliveryId: typed.deliveryId,
        observedDigest: DIGEST,
        sealed: true,
        submit: false,
      }),
    );

    const kept = { fresh: 0 };
    await inputRequestRoutes(serviceOf().service)[DELIVER](
      callOf(governedDevice(allow, kept), { ...typed, save: { entry: 'EXAMPLE', label: 'example' } }),
    );

    const plain = { fresh: 0 };
    await inputRequestRoutes(serviceOf().service)[DELIVER](callOf(governedDevice(allow, plain), typed));

    should([stored.fresh, kept.fresh, plain.fresh]).eql([1, 1, 0]);
  });

  it('I43 should not spend a proof for an owner at the machine, who is not governed', async () => {
    let spent = 0;
    const standing = {
      ...ownerStanding(),
      spendFreshStepUp: () => {
        spent += 1;
      },
    };
    const { service } = serviceOf({ targetOf: () => ({ kind: 'secret', key: 'TOKEN' }) });

    await inputRequestRoutes(service)[DELIVER](
      callOf(standing, { deliveryId: typed.deliveryId, observedDigest: DIGEST, sealed: true, submit: false }),
    );

    should(spent).equal(0);
  });
});
