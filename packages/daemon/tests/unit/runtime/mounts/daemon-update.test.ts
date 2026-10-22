import { describe, it } from 'bun:test';
import {
  DAEMON_UPDATE_CODES,
  type DaemonUpdateStartRequest,
  type DaemonUpdateView,
  DaemonUpdateViewSchema,
} from '@ferretry/protocol';
import should from 'should';
import type { AuthenticatedCredential } from '../../../../src/lib/api/authentication.ts';
import type { CallerGovernance } from '../../../../src/lib/api/capability.ts';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiError } from '../../../../src/lib/api/error.ts';
import type { ApiResponse } from '../../../../src/lib/api/http.ts';
import type { RouteContext } from '../../../../src/lib/api/route.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { daemonUpdateRoutes } from '../../../../src/lib/runtime/mounts/daemon-update.ts';
import { DaemonUpdateRefusal, type DaemonUpdateSubsystem } from '../../../../src/lib/update/index.ts';
import { jsonBody, request } from '../../api/support.ts';
import { CREDENTIALS, GRANTED, human } from './support.ts';

const VIEW: DaemonUpdateView = {
  current: '4.28.0',
  method: { kind: 'homebrew', cask: 'ferretry' },
  plan: { kind: 'self', steps: [{ command: 'brew upgrade --cask ferretry' }], rollback: 'none' },
  check: {
    state: 'ok',
    checkedAt: '2026-10-18T09:00:00.000Z',
    latest: { version: '4.29.0', url: 'https://github.com/kirinnee/ferretry/releases/tag/v4.29.0' },
  },
  available: true,
  midTurn: 0,
  autoInstall: false,
  job: null,
};

class FakeUpdate implements DaemonUpdateSubsystem {
  readonly started: DaemonUpdateStartRequest[] = [];
  readonly settings: boolean[] = [];
  constructor(private readonly failure?: unknown) {}
  async view(): Promise<DaemonUpdateView> {
    return VIEW;
  }
  async start(request: DaemonUpdateStartRequest): Promise<DaemonUpdateView> {
    if (this.failure !== undefined) throw this.failure;
    this.started.push(request);
    return { ...VIEW, job: { state: 'running', target: request.target, startedAt: '2026-10-18T10:00:00.000Z' } };
  }
  async setAutoInstall(autoInstall: boolean): Promise<DaemonUpdateView> {
    this.settings.push(autoInstall);
    return { ...VIEW, autoInstall };
  }
  arm(): () => void {
    return () => undefined;
  }
  activityChanged(): void {}
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
  subsystem: DaemonUpdateSubsystem,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body: unknown,
  caller: Caller = HOST,
): Promise<Answer> {
  const found = new ApiRouter(daemonUpdateRoutes(subsystem)).lookup(method, path);
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

const START = { target: '4.29.0', when: 'now' } as const;

describe('the daemon update routes, over the real dispatcher', () => {
  const dispatcher = (subsystem: DaemonUpdateSubsystem = new FakeUpdate()) =>
    new ApiDispatcher(new ApiRouter(daemonUpdateRoutes(subsystem)), CREDENTIALS, GRANTED);

  it('answers the view uncached, in a shape the client parses', async () => {
    const response = await dispatcher().dispatch(request({ method: 'GET', path: '/v1/daemon/update', headers: human }));
    should(response.status).equal(200);
    should(response.headers.get('cache-control')).match(/no-store/u);
    should(() => DaemonUpdateViewSchema.parse(JSON.parse(response.body))).not.throw();
  });

  it('refuses a body the contract does not allow', async () => {
    const response = await dispatcher().dispatch(
      request({
        method: 'POST',
        path: '/v1/daemon/update',
        headers: human,
        body: JSON.stringify({ target: 'latest' }),
      }),
    );
    should(response.status).equal(400);
  });
});

describe('starting an update', () => {
  it('starts one for the owner at the machine, with no passkey', async () => {
    const subsystem = new FakeUpdate();
    const answer = await drive(subsystem, 'POST', '/v1/daemon/update', START);
    should(answer.status).equal(202);
    should(answer.body).containDeep({ job: { state: 'running', target: '4.29.0' } });
    should(subsystem.started).deepEqual([START]);
    should(answer.spent).equal(0);
  });

  it('asks a remote device for a passkey, and spends the one it gives', async () => {
    const subsystem = new FakeUpdate();
    const refused = await drive(subsystem, 'POST', '/v1/daemon/update', START, DEVICE);
    should(refused.status).equal(403);
    should(refused.body).containDeep({
      code: 'grant_step_up_required',
      demand: { capability: 'fleet', axis: 'configure' },
    });
    should(subsystem.started).deepEqual([]);
    const confirmed = await drive(subsystem, 'POST', '/v1/daemon/update', START, FRESH_DEVICE);
    should(confirmed.status).equal(202);
    should(confirmed.spent).equal(1);
  });

  it('never lets a ferret update the machine it runs on', async () => {
    const answer = await drive(new FakeUpdate(), 'POST', '/v1/daemon/update', START, AGENT);
    should(answer).containDeep({ status: 403, body: { code: 'forbidden' } });
  });

  it('answers every other refusal as a 409 with its code', async () => {
    for (const code of [
      DAEMON_UPDATE_CODES.inProgress,
      DAEMON_UPDATE_CODES.notAvailable,
      DAEMON_UPDATE_CODES.notSelfUpdatable,
      DAEMON_UPDATE_CODES.staleTarget,
    ]) {
      const answer = await drive(
        new FakeUpdate(new DaemonUpdateRefusal(code, 'no')),
        'POST',
        '/v1/daemon/update',
        START,
      );
      should(answer).containDeep({ status: 409, body: { code } });
    }
  });

  it('lets a genuine defect stay a defect', async () => {
    await drive(new FakeUpdate(new Error('boom')), 'POST', '/v1/daemon/update', START).then(
      () => should.fail(undefined, undefined, 'expected a throw'),
      (error: unknown) => should((error as Error).message).equal('boom'),
    );
  });
});

describe('the automatic-install setting', () => {
  const ON = { autoInstall: true };
  const OFF = { autoInstall: false };

  it('changes for the owner at the machine', async () => {
    const subsystem = new FakeUpdate();
    const answer = await drive(subsystem, 'PATCH', '/v1/daemon/update/settings', ON);
    should(answer).containDeep({ status: 200, body: { autoInstall: true }, spent: 0 });
    should(subsystem.settings).deepEqual([true]);
  });

  it('asks a remote device for a passkey to turn it ON, and never to turn it off', async () => {
    const subsystem = new FakeUpdate();
    should((await drive(subsystem, 'PATCH', '/v1/daemon/update/settings', ON, DEVICE)).status).equal(403);
    should(await drive(subsystem, 'PATCH', '/v1/daemon/update/settings', ON, FRESH_DEVICE)).containDeep({
      status: 200,
      spent: 1,
    });
    should(await drive(subsystem, 'PATCH', '/v1/daemon/update/settings', OFF, DEVICE)).containDeep({
      status: 200,
      spent: 0,
    });
    should(subsystem.settings).deepEqual([true, false]);
  });

  it('refuses a ferret in either direction', async () => {
    for (const body of [ON, OFF]) {
      should(await drive(new FakeUpdate(), 'PATCH', '/v1/daemon/update/settings', body, AGENT)).containDeep({
        status: 403,
        body: { code: 'forbidden' },
      });
    }
  });
});
