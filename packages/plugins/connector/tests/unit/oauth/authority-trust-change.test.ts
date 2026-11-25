import { describe, expect, test } from 'bun:test';
import { ConnectorAuthority } from '../../../daemon/lib/oauth/authority.ts';
import { base64url } from '../../../daemon/lib/oauth/model.ts';
import type { ConnectorEndpoints } from '../../../daemon/lib/ports.ts';
import { endpoints, fixture, verifier } from '../../support/oauth-fixture.ts';

/** A callback only the owner's configuration allows, so a live config edit can take it away. */
const extraCallback = 'https://callback.example/cb';

/**
 * Trust can change while a sign-in is in flight: an edit to `extraRedirectUris` and a new origin (the tunnel
 * re-provisioned, a new `publicUrl`) both apply live. A sign-in or a code is good only for the origin and callback
 * it was issued under, and the CURRENT policy is enforced again when it continues and when it is redeemed.
 */
function world() {
  const f = fixture();
  const live = { issuer: endpoints.issuer, resource: endpoints.resource, extra: [extraCallback] };
  const moving: ConnectorEndpoints = {
    ...endpoints,
    get issuer() {
      return live.issuer;
    },
    get resource() {
      return live.resource;
    },
    get resourceMetadataUrl() {
      return `${live.issuer}/.well-known/oauth-protected-resource/mcp`;
    },
  };
  const authority = new ConnectorAuthority({
    ...f.options,
    endpoints: moving,
    get allowedRedirectUris() {
      return live.extra;
    },
  });
  const start = async () => {
    const client = await authority.register({ redirect_uris: [extraCallback] });
    const challenge = base64url(await f.options.crypto.sha256(verifier));
    const location = await authority.startAuthorization({
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: extraCallback,
      code_challenge_method: 'S256',
      code_challenge: challenge,
    });
    const handle = new URL(location).searchParams.get('h') ?? '';
    return { client, handle };
  };
  const approve = async () => {
    const pending = (await authority.pending())[0];
    const result = await authority.approve(pending?.id ?? '', 'admin-cli');
    if (!result.ok) throw new Error('approval failed');
  };
  const redeem = (clientId: string, code: string) =>
    authority.exchange({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: extraCallback,
    });
  const codeFor = async (handle: string) => {
    const answer = await authority.waitPage(handle);
    if (answer.kind !== 'redirect') throw new Error('missing redirect');
    return new URL(answer.location).searchParams.get('code') ?? '';
  };
  const noTokens = () =>
    expect(f.state().grants.every(grant => grant.access.length === 0 && grant.refresh.length === 0)).toBe(true);
  const move = () => {
    live.issuer = 'https://moved.example';
    live.resource = 'https://moved.example/mcp';
  };
  return { f, live, authority, start, approve, redeem, codeFor, noTokens, move };
}

describe('connector authority — trust that changes while a sign-in is in flight', () => {
  test('control: with nothing changed the sign-in completes and a token is minted', async () => {
    const w = world();
    const { client, handle } = await w.start();
    await w.approve();
    const tokens = await w.redeem(client.client_id, await w.codeFor(handle));
    expect(tokens.access_token).toMatch(/^fyc_at_/);
  });

  test('a callback removed before the owner approves refuses the pending sign-in and mints no code', async () => {
    const w = world();
    const { handle } = await w.start();
    w.live.extra = [];
    expect(await w.authority.pending()).toEqual([]);
    await expect(w.authority.waitPage(handle)).rejects.toMatchObject({ error: 'invalid_request' });
    expect(w.f.memory.codes.size).toBe(0);
  });

  test('a callback removed after approval refuses the continuation and mints no code', async () => {
    const w = world();
    const { handle } = await w.start();
    await w.approve();
    w.live.extra = [];
    await expect(w.authority.waitPage(handle)).rejects.toMatchObject({ error: 'invalid_request' });
    expect(w.f.memory.codes.size).toBe(0);
  });

  test('a callback removed after the code was minted refuses its redemption and mints nothing', async () => {
    const w = world();
    const { client, handle } = await w.start();
    await w.approve();
    const code = await w.codeFor(handle);
    w.live.extra = [];
    await expect(w.redeem(client.client_id, code)).rejects.toMatchObject({ error: 'invalid_grant' });
    w.noTokens();
  });

  test('an origin that changed refuses a sign-in nobody has approved yet', async () => {
    const w = world();
    const { handle } = await w.start();
    w.move();
    expect(await w.authority.pending()).toEqual([]);
    await expect(w.authority.waitPage(handle)).rejects.toMatchObject({ error: 'invalid_request' });
    expect(w.f.memory.codes.size).toBe(0);
  });

  test('an origin that changed after approval refuses the continuation: no code for the new origin', async () => {
    const w = world();
    const { handle } = await w.start();
    await w.approve();
    w.move();
    await expect(w.authority.waitPage(handle)).rejects.toMatchObject({ error: 'invalid_request' });
    expect(w.f.memory.codes.size).toBe(0);
  });

  test('an origin that changed after the code was minted refuses its redemption: no token for the new origin', async () => {
    const w = world();
    const { client, handle } = await w.start();
    await w.approve();
    const code = await w.codeFor(handle);
    w.move();
    await expect(w.redeem(client.client_id, code)).rejects.toMatchObject({ error: 'invalid_grant' });
    w.noTokens();
  });
});

describe('connector authority — an owner act on a sign-in whose trust changed', () => {
  test('approve and deny answer expired after an origin change, and approve grants nothing', async () => {
    const w = world();
    await w.start();
    const id = (await w.authority.pending())[0]?.id ?? '';
    w.move();
    expect(await w.authority.approve(id, 'admin-cli')).toMatchObject({ ok: false, code: 'expired' });
    expect(await w.authority.deny(id, 'admin-cli')).toMatchObject({ ok: false, code: 'expired' });
    expect(w.f.state().grants).toEqual([]);
  });
});
