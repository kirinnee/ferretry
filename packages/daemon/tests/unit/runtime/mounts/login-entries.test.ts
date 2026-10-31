import { describe, it } from 'bun:test';
import { LOGIN_TOTP_WARNING } from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { type SecretSubsystem, secretRoutes } from '../../../../src/lib/runtime/mounts/secrets.ts';
import { SecretStoreError } from '../../../../src/lib/secrets/index.ts';
import { jsonBody, request } from '../../api/support.ts';
import { CREDENTIALS, GRANTED, human, MemoryLoginIndex, MemorySecretDocuments, secretSubsystem } from './support.ts';

/** The saved-login routes: labels, matches and which fields exist go out; a value only ever comes in. */

const PASSWORD = 'hunter2-UNIQUE-pw';
const SEED = 'JBSWY3DPEHPK3PXP';

function dispatch(subsystem: SecretSubsystem, method: string, path: string, body?: unknown) {
  return new ApiDispatcher(new ApiRouter(secretRoutes(subsystem)), CREDENTIALS, GRANTED).dispatch(
    request({ method, path, headers: human, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
  );
}

describe('the saved-login routes', () => {
  it('should create, list, rename and delete a login, answering no value anywhere', async () => {
    const subsystem = secretSubsystem();
    const put = await dispatch(subsystem, 'PUT', '/v1/secrets/logins/GITHUB_KIRINNEE', {
      label: 'GitHub (kirinnee)',
      match: ['github.com'],
      username: 'kirinnee',
      password: PASSWORD,
      totp: { seed: SEED },
      totpAcknowledged: true,
    });
    const listed = await dispatch(subsystem, 'GET', '/v1/secrets/logins');
    const renamed = await dispatch(subsystem, 'POST', '/v1/secrets/logins/GITHUB_KIRINNEE/rename', { to: 'GITHUB' });
    const removed = await dispatch(subsystem, 'DELETE', '/v1/secrets/logins/GITHUB');
    const gone = await dispatch(subsystem, 'DELETE', '/v1/secrets/logins/GITHUB');

    should(put.status).equal(200);
    should(listed.status).equal(200);
    const list = (await jsonBody(listed)) as { health: string; entries: unknown[] };
    should(list.health).equal('ready');
    should(list.entries).match([
      { id: 'GITHUB_KIRINNEE', username: 'kirinnee', fields: { password: true, totp: true } },
    ]);
    should(((await jsonBody(renamed)) as { id: string }).id).equal('GITHUB');
    should(await jsonBody(removed)).deepEqual({ id: 'GITHUB', removed: true });
    should(gone.status).equal(404);
    for (const response of [put, listed, renamed])
      for (const value of [PASSWORD, SEED]) should(JSON.stringify(await jsonBody(response))).not.containEql(value);
  });

  it('should refuse a 2FA seed sent without confirming the warning', async () => {
    const response = await dispatch(secretSubsystem(), 'PUT', '/v1/secrets/logins/GITHUB', {
      label: 'GitHub',
      totp: { seed: SEED },
    });
    should(response.status).equal(400);
    should(JSON.stringify(await jsonBody(response))).containEql(LOGIN_TOTP_WARNING);
  });

  it('should refuse a bad handle, a new login with no label and a rename onto a name in use', async () => {
    const subsystem = secretSubsystem();
    await dispatch(subsystem, 'PUT', '/v1/secrets/logins/A', { label: 'a' });
    await dispatch(subsystem, 'PUT', '/v1/secrets/logins/B', { label: 'b' });

    should((await dispatch(subsystem, 'PUT', '/v1/secrets/logins/bad%20name', { label: 'x' })).status).equal(400);
    should((await dispatch(subsystem, 'PUT', '/v1/secrets/logins/NEW', { password: PASSWORD })).status).equal(400);
    should((await dispatch(subsystem, 'POST', '/v1/secrets/logins/A/rename', { to: 'B' })).status).equal(409);
    should((await dispatch(subsystem, 'POST', '/v1/secrets/logins/NOPE/rename', { to: 'C' })).status).equal(404);
  });

  it('should list a damaged store as damaged, never as empty', async () => {
    const subsystem = secretSubsystem({ loginIndex: new MemoryLoginIndex(new SecretStoreError('unreadable', 'bad json')) });
    const body = (await jsonBody(await dispatch(subsystem, 'GET', '/v1/secrets/logins'))) as {
      health: string;
      diagnosis: string;
    };
    should(body.health).equal('damaged');
    should(body.diagnosis).containEql('bad json');
  });

  it('should answer a damaged store on a change as the server’s fault', async () => {
    const subsystem = secretSubsystem({ loginSealed: new MemorySecretDocuments(new SecretStoreError('key_missing', 'gone')) });
    should((await dispatch(subsystem, 'PUT', '/v1/secrets/logins/A', { label: 'a', password: PASSWORD })).status).equal(500);
  });

  it('should keep the saved-login routes out of a daemon that keeps none', () => {
    const { logins: _none, ...without } = secretSubsystem();
    should(secretRoutes(without).some(route => route.path.includes('logins'))).be.false();
  });
});
