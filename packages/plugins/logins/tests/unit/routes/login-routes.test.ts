import { describe, it } from 'bun:test';
import { ApiError, type ApiRequest } from '@ferretry/kernel/contract';
import should from 'should';
import { z } from 'zod';
import { FleetCredentialRefusal } from '../../../daemon/lib/credentials/credentials-service.ts';
import { HarnessLoginRefusal } from '../../../daemon/lib/harness-login/service.ts';
import { parseBody } from '../../../daemon/lib/routes/body.ts';
import { changeRoutes } from '../../../daemon/lib/routes/changes.ts';
import { type LoginsSubsystem, loginRoutes } from '../../../daemon/lib/routes/logins.ts';
import { type HarnessLoginSubsystem, signInRoutes } from '../../../daemon/lib/routes/sign-in.ts';
import { call } from '../../support/call-route.ts';
import { AT, flow, login, loginList } from '../cli/fakes.ts';

const bodyOf = (response: unknown): unknown => JSON.parse(String((response as { body: unknown }).body));

const rejection = async (work: Promise<unknown>): Promise<unknown> => await work.catch(caught => caught);

describe('parseBody — the schema is the boundary', () => {
  const Schema = z.strictObject({ code: z.string() });
  const requestOf = (text: () => Promise<string>): ApiRequest => ({ text }) as unknown as ApiRequest;

  it('should hand back what the schema accepts', async () => {
    should(
      await parseBody(
        requestOf(async () => '{"code":"a"}'),
        Schema,
      ),
    ).eql({ code: 'a' });
  });

  it('should say a body that cannot be read could not be read', async () => {
    const error = await rejection(
      parseBody(
        requestOf(async () => {
          throw new Error('too large');
        }),
        Schema,
      ),
    );
    should(error).be.instanceOf(ApiError);
    should(error).containDeep({ status: 400, code: 'unreadable_body' });
  });

  it('should say a body that is not JSON is not JSON, without echoing it', async () => {
    const error = await rejection(
      parseBody(
        requestOf(async () => 'PASTED-CODE{'),
        Schema,
      ),
    );
    should(error).containDeep({ status: 400, code: 'invalid_json', message: 'the request body is not valid JSON' });
  });

  it('should name the failing paths of an invalid body and never repeat a submitted value', async () => {
    const error = (await rejection(
      parseBody(
        requestOf(async () => '{"code":7,"extra":"PASTED-CODE"}'),
        Schema,
      ),
    )) as Error;
    should(error).containDeep({ status: 400, code: 'invalid_request' });
    should(error.message).startWith('the request body is invalid — ');
    should(error.message).containEql('code:');
    should(error.message).not.containEql('PASTED-CODE');
  });

  it('should name the body itself when the body as a whole is wrong', async () => {
    const error = (await rejection(
      parseBody(
        requestOf(async () => '"text"'),
        Schema,
      ),
    )) as Error;
    should(error.message).startWith('the request body is invalid — body: ');
  });
});

describe('loginRoutes', () => {
  const asked: string[] = [];
  const subsystem = (overrides: Partial<LoginsSubsystem> = {}): LoginsSubsystem => ({
    list: async () => loginList(login()),
    check: async id => {
      asked.push(`check ${id}`);
      return login({ id });
    },
    test: async (id, consent) => {
      asked.push(`test ${id} ${String(consent.allowInference)}`);
      return { loginId: id, ok: true, code: 'ok', message: 'Works.', spent: 'nothing', at: AT } as never;
    },
    presets: async () => ({ presets: [] }),
    ...overrides,
  });

  it('should list the logins and the presets through the contract', async () => {
    const routes = loginRoutes(subsystem());
    should(bodyOf(await call(routes, 'GET /v1/logins'))).match({ format: 1, machine: 'box' });
    should(bodyOf(await call(routes, 'GET /v1/logins/presets'))).eql({ presets: [] });
  });

  it('should check a login by the id in the path, and test it with the consent only when it is given', async () => {
    asked.length = 0;
    const routes = loginRoutes(subsystem());
    await call(routes, 'POST /v1/logins/:loginId/check', { path: '/v1/logins/claude-you/check', body: {} });
    await call(routes, 'POST /v1/logins/:loginId/test', { path: '/v1/logins/glm/test', body: {} });
    await call(routes, 'POST /v1/logins/:loginId/test', {
      path: '/v1/logins/glm/test',
      body: { allowInference: true },
    });
    should(asked).eql(['check claude-you', 'test glm false', 'test glm true']);
  });

  it('should refuse a field a client still sends to the empty check body', async () => {
    const error = await rejection(
      call(loginRoutes(subsystem()), 'POST /v1/logins/:loginId/check', {
        path: '/v1/logins/claude-you/check',
        body: { extra: 1 },
      }),
    );
    should(error).containDeep({ status: 400, code: 'invalid_request' });
  });

  it('should refuse a path whose login id is empty', async () => {
    const error = await rejection(
      call(loginRoutes(subsystem()), 'POST /v1/logins/:loginId/check', { path: '/v1/logins//check', body: {} }),
    );
    should(error).containDeep({ status: 400, code: 'bad_request' });
  });

  it('should answer an unknown login as 404 and every other refusal as 409, each with its code', async () => {
    const unknown = loginRoutes(
      subsystem({
        check: async () => {
          throw new FleetCredentialRefusal('fleet_credential_unknown', 'no such login');
        },
      }),
    );
    const unavailable = loginRoutes(
      subsystem({
        list: async () => {
          throw new FleetCredentialRefusal('fleet_credentials_unreadable', 'the logins cannot be read');
        },
      }),
    );
    should(
      await rejection(call(unknown, 'POST /v1/logins/:loginId/check', { path: '/v1/logins/x/check', body: {} })),
    ).containDeep({ status: 404, code: 'fleet_credential_unknown', message: 'no such login' });
    should(await rejection(call(unavailable, 'GET /v1/logins'))).containDeep({
      status: 409,
      code: 'fleet_credentials_unreadable',
    });
  });

  it('should let a failure that is not a refusal through as itself', async () => {
    const routes = loginRoutes(
      subsystem({
        list: async () => {
          throw new Error('the disk is gone');
        },
      }),
    );
    should(await rejection(call(routes, 'GET /v1/logins'))).have.property('message', 'the disk is gone');
  });
});

describe('signInRoutes', () => {
  const seen: string[] = [];
  const subsystem = (overrides: Partial<HarnessLoginSubsystem> = {}): HarnessLoginSubsystem => ({
    start: async request => {
      seen.push(`start ${request.loginId}`);
      return flow();
    },
    status: async id => {
      seen.push(`status ${id}`);
      return flow({ flowId: id });
    },
    submit: async (id, request) => {
      seen.push(`submit ${id} ${'code' in request ? 'code' : String(request.method)}`);
      return { outcome: 'accepted', flow: flow({ state: 'complete' }) };
    },
    cancel: async id => {
      seen.push(`cancel ${id}`);
      return flow({ flowId: id, state: 'failed', reason: 'stopped', remedy: 'again' });
    },
    ...overrides,
  });

  it('should start, read, submit to and cancel a sign-in by its flow id', async () => {
    seen.length = 0;
    const routes = signInRoutes(subsystem());
    await call(routes, 'POST /v1/logins/sign-in', { body: { loginId: 'claude-you' } });
    should(bodyOf(await call(routes, 'GET /v1/logins/sign-in/:flowId', { path: '/v1/logins/sign-in/f1' }))).match({
      flowId: 'f1',
    });
    should(
      bodyOf(
        await call(routes, 'POST /v1/logins/sign-in/:flowId', {
          path: '/v1/logins/sign-in/f1',
          body: { code: 'PASTED#state' },
        }),
      ),
    ).match({ outcome: 'accepted' });
    await call(routes, 'POST /v1/logins/sign-in/:flowId', {
      path: '/v1/logins/sign-in/f1',
      body: { method: 'link' },
    });
    should(bodyOf(await call(routes, 'DELETE /v1/logins/sign-in/:flowId', { path: '/v1/logins/sign-in/f1' }))).match({
      state: 'failed',
    });
    should(seen).eql(['start claude-you', 'status f1', 'submit f1 code', 'submit f1 link', 'cancel f1']);
  });

  it('should refuse a path whose flow id is empty', async () => {
    const error = await rejection(
      call(signInRoutes(subsystem()), 'GET /v1/logins/sign-in/:flowId', { path: '/v1/logins/sign-in/' }),
    );
    should(error).containDeep({ status: 400, code: 'bad_request' });
  });

  it('should answer a harness login refusal as 409 with its code, and let any other failure through as itself', async () => {
    const refusing = signInRoutes(
      subsystem({
        status: async () => {
          throw new HarnessLoginRefusal('fleet_login_unknown', 'no such sign-in');
        },
      }),
    );
    const failing = signInRoutes(
      subsystem({
        status: async () => {
          throw new Error('the child vanished');
        },
      }),
    );
    should(
      await rejection(call(refusing, 'GET /v1/logins/sign-in/:flowId', { path: '/v1/logins/sign-in/f1' })),
    ).containDeep({
      status: 409,
      code: 'fleet_login_unknown',
    });
    should(
      await rejection(call(failing, 'GET /v1/logins/sign-in/:flowId', { path: '/v1/logins/sign-in/f1' })),
    ).have.property('message', 'the child vanished');
  });
});

describe('changeRoutes — reading a held change', () => {
  it('should answer a held change as the contract shows it', async () => {
    const view = {
      id: 'chg1',
      change: { kind: 'login.enable', id: 'work' },
      summary: 'Enable work',
      consequences: [],
      expiresAt: AT,
      state: 'pending',
    };
    const routes = changeRoutes({
      stage: async () => view,
      view: (id: string) => ({ ...view, id }),
      apply: async () => ({ outcome: 'applied' }),
    } as never);
    should(bodyOf(await call(routes, 'GET /v1/logins/changes/:changeId', { path: '/v1/logins/changes/chg9' }))).match({
      id: 'chg9',
      state: 'pending',
    });
  });

  it('should refuse a path whose change id is empty', async () => {
    const routes = changeRoutes({} as never);
    should(
      await rejection(call(routes, 'GET /v1/logins/changes/:changeId', { path: '/v1/logins/changes/' })),
    ).containDeep({
      status: 400,
      code: 'bad_request',
    });
  });
});
