import { describe, it } from 'bun:test';
import should from 'should';
import type { AuthenticatedCredential } from '../../../../src/lib/api/authentication.ts';
import { ApiError } from '../../../../src/lib/api/error.ts';
import type { RouteContext } from '../../../../src/lib/api/route.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { type SecretSubsystem, secretRoutes } from '../../../../src/lib/runtime/mounts/secrets.ts';
import { jsonBody, request } from '../../api/support.ts';
import { EchoSecretChildRunner, secretSubsystem } from './support.ts';

/**
 * Who may WRITE the secret store.
 *
 * Every ferret holds the host admin token, so before this an agent could create, replace or delete any
 * secret with no card in front of the owner: replace `GITHUB_TOKEN` with a value it controls, or delete
 * it. The store is the owner's to write. The owner's own `fy` and a paired device (the app's write-only
 * form) keep working; reading names and spending a secret by name (`use`) stay open to an agent.
 *
 * Every case drives the real route table with the context the dispatcher would build for that caller.
 */

const OLD = 'sk-live-0123456789';
const POISON = 'sk-evil-9876543210';

interface Caller {
  readonly credential: AuthenticatedCredential;
  readonly actor: string;
}

const OWNER_SHELL: Caller = { credential: { kind: 'authenticated', tokenClass: 'admin' }, actor: 'admin-cli' };
const OWNER_APP: Caller = { credential: { kind: 'authenticated', tokenClass: 'admin' }, actor: 'admin-ui' };
const PAIRED_DEVICE: Caller = {
  credential: { kind: 'authenticated', tokenClass: 'device', deviceId: 'd1' },
  actor: 'device:d1',
};
const FERRET: Caller = { credential: { kind: 'authenticated', tokenClass: 'admin' }, actor: 'peer:s1' };
/** A ferret on its OWN session credential: the handler's second line keys on the class, not on a header. */
const FERRET_OWN: Caller = {
  credential: { kind: 'authenticated', tokenClass: 'session', sessionId: 's1' },
  actor: 'peer:s1',
};
const WARDEN: Caller = { credential: { kind: 'authenticated', tokenClass: 'warden' }, actor: 'warden:w1' };

interface Answer {
  readonly status: number;
  readonly code?: string;
  readonly message?: string;
  readonly body?: Record<string, unknown>;
}

async function drive(
  subsystem: SecretSubsystem,
  caller: Caller,
  method: string,
  path: string,
  body?: unknown,
): Promise<Answer> {
  const found = new ApiRouter(secretRoutes(subsystem)).lookup(method, path);
  if (found.kind !== 'matched') throw new Error(`no route ${method} ${path}`);
  const context: RouteContext = {
    request: request({
      method,
      path,
      headers: { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    params: found.params,
    actor: caller.actor,
    credential: caller.credential,
  };
  try {
    const response = await found.route.handle(context);
    return { status: response.status, body: jsonBody(response) as Record<string, unknown> };
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    return { status: error.status, code: error.code, message: error.message };
  }
}

const names = async (subsystem: SecretSubsystem) => (await subsystem.directory.list()).map(secret => secret.name);

/** The value a child would now receive for `TOKEN`: proof the stored value was not replaced. */
async function valueSeenBy(subsystem: SecretSubsystem, runner: EchoSecretChildRunner): Promise<string | undefined> {
  await subsystem.uses.run({ command: ['env'], cwd: '/srv', secrets: ['TOKEN'], env: {}, timeoutMs: 5000 });
  return runner.spec?.env.TOKEN;
}

describe('who may write the secret store', () => {
  for (const [who, caller] of [
    ['a ferret', FERRET],
    ['a ferret on its own credential', FERRET_OWN],
    ['a warden', WARDEN],
  ] as const) {
    describe(`${who}`, () => {
      it('should be refused when it sets a new secret, and nothing is stored', async () => {
        const subsystem = secretSubsystem();

        const answer = await drive(subsystem, caller, 'POST', '/v1/secrets', { name: 'TOKEN', value: POISON });

        should(answer.status).equal(403);
        should(answer.code).equal('forbidden');
        should(await names(subsystem)).deepEqual([]);
      });

      it('should be refused when it replaces an existing secret, and the old value stays', async () => {
        const runner = new EchoSecretChildRunner();
        const subsystem = secretSubsystem({ runner });
        await subsystem.directory.put('TOKEN', OLD);

        const answer = await drive(subsystem, caller, 'POST', '/v1/secrets', { name: 'TOKEN', value: POISON });

        should(answer.status).equal(403);
        should(await valueSeenBy(subsystem, runner)).equal(OLD);
      });

      it('should be refused when it deletes a secret, and the secret stays', async () => {
        const subsystem = secretSubsystem();
        await subsystem.directory.put('TOKEN', OLD);

        const answer = await drive(subsystem, caller, 'DELETE', '/v1/secrets/TOKEN');

        should(answer.status).equal(403);
        should(answer.code).equal('forbidden');
        should(await names(subsystem)).deepEqual(['TOKEN']);
      });

      it('should be told the way a ferret does reach the store, in a plain sentence', async () => {
        const answer = await drive(secretSubsystem(), caller, 'POST', '/v1/secrets', { name: 'TOKEN', value: POISON });

        should(answer.message).match(/a ferret cannot set or replace a secret; the owner does/u);
        should(answer.message).match(/input request/u);
        should(answer.message).match(/sealed copy/u);
      });

      it('should be refused before the body is read, so a malformed body is still a refusal', async () => {
        const answer = await drive(secretSubsystem(), caller, 'POST', '/v1/secrets', { nonsense: true });

        should(answer.status).equal(403);
      });

      it('should be refused every other way into the store: saved logins, importing a bundle, and sealing values out', async () => {
        const subsystem = secretSubsystem();
        await subsystem.logins?.put('GITHUB', { label: 'GitHub', password: OLD });

        const answers = [
          await drive(subsystem, caller, 'PUT', '/v1/secrets/logins/GITHUB', { password: POISON }),
          await drive(subsystem, caller, 'POST', '/v1/secrets/logins/GITHUB/rename', { to: 'EVIL' }),
          await drive(subsystem, caller, 'DELETE', '/v1/secrets/logins/GITHUB'),
          await drive(subsystem, caller, 'POST', '/v1/secrets/imports'),
          await drive(subsystem, caller, 'POST', '/v1/secrets/imports/imp_x', { bundle: {} }),
          await drive(subsystem, caller, 'POST', '/v1/secrets/exports/imp_x', { offer: {}, names: ['TOKEN'] }),
        ];

        should(answers.map(answer => [answer.status, answer.code])).deepEqual(answers.map(() => [403, 'forbidden']));
        should((await subsystem.logins?.list())?.map(entry => entry.id)).deepEqual(['GITHUB']);
      });

      it('should still list the names and spend a secret by name', async () => {
        const runner = new EchoSecretChildRunner();
        const subsystem = secretSubsystem({ runner });
        await subsystem.directory.put('TOKEN', OLD);

        const listed = await drive(subsystem, caller, 'GET', '/v1/secrets');
        const used = await drive(subsystem, caller, 'POST', '/v1/secrets/use', {
          command: ['env'],
          cwd: '/srv',
          secrets: ['TOKEN'],
        });

        should(listed.status).equal(200);
        should(used.status).equal(200);
      });
    });
  }

  for (const [who, caller] of [
    ['the owner at a shell (fy secret set)', OWNER_SHELL],
    ['the owner in the app', OWNER_APP],
    ['a paired device (the write-only secret form)', PAIRED_DEVICE],
  ] as const) {
    describe(`${who}`, () => {
      it('should set, replace and delete a secret', async () => {
        const runner = new EchoSecretChildRunner();
        const subsystem = secretSubsystem({ runner });

        const created = await drive(subsystem, caller, 'POST', '/v1/secrets', { name: 'TOKEN', value: OLD });
        const replaced = await drive(subsystem, caller, 'POST', '/v1/secrets', { name: 'TOKEN', value: POISON });
        const seen = await valueSeenBy(subsystem, runner);
        const removed = await drive(subsystem, caller, 'DELETE', '/v1/secrets/TOKEN');

        should([created.status, replaced.status, removed.status]).deepEqual([200, 200, 200]);
        should(seen).equal(POISON);
        should(await names(subsystem)).deepEqual([]);
      });

      it('should create, rename and delete a saved login', async () => {
        const subsystem = secretSubsystem();

        const put = await drive(subsystem, caller, 'PUT', '/v1/secrets/logins/GITHUB', {
          label: 'GitHub',
          password: OLD,
        });
        const renamed = await drive(subsystem, caller, 'POST', '/v1/secrets/logins/GITHUB/rename', { to: 'GH' });
        const removed = await drive(subsystem, caller, 'DELETE', '/v1/secrets/logins/GH');

        should([put.status, renamed.status, removed.status]).deepEqual([200, 200, 200]);
      });
    });
  }
});
