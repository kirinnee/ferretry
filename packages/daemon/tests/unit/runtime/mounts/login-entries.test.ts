import { describe, it } from 'bun:test';
import { LOGIN_TOTP_WARNING } from '@ferretry/protocol';
import should from 'should';
import { ApiDispatcher } from '../../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import { type SecretSubsystem, secretRoutes } from '../../../../src/lib/runtime/mounts/secrets.ts';
import { SecretStoreError } from '../../../../src/lib/secrets/index.ts';
import { jsonBody, request } from '../../api/support.ts';
import {
  agentIn,
  CREDENTIALS,
  GRANTED,
  human,
  MemoryLoginIndex,
  MemorySecretDocuments,
  secretSubsystem,
} from './support.ts';

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
    const subsystem = secretSubsystem({
      loginIndex: new MemoryLoginIndex(new SecretStoreError('unreadable', 'bad json')),
    });
    const body = (await jsonBody(await dispatch(subsystem, 'GET', '/v1/secrets/logins'))) as {
      health: string;
      diagnosis: string;
    };
    should(body.health).equal('damaged');
    should(body.diagnosis).containEql('bad json');
  });

  it('should answer a damaged store on a change as the server’s fault', async () => {
    const subsystem = secretSubsystem({
      loginSealed: new MemorySecretDocuments(new SecretStoreError('key_missing', 'gone')),
    });
    should((await dispatch(subsystem, 'PUT', '/v1/secrets/logins/A', { label: 'a', password: PASSWORD })).status).equal(
      500,
    );
  });

  it('should keep the saved-login routes out of a daemon that keeps none', () => {
    const { logins: _none, ...without } = secretSubsystem();
    should(secretRoutes(without).some(route => route.path.includes('logins'))).be.false();
  });
});

function dispatchAs(
  headers: Record<string, string>,
  subsystem: SecretSubsystem,
  method: string,
  path: string,
  body?: unknown,
) {
  const [route = path, search = ''] = path.split('?');
  return new ApiDispatcher(new ApiRouter(secretRoutes(subsystem)), CREDENTIALS, GRANTED).dispatch(
    request({
      method,
      path: route,
      query: [...new URLSearchParams(search)],
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

/** A site that signs in with Google, the Google login it goes via, and a password login for another site. */
async function providerWorld(): Promise<SecretSubsystem> {
  const subsystem = secretSubsystem();
  await dispatch(subsystem, 'PUT', '/v1/secrets/logins/GOOGLE_KIRIN', {
    label: 'Google (kirin@example.com)',
    match: ['accounts.google.com'],
    username: 'kirin@example.com',
    password: PASSWORD,
    totp: { seed: SEED },
    totpAcknowledged: true,
  });
  await dispatch(subsystem, 'PUT', '/v1/secrets/logins/VERCEL', {
    label: 'Vercel',
    match: ['vercel.com'],
    method: { kind: 'google', via: 'GOOGLE_KIRIN' },
    domains: ['vercel.com'],
  });
  await dispatch(subsystem, 'PUT', '/v1/secrets/logins/GITHUB', {
    label: 'GitHub',
    match: ['github.com'],
    password: `${PASSWORD}-gh`,
  });
  return subsystem;
}

describe('how a saved login signs in', () => {
  it('should keep the method, the provider it goes via and the login domains, and list them', async () => {
    const subsystem = await providerWorld();
    const list = (await jsonBody(await dispatch(subsystem, 'GET', '/v1/secrets/logins'))) as {
      entries: { id: string; method: unknown; domains: unknown }[];
    };
    should(list.entries.find(entry => entry.id === 'VERCEL')).match({
      method: { kind: 'google', via: 'GOOGLE_KIRIN' },
      domains: ['vercel.com'],
    });
    should(list.entries.find(entry => entry.id === 'GITHUB')).match({
      method: { kind: 'password' },
      domains: ['github.com'],
    });
  });

  it('should refuse a passkey, in any spelling, as a sign-in method', async () => {
    const subsystem = secretSubsystem();
    for (const method of [
      { kind: 'passkey' },
      { kind: 'webauthn' },
      { kind: 'sso', name: 'Passkey' },
      { kind: 'sso', name: 'Sign in with a pass-key' },
      { kind: 'sso', name: 'WebAuthn' },
      { kind: 'sso', name: 'YubiKey' },
      { kind: 'sso', name: 'Security key' },
    ]) {
      const response = await dispatch(subsystem, 'PUT', '/v1/secrets/logins/SITE', { label: 'Site', method });
      should(response.status).equal(400);
    }
    should(
      ((await jsonBody(await dispatch(subsystem, 'GET', '/v1/secrets/logins'))) as { entries: unknown[] }).entries,
    ).be.empty();
  });

  it('should refuse a method via a login that does not exist, or via itself', async () => {
    const subsystem = await providerWorld();
    const missing = await dispatch(subsystem, 'PUT', '/v1/secrets/logins/NETLIFY', {
      label: 'Netlify',
      method: { kind: 'github', via: 'NOPE' },
    });
    const itself = await dispatch(subsystem, 'PUT', '/v1/secrets/logins/GITHUB', {
      method: { kind: 'github', via: 'GITHUB' },
    });
    should(missing.status).equal(400);
    should(((await jsonBody(missing)) as { code: string }).code).equal('bad_via');
    should(itself.status).equal(400);
  });

  it('should follow a renamed provider, and forget a deleted one, in the logins that go via it', async () => {
    const subsystem = await providerWorld();
    await dispatch(subsystem, 'POST', '/v1/secrets/logins/GOOGLE_KIRIN/rename', { to: 'GOOGLE' });
    const renamed = (await jsonBody(await dispatch(subsystem, 'GET', '/v1/secrets/logins'))) as {
      entries: { id: string; method: { via?: string } }[];
    };
    should(renamed.entries.find(entry => entry.id === 'VERCEL')?.method.via).equal('GOOGLE');
    await dispatch(subsystem, 'DELETE', '/v1/secrets/logins/GOOGLE');
    const deleted = (await jsonBody(await dispatch(subsystem, 'GET', '/v1/secrets/logins'))) as {
      entries: { id: string; method: { kind: string; via?: string } }[];
    };
    should(deleted.entries.find(entry => entry.id === 'VERCEL')?.method).deepEqual({ kind: 'google' });
  });
});

describe('the login hint a ferret reads', () => {
  it('should name the site login, its method and the provider login it goes via, and nothing secret', async () => {
    const subsystem = await providerWorld();
    const response = await dispatchAs(
      agentIn('ferret-1'),
      subsystem,
      'GET',
      '/v1/secrets/logins/hint?site=https%3A%2F%2Fvercel.com%2Flogin',
    );
    should(response.status).equal(200);
    const body = await jsonBody(response);
    should(body).deepEqual({
      v: 1,
      site: 'vercel.com',
      passkeys: 'off',
      hints: [
        {
          id: 'VERCEL',
          label: 'Vercel',
          role: 'site',
          method: { kind: 'google', via: 'GOOGLE_KIRIN' },
          via: { id: 'GOOGLE_KIRIN', label: 'Google (kirin@example.com)' },
          domains: ['vercel.com'],
        },
        {
          id: 'GOOGLE_KIRIN',
          label: 'Google (kirin@example.com)',
          role: 'provider',
          method: { kind: 'password' },
          domains: ['accounts.google.com'],
          username: 'kirin@example.com',
        },
      ],
    });
  });

  it('should match a site exactly: a look-alike or a parent domain is not it', async () => {
    const subsystem = await providerWorld();
    for (const site of ['github.com.evil.example', 'evilgithub.com', 'example.com', 'google.com']) {
      const body = (await jsonBody(
        await dispatchAs(human, subsystem, 'GET', `/v1/secrets/logins/hint?site=${encodeURIComponent(site)}`),
      )) as { hints: unknown[] };
      should(body.hints).be.empty();
    }
  });

  it('should refuse a site that is not one', async () => {
    const response = await dispatchAs(human, await providerWorld(), 'GET', '/v1/secrets/logins/hint?site=%20');
    should(response.status).equal(400);
  });

  it('SECURITY: no saved-login route answers a password, a seed, a code or which secret fields exist to a ferret', async () => {
    const subsystem = await providerWorld();
    const agent = agentIn('ferret-1');
    const reads = [
      await dispatchAs(agent, subsystem, 'GET', '/v1/secrets/logins'),
      ...(await Promise.all(
        ['vercel.com', 'accounts.google.com', 'github.com'].map(
          async site => await dispatchAs(agent, subsystem, 'GET', `/v1/secrets/logins/hint?site=${site}`),
        ),
      )),
    ];
    for (const response of reads) {
      const text = JSON.stringify(await jsonBody(response));
      for (const value of [PASSWORD, `${PASSWORD}-gh`, SEED]) should(text).not.containEql(value);
    }
    for (const response of reads.slice(1)) {
      const text = JSON.stringify(await jsonBody(response));
      should(text).not.containEql('"fields"');
      should(text).not.containEql('"totp"');
    }
    // And a ferret still may not change one.
    const change = await dispatchAs(agent, subsystem, 'PUT', '/v1/secrets/logins/GITHUB', {
      method: { kind: 'google', via: 'GOOGLE_KIRIN' },
    });
    should(change.status).equal(403);
  });
});
