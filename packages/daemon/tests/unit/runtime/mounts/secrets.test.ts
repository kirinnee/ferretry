import { describe, it } from 'bun:test';
import should from 'should';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { secretRoutes, type SecretSubsystem } from '../../../../src/lib/runtime/mounts/secrets.ts';
import { SecretStoreError } from '../../../../src/lib/secrets/index.ts';
import { jsonBody, request } from '../../api/support.ts';
import { CREDENTIALS, EchoSecretChildRunner, human, MemorySecretDocuments, secretSubsystem } from './support.ts';

/**
 * The HTTP surface of the secret store.
 *
 * The most important assertion in this file is the one about a route that does not exist: there is
 * no way to READ a value back, from anywhere. `use` spends a secret and answers scrubbed output; a
 * getter would delete the whole property.
 */

const TOKEN = 'sk-live-0123456789';

function dispatcher(subsystem: SecretSubsystem): ApiDispatcher {
  return new ApiDispatcher(new ApiRouter(secretRoutes(subsystem)), CREDENTIALS);
}

async function store(subsystem: SecretSubsystem, name: string, value: string): Promise<void> {
  const response = await dispatcher(subsystem).dispatch(
    request({ method: 'POST', path: '/v1/secrets', headers: human, body: JSON.stringify({ name, value }) }),
  );
  should(response.status).equal(200);
}

describe('the secret routes', () => {
  it('should have NO route that returns a value', () => {
    // Arrange / Act
    const paths = secretRoutes(secretSubsystem()).map(route => `${route.method} ${route.path}`);

    // Assert — the absence IS the feature. A `GET /v1/secrets/:name` here would be the hole.
    should(paths).deepEqual([
      'GET /v1/secrets',
      'POST /v1/secrets/use',
      'POST /v1/secrets',
      'DELETE /v1/secrets/:name',
    ]);
  });

  it('should keep every route admin-scoped and uncacheable', () => {
    // Arrange / Act
    const routes = secretRoutes(secretSubsystem());

    // Assert — a warden supervises sessions; it has no business spending the operator's credentials.
    should(routes.every(route => route.scope === 'admin')).be.true();
    should(routes.every(route => route.noStore === true)).be.true();
  });

  it('should store a secret and list it without its value', async () => {
    // Arrange
    const subsystem = secretSubsystem();
    await store(subsystem, 'TOKEN', TOKEN);

    // Act
    const response = await dispatcher(subsystem).dispatch(request({ path: '/v1/secrets', headers: human }));

    // Assert
    should(response.status).equal(200);
    should(response.body).not.containEql(TOKEN);
    const body = jsonBody(response);
    should(body.health).equal('ready');
    should((body.secrets as { name: string }[]).map(secret => secret.name)).deepEqual(['TOKEN']);
  });

  it('should refuse a value too short to redact safely, naming the reason at the boundary', async () => {
    // Act
    const response = await dispatcher(secretSubsystem()).dispatch(
      request({
        method: 'POST',
        path: '/v1/secrets',
        headers: human,
        body: JSON.stringify({ name: 'TOKEN', value: 'short' }),
      }),
    );

    // Assert
    should(response.status).equal(400);
  });

  it('should report a damaged store as damaged rather than as an empty one', async () => {
    // Arrange
    const subsystem = secretSubsystem({
      documents: new MemorySecretDocuments(new SecretStoreError('key_missing', 'the key is gone')),
    });

    // Act
    const response = await dispatcher(subsystem).dispatch(request({ path: '/v1/secrets', headers: human }));

    // Assert — a 200 carrying `damaged`, not a 200 carrying an empty list.
    should(response.status).equal(200);
    const body = jsonBody(response);
    should(body.health).equal('damaged');
    should(body.diagnosis).match(/key/u);
  });

  it('should delete a secret and refuse a second delete', async () => {
    // Arrange
    const subsystem = secretSubsystem();
    await store(subsystem, 'TOKEN', TOKEN);

    // Act
    const first = await dispatcher(subsystem).dispatch(
      request({ method: 'DELETE', path: '/v1/secrets/TOKEN', headers: human }),
    );
    const second = await dispatcher(subsystem).dispatch(
      request({ method: 'DELETE', path: '/v1/secrets/TOKEN', headers: human }),
    );

    // Assert
    should(first.status).equal(200);
    should(second.status).equal(404);
  });

  it('should refuse a path name no store could hold', async () => {
    // Act
    const response = await dispatcher(secretSubsystem()).dispatch(
      request({ method: 'DELETE', path: '/v1/secrets/lower-case', headers: human }),
    );

    // Assert
    should(response.status).equal(400);
    should(jsonBody(response).code).equal('invalid_secret_name');
  });

  it('should let a delete over a damaged store fail as a server problem, not the caller‘s', async () => {
    // Arrange
    const subsystem = secretSubsystem({
      documents: new MemorySecretDocuments(new SecretStoreError('unreadable', 'not JSON')),
    });

    // Act
    const response = await dispatcher(subsystem).dispatch(
      request({ method: 'DELETE', path: '/v1/secrets/TOKEN', headers: human }),
    );

    // Assert
    should(response.status).equal(500);
    should(jsonBody(response).code).equal('unreadable');
  });

  it('should let a store failure on PUT travel with its own code', async () => {
    // Arrange
    const subsystem = secretSubsystem({
      documents: new MemorySecretDocuments(new SecretStoreError('full', 'the vault is full')),
    });

    // Act
    const response = await dispatcher(subsystem).dispatch(
      request({
        method: 'POST',
        path: '/v1/secrets',
        headers: human,
        body: JSON.stringify({ name: 'TOKEN', value: TOKEN }),
      }),
    );

    // Assert
    should(response.status).equal(409);
    should(jsonBody(response).code).equal('full');
  });

  it('should spend a secret and answer output that has been scrubbed', async () => {
    // Arrange — a child whose entire purpose is to print the value.
    const runner = new EchoSecretChildRunner(spec => `${spec.env.TOKEN ?? ''}\n`);
    const subsystem = secretSubsystem({ runner });
    await store(subsystem, 'TOKEN', TOKEN);

    // Act
    const response = await dispatcher(subsystem).dispatch(
      request({
        method: 'POST',
        path: '/v1/secrets/use',
        headers: human,
        body: JSON.stringify({ command: ['sh', '-c', 'echo $TOKEN'], cwd: '/srv', secrets: ['TOKEN'] }),
      }),
    );

    // Assert
    should(response.status).equal(200);
    should(response.body).not.containEql(TOKEN);
    should(jsonBody(response).stdout).equal('[redacted:TOKEN]\n');
    // And the value really did reach the child: this is a scrub, not an omission.
    should(runner.spec?.env.TOKEN).equal(TOKEN);
  });

  it('should refuse a use naming a secret this daemon does not hold', async () => {
    // Act
    const response = await dispatcher(secretSubsystem()).dispatch(
      request({
        method: 'POST',
        path: '/v1/secrets/use',
        headers: human,
        body: JSON.stringify({ command: ['env'], cwd: '/srv', secrets: ['ABSENT'] }),
      }),
    );

    // Assert
    should(response.status).equal(404);
    should(jsonBody(response).code).equal('unknown_secret');
    should(jsonBody(response).error).match(/ABSENT/u);
  });

  it('should refuse a use with a relative working directory', async () => {
    // Act
    const response = await dispatcher(secretSubsystem()).dispatch(
      request({
        method: 'POST',
        path: '/v1/secrets/use',
        headers: human,
        body: JSON.stringify({ command: ['env'], cwd: 'relative' }),
      }),
    );

    // Assert
    should(response.status).equal(400);
    should(jsonBody(response).code).equal('invalid_cwd');
  });

  it('should surface a configured reference the store cannot resolve', async () => {
    // Arrange
    const subsystem = secretSubsystem({ recipes: { AUTH: 'Bearer ${secret:ABSENT}' } });

    // Act
    const response = await dispatcher(subsystem).dispatch(request({ path: '/v1/secrets', headers: human }));

    // Assert — the person sees the broken reference BEFORE a child fails for a reason nobody can read.
    should(jsonBody(response).references).deepEqual([
      { name: 'ABSENT', origin: 'config/daemon.json → secretEnvironment.AUTH', resolved: false },
    ]);
  });
});
