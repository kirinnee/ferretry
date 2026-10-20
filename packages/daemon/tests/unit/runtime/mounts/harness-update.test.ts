import { describe, it } from 'bun:test';
import {
  HARNESS_UPDATE_CODES,
  type HarnessUpdateStartRequest,
  type HarnessUpdateView,
  HarnessUpdateViewSchema,
} from '@ferretry/protocol';
import should from 'should';
import type { AuthenticatedCredential } from '../../../../src/lib/api/authentication.ts';
import type { CallerGovernance } from '../../../../src/lib/api/capability.ts';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiError } from '../../../../src/lib/api/error.ts';
import type { ApiResponse } from '../../../../src/lib/api/http.ts';
import type { RouteContext } from '../../../../src/lib/api/route.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { HarnessUpdateRefusal, type HarnessUpdateSubsystem } from '../../../../src/lib/harness-update/index.ts';
import { harnessUpdateRoutes } from '../../../../src/lib/runtime/mounts/harness-update.ts';
import { jsonBody, request } from '../../api/support.ts';
import { CREDENTIALS, GRANTED, human } from './support.ts';

const VIEW: HarnessUpdateView = { harnesses: [] };

class FakeHarnessUpdate implements HarnessUpdateSubsystem {
  readonly started: HarnessUpdateStartRequest[] = [];
  constructor(private readonly failure?: unknown) {}
  async view(): Promise<HarnessUpdateView> {
    return VIEW;
  }
  async start(request: HarnessUpdateStartRequest): Promise<HarnessUpdateView> {
    if (this.failure !== undefined) throw this.failure;
    this.started.push(request);
    return VIEW;
  }
}
interface Caller {
  readonly kind: 'host' | 'device' | 'agent';
  readonly governed: boolean;
  readonly fresh?: boolean;
}

const HOST: Caller = { kind: 'host', governed: false };
const DEVICE: Caller = { kind: 'device', governed: true };
const FRESH_DEVICE: Caller = { kind: 'device', governed: true, fresh: true };
const AGENT: Caller = { kind: 'agent', governed: false };

const CREDENTIAL: Record<Caller['kind'], AuthenticatedCredential> = {
  host: { kind: 'authenticated', tokenClass: 'admin' },
  device: { kind: 'authenticated', tokenClass: 'device', deviceId: 'd1' },
  agent: { kind: 'authenticated', tokenClass: 'admin' },
};
const ACTOR: Record<Caller['kind'], string> = { host: 'admin-cli', device: 'device:d1', agent: 'peer:s1' };

interface Answer {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly spent: number;
}

/** One route, driven as `caller` with a context it built; an `ApiError` read back as the dispatcher would. */
async function drive(
  subsystem: HarnessUpdateSubsystem,
  method: 'GET' | 'POST',
  path: string,
  body: unknown,
  caller: Caller = HOST,
): Promise<Answer> {
  const found = new ApiRouter(harnessUpdateRoutes(subsystem)).lookup(method, path);
  if (found.kind !== 'matched') throw new Error(`no route ${method} ${path}`);
  let spent = 0;
  const governance: CallerGovernance = {
    governed: caller.governed,
    decide: () => ({ allowed: true, refusal: 'granted' }),
  };
  const context: RouteContext = {
    request: request({
      method,
      path,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    params: found.params,
    actor: ACTOR[caller.kind],
    credential: CREDENTIAL[caller.kind],
    governance,
    presentation: {
      loopback: caller.kind !== 'device',
      adminToken: caller.kind !== 'device',
      actor: ACTOR[caller.kind],
      stepUp: caller.fresh === true,
      freshStepUp: caller.fresh === true,
    },
    spendFreshStepUp: () => {
      spent += 1;
    },
  };
  let response: ApiResponse;
  try {
    response = await found.route.handle(context);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { status: error.status, body: { error: error.message, code: error.code }, spent };
  }
  return { status: response.status, body: jsonBody(response) as Record<string, unknown>, spent };
}

const PATH = '/v1/harnesses/update';
const START = { harness: 'codex', target: '0.163.0', confirmUnverified: true } as const;

describe('the harness update routes, over the real dispatcher', () => {
  const dispatcher = (subsystem: HarnessUpdateSubsystem = new FakeHarnessUpdate()) =>
    new ApiDispatcher(new ApiRouter(harnessUpdateRoutes(subsystem)), CREDENTIALS, GRANTED);

  it('answers the view uncached, in a shape the client parses', async () => {
    const response = await dispatcher().dispatch(request({ method: 'GET', path: PATH, headers: human }));
    should(response.status).equal(200);
    should(response.headers.get('cache-control')).match(/no-store/u);
    should(() => HarnessUpdateViewSchema.parse(JSON.parse(response.body))).not.throw();
  });

  it('refuses a body the contract does not allow', async () => {
    const response = await dispatcher().dispatch(
      request({ method: 'POST', path: PATH, headers: human, body: JSON.stringify({ harness: 'gemini' }) }),
    );
    should(response.status).equal(400);
  });
});

describe('starting a harness update', () => {
  it('starts one for the owner at the machine, with no passkey', async () => {
    const subsystem = new FakeHarnessUpdate();
    const answer = await drive(subsystem, 'POST', PATH, START);
    should(answer).containDeep({ status: 202, spent: 0 });
    should(subsystem.started).deepEqual([START]);
  });

  it('asks a remote device for a passkey, and spends the one it gives', async () => {
    const subsystem = new FakeHarnessUpdate();
    const refused = await drive(subsystem, 'POST', PATH, START, DEVICE);
    should(refused.status).equal(403);
    should(refused.body).containDeep({
      code: 'grant_step_up_required',
      demand: { capability: 'fleet', axis: 'configure' },
    });
    should(subsystem.started).deepEqual([]);
    should(await drive(subsystem, 'POST', PATH, START, FRESH_DEVICE)).containDeep({ status: 202, spent: 1 });
  });

  it('never lets a ferret replace the program it runs as', async () => {
    should(await drive(new FakeHarnessUpdate(), 'POST', PATH, START, AGENT)).containDeep({
      status: 403,
      body: { code: 'forbidden' },
    });
  });

  it('answers an unverified target with both versions, so the app can ask', async () => {
    const subsystem = new FakeHarnessUpdate(
      new HarnessUpdateRefusal(HARNESS_UPDATE_CODES.unverified, 'not verified', {
        target: '0.163.0',
        verified: '0.145.0',
      }),
    );
    should(await drive(subsystem, 'POST', PATH, START)).deepEqual({
      status: 409,
      body: { error: 'not verified', code: 'harness_update_unverified', target: '0.163.0', verified: '0.145.0' },
      spent: 0,
    });
  });

  it('answers every other refusal as a 409 with its code', async () => {
    for (const code of [
      HARNESS_UPDATE_CODES.inProgress,
      HARNESS_UPDATE_CODES.notLocated,
      HARNESS_UPDATE_CODES.notSelfUpdatable,
      HARNESS_UPDATE_CODES.notTargetable,
      HARNESS_UPDATE_CODES.notAvailable,
    ])
      should(await drive(new FakeHarnessUpdate(new HarnessUpdateRefusal(code, 'no')), 'POST', PATH, START)).containDeep(
        {
          status: 409,
          body: { code },
        },
      );
  });

  it('lets a genuine defect stay a defect', async () => {
    await drive(new FakeHarnessUpdate(new Error('boom')), 'POST', PATH, START).then(
      () => should.fail(undefined, undefined, 'expected a throw'),
      (error: unknown) => should((error as Error).message).equal('boom'),
    );
  });
});
