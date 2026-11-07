import { describe, it } from 'bun:test';
import { mcpOAuthRedirectPath, mcpOAuthSecretNames } from '@ferretry/protocol';
import should from 'should';
import {
  MAX_REGISTRATIONS_PER_COMPONENT,
  MCP_OAUTH_FLOW_TTL_MS,
  McpOAuthRefusal,
  type McpOAuthRefusalCode,
} from '../../../src/lib/mcp-oauth/index.ts';
import { leaks, PWA_REDIRECT, world } from './support.ts';

const SERVER = 'http://127.0.0.1:4100/mcp';
const NAMES = mcpOAuthSecretNames('linear', SERVER);
/** The PWA redirect a flow with the fake provider gets: the base plus that provider's own path. */
const FLOW_REDIRECT = `https://ferretry.example.test${mcpOAuthRedirectPath('http://127.0.0.1:4100/auth')}`;
/** Claude Code's loopback redirect, on any ephemeral port. */
const LOOPBACK = /^http:\/\/localhost:(49[1-9]\d\d|[5-6]\d{4})\/callback$/u;

async function refusalOf(work: Promise<unknown>): Promise<McpOAuthRefusal> {
  try {
    await work;
  } catch (error) {
    if (error instanceof McpOAuthRefusal) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

async function refusedWith(work: Promise<unknown>, code: McpOAuthRefusalCode): Promise<string> {
  const refusal = await refusalOf(work);
  should(refusal.code).equal(code);
  return refusal.message;
}

/** Start, approve at the fake provider, and finish — the whole journey a person makes. */
async function signIn(w: ReturnType<typeof world>) {
  const flow = await w.service.start('linear', { redirectUri: PWA_REDIRECT });
  const callback = await w.provider.approve(flow.authorizeUrl);
  const completion = await w.service.complete(flow.flowId, { callback });
  return { flow, callback, completion };
}

describe('McpOAuthService', () => {
  describe('starting a sign-in', () => {
    it('should discover, register for the PWA address, and answer an S256 authorization URL', async () => {
      // Arrange
      const w = world();

      // Act
      const flow = await w.service.start('linear', { redirectUri: PWA_REDIRECT });

      // Assert
      const url = new URL(flow.authorizeUrl);
      should(`${url.origin}${url.pathname}`).equal(`${w.provider.origin}/auth/authorize`);
      should(url.searchParams.get('code_challenge_method')).equal('S256');
      should(url.searchParams.get('code_challenge')).match(/^[A-Za-z0-9_-]{43}$/u);
      should(url.searchParams.get('state')).match(/^[A-Za-z0-9_-]{43}$/u);
      should(url.searchParams.get('resource')).equal(w.provider.serverUrl);
      should(url.searchParams.get('redirect_uri')).equal(FLOW_REDIRECT);
      should(url.searchParams.get('scope')).equal('mcp:tools');
      should(url.searchParams.get('client_id')).equal(w.provider.registrations[0]?.clientId);
      should(flow).containEql({
        mode: 'pwa',
        component: 'linear',
        redirectUri: FLOW_REDIRECT,
        issuer: '127.0.0.1:4100',
      });
      should(Date.parse(flow.expiresAt) - w.clock.at).equal(MCP_OAUTH_FLOW_TTL_MS);
      should(flow).not.have.property('note');
      // The verifier never leaves the daemon: nothing answered is 43+ chars of verifier alphabet beyond the
      // challenge and the state, which are the only such values in the URL.
      should(JSON.stringify(flow)).not.containEql('verifier');
    });

    it('should reuse a registration it already holds for the same provider and address', async () => {
      // Arrange
      const w = world();
      await w.service.start('linear', { redirectUri: PWA_REDIRECT });

      // Act
      await w.service.start('linear', { redirectUri: PWA_REDIRECT });

      // Assert
      should(w.provider.registrations).have.length(1);
    });

    it('should use the paste address when the browser asks for no redirect', async () => {
      // Arrange
      const w = world();

      // Act
      const flow = await w.service.start('linear', {});

      // Assert
      should(flow.mode).equal('paste');
      should(flow.redirectUri).match(LOOPBACK);
    });

    it('should fall back to the paste address, and say why, when the provider refuses the PWA address', async () => {
      // Arrange
      const w = world({ refuseRedirect: uri => uri.startsWith('https://') });

      // Act
      const flow = await w.service.start('linear', { redirectUri: PWA_REDIRECT });

      // Assert
      should(flow.mode).equal('paste');
      should(flow.redirectUri).match(LOOPBACK);
      should(flow.note).match(/paste an address/u);
    });

    it('should refuse a return address that is not a Ferretry callback page', async () => {
      // Arrange
      const w = world();

      // Act / Assert
      await refusedWith(
        w.service.start('linear', { redirectUri: 'https://evil.example/collect' }),
        'mcp_auth_bad_redirect',
      );
      should(w.http.requests).have.length(0);
    });

    it('should refuse a component that does not exist or does not sign in', async () => {
      // Arrange
      const w = world();

      // Act / Assert
      await refusedWith(w.service.start('nope', {}), 'mcp_auth_unknown_component');
      await refusedWith(w.service.start('plain', {}), 'mcp_auth_not_oauth');
      await refusedWith(w.service.start('local', {}), 'mcp_auth_not_oauth');
    });

    it('should refuse a provider that does not advertise PKCE', async () => {
      // Arrange
      const w = world({ noPkce: true });

      // Act
      const message = await refusedWith(w.service.start('linear', {}), 'mcp_auth_discovery');

      // Assert
      should(message).match(/PKCE/u);
    });

    it('should refuse a provider with no registration endpoint, in words', async () => {
      // Arrange
      const w = world({ noRegistration: true });

      // Act
      const message = await refusedWith(w.service.start('linear', {}), 'mcp_auth_registration');

      // Assert
      should(message).match(/does not let new apps register/u);
    });

    it('should refuse when the provider will not register Ferretry at all, saying why, where and every way it asked', async () => {
      // Arrange — the loopback address is refused too, so the fallback has nowhere to go.
      const w = world({ refuseRedirect: () => true });

      // Act
      const message = await refusedWith(
        w.service.start('linear', { redirectUri: PWA_REDIRECT }),
        'mcp_auth_registration',
      );

      // Assert
      should(message).startWith('The sign-in provider refused new apps: invalid_redirect_uri — not allowed here.');
      should(message).containEql('127.0.0.1:4100 answered HTTP 400');
      should(message).containEql('Tried 3 ways');
      should(w.provider.registrationRequests.length).be.belowOrEqual(4);
    });

    it('should say an unreachable registration endpoint is a network problem, naming the host and the failure', async () => {
      // Arrange
      const w = world();
      w.http.failing.add(`${w.provider.origin}/auth/register`);
      w.http.failure = 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY';

      // Act
      const message = await refusedWith(w.service.start('linear', {}), 'mcp_auth_registration');

      // Assert
      should(message).startWith('Ferretry’s daemon couldn’t reach 127.0.0.1:4100 to register Ferretry');
      should(message).containEql('certificate');
      should(message).containEql('(network error: UNABLE_TO_GET_ISSUER_CERT_LOCALLY)');
      should(message).containEql('docs/mcp-oauth.md');
      // Not retried: asking another way does not help a request that got no answer.
      should(w.http.requests.filter(request => request.url.endsWith('/auth/register'))).have.length(1);
    });

    it('should treat a server with no resource metadata as its own authorization server', async () => {
      // Arrange
      const w = world({ legacy: true });

      // Act
      const flow = await w.service.start('linear', {});

      // Assert
      should(new URL(flow.authorizeUrl).pathname).equal('/authorize');
      should(new URL(flow.authorizeUrl).searchParams.has('scope')).be.false();
    });

    it('should say the server could not be reached, naming only its host and the failure, when the network fails', async () => {
      // Arrange
      const w = world();
      w.http.failing.add(w.provider.serverUrl);

      // Act
      const message = await refusedWith(w.service.start('linear', {}), 'mcp_auth_discovery');

      // Assert
      should(message).startWith('Ferretry’s daemon couldn’t reach 127.0.0.1:4100 to find out how this server signs in');
      should(message).containEql('(network error: ConnectionRefused)');
    });

    it('should start a sign-in with a provider that advertises no revocation endpoint', async () => {
      // Arrange
      const w = world({ noRevocation: true });

      // Act
      const flow = await w.service.start('linear', {});
      const flowDocument = await w.state.read();

      // Assert — the flow is usable, and nothing records an endpoint the provider never named
      should(new URL(flow.authorizeUrl).pathname).equal('/auth/authorize');
      should(JSON.stringify(flowDocument)).not.containEql('revoke');
    });

    it('should say the server could not be reached when reading its answer fails unexpectedly', async () => {
      // Arrange — an answer the transport delivers but that cannot be read, not a dead host
      const w = world();
      w.http.request = async () => ({
        status: 401,
        header: () => {
          throw new Error('malformed answer');
        },
        text: '',
      });

      // Act
      const message = await refusedWith(w.service.start('linear', {}), 'mcp_auth_discovery');

      // Assert
      should(message).equal(
        'Ferretry could not reach the server to find out how it signs in. Check its address and try again.',
      );
    });

    it('should refuse a server that describes no authorization server anywhere', async () => {
      // Arrange — the MCP endpoint answers 401 with no challenge and every metadata address is a 404.
      const w = world();
      w.servers = [{ component: 'linear', url: `${w.provider.origin}/elsewhere`, auth: 'oauth' }];

      // Act
      const message = await refusedWith(w.service.start('linear', {}), 'mcp_auth_discovery');

      // Assert
      should(message).match(/does not describe how to sign in/u);
    });

    it('should keep one sign-in per component and at most sixteen in flight', async () => {
      // Arrange
      const w = world();
      const first = await w.service.start('linear', {});
      await w.service.start('linear', {});
      w.servers = [
        ...w.servers,
        ...Array.from({ length: 17 }, (_, index) => ({
          component: `extra-${String(index)}`,
          url: w.provider.serverUrl,
          auth: 'oauth' as const,
        })),
      ];
      const extras = [];
      for (let index = 0; index < 17; index += 1) extras.push(await w.service.start(`extra-${String(index)}`, {}));

      // Act / Assert — the replaced flow and the oldest extra are gone.
      await refusedWith(w.service.complete(first.flowId, { callback: 'x' }), 'mcp_auth_unknown_flow');
      should(w.service.cancel((extras[0] as { flowId: string }).flowId).cancelled).be.false();
      should(w.service.cancel((extras[16] as { flowId: string }).flowId).cancelled).be.true();
    });
  });

  describe('finishing a sign-in', () => {
    it('should redeem the code with the verifier and file the tokens in the store, answering none', async () => {
      // Arrange
      const w = world({ expiresIn: 3600 });

      // Act
      const { completion } = await signIn(w);

      // Assert
      should(completion.component).equal('linear');
      should(completion.connection).containEql({ state: 'signed-in', renewable: true, issuer: '127.0.0.1:4100' });
      should(completion.connection.expiresAt).equal('2026-10-16T01:00:00.000Z');
      should(completion.connection.secrets).deepEqual([NAMES.access]);
      should(w.secrets.entries.get(NAMES.access)).equal(w.provider.issued[0]);
      // The refresh token is daemon-internal: never in the ordinary store, where `use` could spend it.
      should(w.internal.entries.get(NAMES.refresh)).equal(w.provider.issued[1]);
      should([...w.secrets.entries.keys()]).deepEqual([NAMES.access]);
      // NO TOKEN in the answer or the state document.
      should(leaks(w.provider, completion, w.state.document)).deepEqual([]);
      // The token request carried the verifier and the resource (RFC 7636, RFC 8707).
      const form = w.provider.tokenRequests[0] as URLSearchParams;
      should(form.get('code_verifier')).match(/^[A-Za-z0-9_-]{43}$/u);
      should(form.get('resource')).equal(w.provider.serverUrl);
    });

    it('should refuse the same address twice: the flow is single-use', async () => {
      // Arrange
      const w = world();
      const { flow, callback } = await signIn(w);

      // Act
      const message = await refusedWith(w.service.complete(flow.flowId, { callback }), 'mcp_auth_unknown_flow');

      // Assert
      should(message).not.containEql(callback);
      should(w.provider.tokenRequests).have.length(1);
    });

    it('should refuse a mismatched address WITHOUT spending the flow, so the person can paste again', async () => {
      // Arrange
      const w = world();
      const flow = await w.service.start('linear', { redirectUri: PWA_REDIRECT });
      const callback = await w.provider.approve(flow.authorizeUrl);
      const forged = callback.replace(/state=[^&]+/u, 'state=forged');

      // Act
      const message = await refusedWith(w.service.complete(flow.flowId, { callback: forged }), 'mcp_auth_callback');
      const completion = await w.service.complete(flow.flowId, { callback });

      // Assert
      should(message).match(/different sign-in attempt/u);
      should(message).not.containEql('code-');
      should(completion.connection.state).equal('signed-in');
    });

    it('should drop a flow once it expires', async () => {
      // Arrange
      const w = world();
      const flow = await w.service.start('linear', { redirectUri: PWA_REDIRECT });
      const callback = await w.provider.approve(flow.authorizeUrl);
      w.clock.at += MCP_OAUTH_FLOW_TTL_MS;

      // Act / Assert
      await refusedWith(w.service.complete(flow.flowId, { callback }), 'mcp_auth_unknown_flow');
    });

    it('should answer a provider refusal from a fixed table, never the provider’s own words', async () => {
      // Arrange — the code is spent at the provider first, so redeeming it answers invalid_grant with a
      // description that quotes the code back.
      const w = world();
      const flow = await w.service.start('linear', { redirectUri: PWA_REDIRECT });
      const callback = await w.provider.approve(flow.authorizeUrl);
      const code = new URL(callback).searchParams.get('code') as string;
      await w.provider.handle(
        new Request(`${w.provider.origin}/auth/token`, {
          method: 'POST',
          body: `grant_type=authorization_code&code=${code}`,
        }),
      );

      // Act
      const message = await refusedWith(w.service.complete(flow.flowId, { callback }), 'mcp_auth_exchange');

      // Assert
      should(message).match(/used already or expired/u);
      should(message).not.containEql(code);
      should(w.secrets.entries.size).equal(0);
    });

    it('should answer an unreachable token endpoint as a failed sign-in', async () => {
      // Arrange
      const w = world();
      const flow = await w.service.start('linear', { redirectUri: PWA_REDIRECT });
      const callback = await w.provider.approve(flow.authorizeUrl);
      w.http.failing.add(`${w.provider.origin}/auth/token`);

      // Act
      const message = await refusedWith(w.service.complete(flow.flowId, { callback }), 'mcp_auth_exchange');

      // Assert
      should(message).equal('The provider did not finish the sign-in. Start again.');
    });

    it('should drop a stale refresh token when the provider issues none', async () => {
      // Arrange
      const w = world({ noRefresh: true });
      await w.internal.put(NAMES.refresh, 'an-old-refresh-token');

      // Act
      const { completion } = await signIn(w);

      // Assert
      should(w.internal.entries.has(NAMES.refresh)).be.false();
      should(completion.connection).containEql({ renewable: false, state: 'signed-in' });
      should(completion.connection).not.have.property('expiresAt');
    });

    it('should file a client secret and send it on the token request for a confidential registration', async () => {
      // Arrange
      const w = world({ confidential: true });

      // Act
      const { completion } = await signIn(w);
      await w.service.start('linear', {});

      // Assert — each registration's secret is kept apart, and only in the internal store.
      should(w.provider.tokenRequests[0]?.get('client_secret')).equal(w.provider.issued[0]);
      should(completion.connection.secrets).deepEqual([NAMES.access]);
      should([...w.internal.entries.values()]).containEql(w.provider.issued[0]);
      should([...w.internal.entries.values()]).containEql(w.provider.issued[3]);
      should([...w.secrets.entries.values()]).deepEqual([w.provider.issued[1]]);
      should(w.state.document.registrations.linear).have.length(2);
      should(leaks(w.provider, completion, w.state.document)).deepEqual([]);
    });
  });

  describe('where a sign-in stands', () => {
    it('should list every component that signs in, and a stored sign-in whose component is gone', async () => {
      // Arrange
      const w = world({ expiresIn: 60 });
      should(await w.service.connections()).deepEqual([
        { component: 'linear', state: 'needs-sign-in', renewable: false, secrets: [] },
      ]);
      await signIn(w);
      w.servers = [];

      // Act
      const signedIn = await w.service.connections();
      w.clock.at += 61_000;
      const expired = await w.service.connections();
      await w.secrets.remove(NAMES.access);
      const missing = await w.service.connections();

      // Assert
      should(signedIn[0]).containEql({ component: 'linear', state: 'signed-in', scope: 'mcp:tools' });
      should(expired[0]).containEql({ state: 'expired', renewable: true });
      should(missing[0]).containEql({ state: 'needs-sign-in', issuer: '127.0.0.1:4100' });
    });

    it('should say a sign-in needs renewing once its server has moved to another address', async () => {
      // Arrange
      const w = world();
      await signIn(w);
      w.servers = [{ component: 'linear', url: `${w.provider.origin}/moved`, auth: 'oauth' }];

      // Act
      const [connection] = await w.service.connections();

      // Assert
      should(connection).containEql({ component: 'linear', state: 'needs-sign-in' });
    });
  });

  describe('refreshing on use', () => {
    it('should refresh a token about to expire, rotating both, and leave a fresh one alone', async () => {
      // Arrange
      const w = world({ expiresIn: 3600 });
      await signIn(w);
      const before = w.secrets.entries.get(NAMES.access);

      // Act — fresh: nothing happens.
      await w.service.refreshForLaunch([NAMES.access]);
      should(w.provider.tokenRequests).have.length(1);
      w.clock.at += 3600_000 - 30_000;
      await w.service.refreshForLaunch([NAMES.access]);

      // Assert
      should(w.provider.tokenRequests).have.length(2);
      should(w.provider.tokenRequests[1]?.get('grant_type')).equal('refresh_token');
      should(w.secrets.entries.get(NAMES.access)).not.equal(before);
      should(w.secrets.entries.get(NAMES.access)).equal(w.provider.issued[2]);
      should(w.internal.entries.get(NAMES.refresh)).equal(w.provider.issued[3]);
      should(w.state.document.connections.linear?.expiresAt).equal('2026-10-16T01:59:30.000Z');
      should(leaks(w.provider, w.state.document)).deepEqual([]);
    });

    it('should touch nothing a launch does not name, nor a token without an expiry', async () => {
      // Arrange
      const w = world();
      await signIn(w);

      // Act
      await w.service.refreshForLaunch(['SOMETHING_ELSE']);
      await w.service.refreshForLaunch([NAMES.access]);

      // Assert
      should(w.provider.tokenRequests).have.length(1);
    });

    it('should mark a rejected refresh as needing a new sign-in, and leave the launch alone', async () => {
      // Arrange
      const w = world({ expiresIn: 10 });
      await signIn(w);
      w.provider.refreshError = 'invalid_grant';
      w.clock.at += 20_000;

      // Act
      await w.service.refreshForLaunch([NAMES.access]);
      await w.service.refreshForLaunch([NAMES.access]);

      // Assert — marked once, then never asked again.
      should(w.state.document.connections.linear).containEql({ needsSignIn: true, renewable: false });
      should(w.provider.tokenRequests).have.length(2);
      should((await w.service.connections())[0]?.state).equal('needs-sign-in');
    });

    it('should keep the old token when a refresh fails for any other reason', async () => {
      // Arrange
      const w = world({ expiresIn: 10 });
      await signIn(w);
      w.provider.refreshError = 'temporarily_unavailable';
      w.clock.at += 20_000;

      // Act
      await w.service.refreshForLaunch([NAMES.access]);

      // Assert
      should(w.state.document.connections.linear?.needsSignIn).be.undefined();
      should(w.secrets.entries.get(NAMES.access)).equal(w.provider.issued[0]);
    });

    it('should mark a sign-in whose refresh token is gone as needing a new one', async () => {
      // Arrange
      const w = world({ expiresIn: 10 });
      await signIn(w);
      await w.internal.remove(NAMES.refresh);
      w.clock.at += 20_000;

      // Act
      await w.service.refreshForLaunch([NAMES.access]);

      // Assert
      should(w.state.document.connections.linear?.needsSignIn).be.true();
    });

    it('should never throw, even over a state document it cannot read', async () => {
      // Arrange
      const w = world();
      w.state.failure = new Error('damaged');

      // Act / Assert
      await w.service.refreshForLaunch([NAMES.access]);
    });

    it('should keep the previous expiry when a refresh answer gives none', async () => {
      // Arrange
      const w = world({ expiresIn: 10 });
      await signIn(w);
      w.clock.at += 20_000;
      const original = w.provider.handle;
      // The refresh answers with no expiry this time.
      (w.http as unknown as { handler: (request: Request) => Promise<Response> }).handler = async request => {
        if (new URL(request.url).pathname === '/auth/token')
          return new Response(JSON.stringify({ access_token: 'access-without-expiry' }), { status: 200 });
        return await original(request);
      };

      // Act
      await w.service.refreshForLaunch([NAMES.access]);

      // Assert
      should(w.secrets.entries.get(NAMES.access)).equal('access-without-expiry');
      should(w.state.document.connections.linear).not.have.property('expiresAt');
    });
  });

  describe('signing out', () => {
    it('should revoke the refresh token and delete every secret and record', async () => {
      // Arrange
      const w = world({ confidential: true });
      await signIn(w);

      // Act
      const answer = await w.service.signOut('linear');

      // Assert
      should(answer).deepEqual({ component: 'linear', removed: true, revoked: true });
      should(w.provider.revoked).deepEqual([w.provider.issued[2]]);
      should(w.secrets.entries.size).equal(0);
      should(w.state.document).deepEqual({ v: 1, registrations: {}, connections: {} });
    });

    it('should revoke the access token when there is no refresh token, and still delete when revocation fails', async () => {
      // Arrange
      const w = world({ noRefresh: true });
      await signIn(w);
      const access = w.provider.issued[0];

      // Act
      const answer = await w.service.signOut('linear');

      // Assert
      should(answer.revoked).be.true();
      should(w.provider.revoked).deepEqual([access]);

      // Arrange — and with the provider unreachable.
      const again = world();
      await signIn(again);
      again.http.failing.add(`${again.provider.origin}/auth/revoke`);
      should(await again.service.signOut('linear')).deepEqual({ component: 'linear', removed: true, revoked: false });
      should(again.secrets.entries.size).equal(0);
    });

    it('should answer honestly for a component that was never signed in', async () => {
      // Arrange
      const w = world();

      // Act / Assert
      should(await w.service.signOut('linear')).deepEqual({ component: 'linear', removed: false, revoked: false });
    });

    it('should not claim a revocation when the record has no endpoint or the store holds no token', async () => {
      // Arrange
      const w = world();
      await signIn(w);
      const record = w.state.document.connections.linear;
      if (record === undefined) throw new Error('signed in');
      const { revocationEndpoint: _gone, ...withoutEndpoint } = record;
      w.state.document = { ...w.state.document, connections: { linear: withoutEndpoint } };

      // Act / Assert
      should((await w.service.signOut('linear')).revoked).be.false();

      // Arrange — the record is there, the tokens are not.
      const empty = world();
      await signIn(empty);
      empty.secrets.entries.clear();
      empty.internal.entries.clear();
      should(await empty.service.signOut('linear')).deepEqual({ component: 'linear', removed: true, revoked: false });
    });
  });

  it('should cancel a flow and say whether there was one', async () => {
    // Arrange
    const w = world();
    const flow = await w.service.start('linear', {});

    // Act / Assert
    should(w.service.cancel(flow.flowId)).deepEqual({ flowId: flow.flowId, cancelled: true });
    should(w.service.cancel(flow.flowId)).deepEqual({ flowId: flow.flowId, cancelled: false });
  });

  it('should let a failed exclusive step leave later ones working', async () => {
    // Arrange — the state write fails once while filing a registration.
    const w = world();
    const original = w.state.write.bind(w.state);
    let failures = 1;
    w.state.write = async document => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('disk full');
      }
      await original(document);
    };

    // Act
    await should(w.service.start('linear', {})).be.rejectedWith('disk full');
    const flow = await w.service.start('linear', {});

    // Assert
    should(flow.mode).equal('paste');
  });
});

describe('McpOAuthService — review hardening', () => {
  it('H1: binds a token to its server, so a moved component names a secret nobody holds and nothing is sent', async () => {
    // Arrange
    const w = world({ expiresIn: 10 });
    await signIn(w);
    const moved = `${w.provider.origin}/elsewhere/mcp`;
    w.servers = [{ component: 'linear', url: moved, auth: 'oauth' }];
    const movedNames = mcpOAuthSecretNames('linear', moved);
    w.clock.at += 20_000;

    // Act — a launch of the moved component asks for ITS names, which the store does not hold.
    await w.service.refreshForLaunch([movedNames.access]);
    const [connection] = await w.service.connections();

    // Assert
    should(movedNames.access).not.equal(NAMES.access);
    should(w.secrets.entries.has(movedNames.access)).be.false();
    should(w.provider.tokenRequests).have.length(1);
    should(connection).containEql({ state: 'needs-sign-in', secrets: [] });
  });

  it('H1: a sign-in at the new address removes the old address’s tokens', async () => {
    // Arrange
    const w = world();
    await signIn(w);
    const moved = `${w.provider.origin}/mcp/v2`;
    w.servers = [{ component: 'linear', url: moved, auth: 'oauth' }];

    // Act
    const flow = await w.service.start('linear', { redirectUri: PWA_REDIRECT });
    await w.service.complete(flow.flowId, { callback: await w.provider.approve(flow.authorizeUrl) });

    // Assert
    const now = mcpOAuthSecretNames('linear', moved);
    should([...w.secrets.entries.keys()]).deepEqual([now.access]);
    should([...w.internal.entries.keys()]).deepEqual([now.refresh]);
  });

  it('M1: a code arriving at another provider’s callback path cannot finish this flow', async () => {
    // Arrange
    const w = world();
    const flow = await w.service.start('linear', { redirectUri: PWA_REDIRECT });
    const callback = new URL(await w.provider.approve(flow.authorizeUrl));
    callback.pathname = mcpOAuthRedirectPath('https://attacker.example');

    // Act / Assert
    await refusedWith(w.service.complete(flow.flowId, { callback: callback.toString() }), 'mcp_auth_callback');
  });

  it('M1: requires iss when the provider says it sends one, and accepts its absence when it does not', async () => {
    // Arrange
    const strict = world({ issParameterSupported: true, omitIss: true });
    const lax = world({ omitIss: true });

    // Act
    const strictFlow = await strict.service.start('linear', { redirectUri: PWA_REDIRECT });
    const message = await refusedWith(
      strict.service.complete(strictFlow.flowId, { callback: await strict.provider.approve(strictFlow.authorizeUrl) }),
      'mcp_auth_callback',
    );
    const { completion } = await signIn(lax);

    // Assert
    should(message).match(/does not say which sign-in provider/u);
    should(completion.connection.state).equal('signed-in');
  });

  it('M2: refuses to sign in to a server reached over plain HTTP on another host', async () => {
    // Arrange
    const w = world();
    w.servers = [{ component: 'linear', url: 'http://mcp.example.com/mcp', auth: 'oauth' }];

    // Act / Assert
    await refusedWith(w.service.start('linear', {}), 'mcp_auth_insecure_server');
    should(w.http.requests).have.length(0);
  });

  it('M5: concurrent launches spend the refresh token once', async () => {
    // Arrange
    const w = world({ expiresIn: 120 });
    await signIn(w);
    w.clock.at += 100_000;

    // Act
    await Promise.all(Array.from({ length: 5 }, () => w.service.refreshForLaunch([NAMES.access])));
    await w.service.refreshForLaunch([NAMES.access]);

    // Assert — one refresh, and the later launch saw the fresh expiry and left it alone.
    should(w.provider.tokenRequests.filter(form => form.get('grant_type') === 'refresh_token')).have.length(1);
    should(w.state.document.connections.linear?.needsSignIn).be.undefined();
  });

  it('L3: keeps at most four registrations per component, forgetting the oldest', async () => {
    // Arrange
    const w = world();

    // Act
    for (let index = 0; index < 6; index += 1)
      await w.service.start('linear', { redirectUri: `https://pwa-${String(index)}.example/oauth/mcp-callback` });

    // Assert
    const held = w.state.document.registrations.linear ?? [];
    should(held).have.length(MAX_REGISTRATIONS_PER_COMPONENT);
    should(held[0]?.redirectUri.startsWith('https://pwa-2.example/')).be.true();
  });

  it('L3: forgets a dropped registration’s client secret with it', async () => {
    // Arrange
    const w = world({ confidential: true });

    // Act
    for (let index = 0; index < 5; index += 1)
      await w.service.start('linear', { redirectUri: `https://pwa-${String(index)}.example/oauth/mcp-callback` });

    // Assert
    should(w.internal.entries.size).equal(MAX_REGISTRATIONS_PER_COMPONENT);
    should([...w.internal.entries.values()]).not.containEql(w.provider.issued[0]);
  });

  it('L4: reuses one loopback registration per provider rather than drawing a new port each time', async () => {
    // Arrange
    const w = world();

    // Act
    const first = await w.service.start('linear', {});
    const second = await w.service.start('linear', {});

    // Assert
    should(second.redirectUri).equal(first.redirectUri);
    should(w.provider.registrations).have.length(1);
  });

  it('L5: names the host the sign-in page is actually on', async () => {
    // Arrange — the metadata puts the authorization page on another host than the issuer.
    const w = world();
    const original = w.provider.handle;
    (w.http as unknown as { handler: (request: Request) => Promise<Response> }).handler = async request => {
      const response = await original(request);
      if (!new URL(request.url).pathname.startsWith('/.well-known/oauth-authorization-server')) return response;
      const body = (await response.json()) as Record<string, unknown>;
      return new Response(JSON.stringify({ ...body, authorization_endpoint: 'https://login.other.example/authorize' }));
    };

    // Act
    const flow = await w.service.start('linear', {});

    // Assert
    should(flow.issuer).equal('login.other.example');
  });

  it('L7: re-checks a stored endpoint before sending a refresh token or revoking', async () => {
    // Arrange — somebody edited the state file to point both endpoints elsewhere.
    const w = world({ expiresIn: 10 });
    await signIn(w);
    const record = w.state.document.connections.linear;
    if (record === undefined) throw new Error('signed in');
    w.state.document = {
      ...w.state.document,
      connections: {
        linear: {
          ...record,
          tokenEndpoint: 'http://evil.example/token',
          revocationEndpoint: 'http://evil.example/revoke',
        },
      },
    };
    w.clock.at += 20_000;
    const before = w.http.requests.length;

    // Act
    await w.service.refreshForLaunch([NAMES.access]);
    const marked = w.state.document.connections.linear?.needsSignIn;
    const signedOut = await w.service.signOut('linear');

    // Assert
    should(marked).be.true();
    should(signedOut.revoked).be.false();
    should(w.http.requests.length).equal(before);
  });
});

describe('McpOAuthService — review round 2', () => {
  /**
   * Holds the provider's answer to the next refresh until the test lets it go, so something else can
   * happen while the refresh is in flight — the race, made deterministic.
   */
  function holdRefresh(w: ReturnType<typeof world>) {
    let release: () => void = () => undefined;
    let arrived: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const seen = new Promise<void>(resolve => {
      arrived = resolve;
    });
    const original = w.provider.handle;
    (w.http as unknown as { handler: (request: Request) => Promise<Response> }).handler = async request => {
      const isRefresh =
        new URL(request.url).pathname === '/auth/token' && (await request.clone().text()).includes('refresh_token');
      const response = await original(request);
      if (isRefresh) {
        arrived();
        await gate;
      }
      return response;
    };
    return { release, seen };
  }

  it('M-A: a sign-out while a refresh is in flight stays signed out, and the late tokens are revoked', async () => {
    // Arrange
    const w = world({ expiresIn: 10 });
    await signIn(w);
    w.clock.at += 20_000;
    const held = holdRefresh(w);

    // Act — the refresh is at the provider; the person signs out; then the answer lands.
    const refreshing = w.service.refreshForLaunch([NAMES.access]);
    await held.seen;
    const signedOut = await w.service.signOut('linear');
    held.release();
    await refreshing;

    // Assert — nothing came back, and the rotated refresh token issued mid-sign-out was revoked.
    should(signedOut.removed).be.true();
    should(w.secrets.entries.size).equal(0);
    should(w.internal.entries.size).equal(0);
    should(w.state.document.connections).deepEqual({});
    should(w.provider.revoked).containEql(w.provider.issued[3]);
    should((await w.service.connections())[0]?.state).equal('needs-sign-in');
  });

  it('L-A: an old-address refresh landing after a sign-in at a new address leaves the new one alone', async () => {
    // Arrange
    const w = world({ expiresIn: 10 });
    await signIn(w);
    w.clock.at += 20_000;
    const held = holdRefresh(w);
    const refreshing = w.service.refreshForLaunch([NAMES.access]);
    await held.seen;

    // Act — the component moves and is signed in again while the old refresh is in flight.
    const moved = `${w.provider.origin}/mcp/v2`;
    w.servers = [{ component: 'linear', url: moved, auth: 'oauth' }];
    (w.http as unknown as { handler: (request: Request) => Promise<Response> }).handler = w.provider.handle;
    const flow = await w.service.start('linear', { redirectUri: PWA_REDIRECT });
    await w.service.complete(flow.flowId, { callback: await w.provider.approve(flow.authorizeUrl) });
    const fresh = w.state.document.connections.linear;
    held.release();
    await refreshing;

    // Assert — the new record is untouched and the old address's token was not re-filed.
    should(w.state.document.connections.linear).deepEqual(fresh);
    should([...w.secrets.entries.keys()]).deepEqual([mcpOAuthSecretNames('linear', moved).access]);
  });

  it('L-B: the registration cap never evicts the registration the live sign-in refreshes through', async () => {
    // Arrange — a confidential client, signed in through the first registration.
    const w = world({ confidential: true, expiresIn: 10 });
    await signIn(w);
    const liveSecret = w.provider.issued[0];

    // Act — five more registrations from other PWA origins, then a refresh.
    for (let index = 0; index < 5; index += 1)
      await w.service.start('linear', { redirectUri: `https://pwa-${String(index)}.example/oauth/mcp-callback` });
    w.clock.at += 20_000;
    await w.service.refreshForLaunch([NAMES.access]);

    // Assert
    const held = w.state.document.registrations.linear ?? [];
    should(held).have.length(MAX_REGISTRATIONS_PER_COMPONENT);
    should(held.map(entry => entry.redirectUri)).containEql(w.state.document.connections.linear?.redirectUri);
    should([...w.internal.entries.values()]).containEql(liveSecret);
    const refresh = w.provider.tokenRequests.find(form => form.get('grant_type') === 'refresh_token');
    should(refresh?.get('client_secret')).equal(liveSecret);
  });

  it('should still sign out, claiming no revocation, when the internal store cannot be opened', async () => {
    // Arrange
    const w = world();
    await signIn(w);
    w.internal.values = async () => {
      throw new Error('damaged');
    };

    // Act / Assert
    should(await w.service.signOut('linear')).deepEqual({ component: 'linear', removed: true, revoked: false });
    should(w.secrets.entries.size).equal(0);
  });
});

describe('McpOAuthService — registering the way real clients do', () => {
  /** A registration request's metadata, by position. */
  const registered = (w: ReturnType<typeof world>, index: number) => w.provider.registrationRequests[index] ?? {};

  it('should first ask for exactly what Claude Code asks for, the server’s scope included', async () => {
    // Arrange
    const w = world();

    // Act
    await w.service.start('linear', { redirectUri: PWA_REDIRECT });

    // Assert
    should(w.provider.registrationRequests).have.length(1);
    should(registered(w, 0)).deepEqual({
      client_name: 'Ferretry',
      redirect_uris: [FLOW_REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'mcp:tools',
    });
  });

  it('should retry with a localhost address after any 4xx to the PWA’s, and finish by paste', async () => {
    // Arrange — a provider that refuses the PWA's address without saying it is the address.
    const w = world({
      refuseRegistration: metadata =>
        String((metadata.redirect_uris as string[])[0]).startsWith('https://') ? { status: 403 } : undefined,
    });

    // Act
    const flow = await w.service.start('linear', { redirectUri: PWA_REDIRECT });
    const completion = await w.service.complete(flow.flowId, { callback: await w.provider.approve(flow.authorizeUrl) });

    // Assert
    should(flow.mode).equal('paste');
    should(flow.redirectUri).match(LOOPBACK);
    should(flow.note).match(/paste an address/u);
    should(w.provider.registrationRequests).have.length(2);
    should(completion.connection.state).equal('signed-in');
  });

  it('should register with client_secret_post when the provider will not take a public client, and send the secret in the form', async () => {
    // Arrange
    const w = world({
      refuseRegistration: metadata =>
        metadata.token_endpoint_auth_method === 'none'
          ? {
              status: 400,
              error: 'invalid_client_metadata',
              error_description: 'token_endpoint_auth_method none is not supported',
            }
          : undefined,
    });

    // Act
    const { completion } = await signIn(w);

    // Assert
    should(registered(w, 1)).containEql({ token_endpoint_auth_method: 'client_secret_post' });
    should(completion.connection.state).equal('signed-in');
    const secret = w.provider.registrations[0]?.secret as string;
    should(w.provider.tokenRequests[0]?.get('client_secret')).equal(secret);
    should(w.provider.tokenAuthorizations[0]).be.undefined();
    should(w.state.document.registrations.linear?.[0]).not.have.property('tokenAuth');
    should(leaks(w.provider, w.state.document, completion)).be.empty();
  });

  it('should fall through to client_secret_basic, and send the secret as a Basic credential on every request', async () => {
    // Arrange — public and form-posted secrets are both refused.
    const w = world({
      expiresIn: 10,
      refuseRegistration: metadata =>
        metadata.token_endpoint_auth_method === 'client_secret_basic'
          ? undefined
          : { status: 400, error: 'invalid_client_metadata', error_description: 'unsupported auth method' },
    });

    // Act
    const { completion } = await signIn(w);
    w.clock.at += 60_000;
    await w.service.refreshForLaunch([NAMES.access]);

    // Assert
    should(w.provider.registrationRequests.map(metadata => metadata.token_endpoint_auth_method)).deepEqual([
      'none',
      'client_secret_post',
      'client_secret_basic',
    ]);
    should(completion.connection.state).equal('signed-in');
    should(w.provider.tokenRequests).have.length(2);
    for (const [index, form] of w.provider.tokenRequests.entries()) {
      should(form.has('client_secret')).be.false();
      should(w.provider.tokenAuthorizations[index]).startWith('Basic ');
    }
    should(w.state.document.connections.linear).containEql({ tokenAuth: 'client_secret_basic' });
    should(leaks(w.provider, w.state.document, completion)).be.empty();
  });

  it('should start with the client authentication the provider advertises when it takes no public clients', async () => {
    // Arrange
    const w = world({ tokenAuthMethods: ['client_secret_basic'] });

    // Act
    await signIn(w);

    // Assert
    should(w.provider.registrationRequests).have.length(1);
    should(registered(w, 0)).containEql({ token_endpoint_auth_method: 'client_secret_basic' });
    should(w.provider.tokenAuthorizations[0]).startWith('Basic ');
  });

  it('should leave the optional fields out when the provider objects to one', async () => {
    // Arrange
    const w = world({
      refuseRegistration: metadata =>
        metadata.scope === undefined
          ? undefined
          : { status: 400, error: 'invalid_client_metadata', error_description: 'scope mcp:tools is not allowed' },
    });

    // Act
    const flow = await w.service.start('linear', { redirectUri: PWA_REDIRECT });

    // Assert
    should(flow.mode).equal('pwa');
    should(registered(w, 1)).deepEqual({ client_name: 'Ferretry', redirect_uris: [FLOW_REDIRECT] });
  });

  it('should stop after a few tries however the provider answers, and list every way it asked', async () => {
    // Arrange — every request is refused with a reason that invites another auth method.
    const w = world({
      refuseRegistration: () => ({
        status: 400,
        error: 'invalid_client_metadata',
        error_description: 'bad auth method',
      }),
    });

    // Act
    const message = await refusedWith(
      w.service.start('linear', { redirectUri: PWA_REDIRECT }),
      'mcp_auth_registration',
    );

    // Assert
    should(w.provider.registrationRequests).have.length(4);
    should(message).containEql(
      'Tried 4 ways: the Ferretry page; the Ferretry page, client_secret_post; the Ferretry page, client_secret_basic; a localhost address, client_secret_basic.',
    );
  });

  it('should not retry a provider that failed (5xx), and say it failed rather than refused', async () => {
    // Arrange
    const w = world({ refuseRegistration: () => ({ status: 503, error: 'temporarily_unavailable' }) });

    // Act
    const message = await refusedWith(w.service.start('linear', {}), 'mcp_auth_registration');

    // Assert
    should(w.provider.registrationRequests).have.length(1);
    should(message).startWith('The sign-in provider failed while registering Ferretry: temporarily_unavailable.');
  });

  it('should mask a credential-shaped value a provider put in its description', async () => {
    // Arrange
    const w = world({
      refuseRegistration: () => ({
        status: 401,
        error: 'invalid_token',
        error_description: 'initial access token required, got token=abc123 eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9xyz1',
      }),
    });

    // Act
    const message = await refusedWith(w.service.start('linear', {}), 'mcp_auth_registration');

    // Assert
    should(message).containEql(
      'invalid_token — initial access token required, got token=[redacted] [redacted]. 127.0.0.1:4100 answered HTTP 401',
    );
    should(message).not.containEql('abc123');
  });
});

describe('McpOAuthService — a client registered by hand', () => {
  const HAND_SECRET = 'hand-secret-0123456789';

  function handWorld(client: { clientSecret?: string; callbackPort?: number }) {
    const w = world({ noRegistration: true });
    w.servers = [
      {
        component: 'linear',
        url: w.provider.serverUrl,
        auth: 'oauth',
        client: { clientId: 'hand-1', ...client },
      },
    ];
    return w;
  }

  it('should register nothing, return to its localhost callback port, and send its configured secret', async () => {
    // Arrange
    const w = handWorld({ clientSecret: 'LINEAR_CLIENT_SECRET', callbackPort: 8123 });
    await w.secrets.put('LINEAR_CLIENT_SECRET', HAND_SECRET);
    w.provider.preRegister('hand-1', ['http://localhost:8123/callback'], HAND_SECRET);

    // Act
    const flow = await w.service.start('linear', { redirectUri: PWA_REDIRECT });
    const completion = await w.service.complete(flow.flowId, { callback: await w.provider.approve(flow.authorizeUrl) });

    // Assert
    should(w.provider.registrationRequests).have.length(0);
    should(flow).containEql({ mode: 'paste', redirectUri: 'http://localhost:8123/callback' });
    should(flow.note).match(/registered with its provider by hand/u);
    should(new URL(flow.authorizeUrl).searchParams.get('client_id')).equal('hand-1');
    should(completion.connection.state).equal('signed-in');
    should(w.provider.tokenRequests[0]?.get('client_secret')).equal(HAND_SECRET);
    should(w.state.document.connections.linear).containEql({ clientSecretRef: 'LINEAR_CLIENT_SECRET' });
    should(JSON.stringify(w.state.document)).not.containEql(HAND_SECRET);
  });

  it('should leave the person’s own client secret in the store at sign-out', async () => {
    // Arrange
    const w = handWorld({ clientSecret: 'LINEAR_CLIENT_SECRET', callbackPort: 8123 });
    await w.secrets.put('LINEAR_CLIENT_SECRET', HAND_SECRET);
    w.provider.preRegister('hand-1', ['http://localhost:8123/callback'], HAND_SECRET);
    const flow = await w.service.start('linear', {});
    await w.service.complete(flow.flowId, { callback: await w.provider.approve(flow.authorizeUrl) });

    // Act
    await w.service.signOut('linear');

    // Assert
    should(w.secrets.entries.has(NAMES.access)).be.false();
    should(w.secrets.entries.get('LINEAR_CLIENT_SECRET')).equal(HAND_SECRET);
  });

  it('should say a configured secret the store does not hold before sending anyone anywhere', async () => {
    // Arrange
    const w = handWorld({ clientSecret: 'LINEAR_CLIENT_SECRET' });

    // Act
    const message = await refusedWith(w.service.start('linear', {}), 'mcp_auth_registration');

    // Assert
    should(message).containEql(`\${secret:LINEAR_CLIENT_SECRET}`);
    should(message).containEql('Settings → Secrets');
  });

  it('should use a fresh localhost port for a public client registered without one', async () => {
    // Arrange
    const w = handWorld({});

    // Act
    const flow = await w.service.start('linear', {});

    // Assert
    should(flow.mode).equal('paste');
    should(flow.redirectUri).match(LOOPBACK);
    should(flow).not.have.property('note');
  });

  it('should tell a provider without registration that a client id is the way in', async () => {
    // Arrange
    const w = world({ noRegistration: true });

    // Act
    const message = await refusedWith(w.service.start('linear', {}), 'mcp_auth_registration');

    // Assert
    should(message).containEql('client id');
  });
});
