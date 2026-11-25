import { describe, expect, test } from 'bun:test';
import { CONNECTOR_STATE, ConnectorStateFileSchema } from '../../contract/index.ts';
import { fixture } from '../support/oauth-fixture.ts';

/** S6: a token, a code, a client secret and a waiting-page handle exist in the minting response and nowhere else. */
describe('no token anywhere', () => {
  test('after a full sign-in and a rotation, no stored state, event or view holds a raw credential', async () => {
    const f = fixture();
    const flow = await f.flow();
    const rotated = await f.authority.exchange({
      grant_type: 'refresh_token',
      client_id: flow.client.client_id,
      client_secret: flow.client.client_secret,
      refresh_token: flow.tokens.refresh_token ?? '',
    });
    const secrets = [
      flow.tokens.access_token,
      flow.tokens.refresh_token,
      rotated.access_token,
      rotated.refresh_token,
      flow.code,
      flow.handle,
      flow.client.client_secret,
    ].filter((value): value is string => typeof value === 'string' && value !== '');
    expect(secrets.length).toBeGreaterThanOrEqual(6);
    const places = [
      JSON.stringify(f.state()),
      JSON.stringify(f.events),
      JSON.stringify(await f.authority.pending()),
      JSON.stringify(await f.authority.grants()),
    ];
    for (const place of places) for (const secret of secrets) expect(place).not.toContain(secret);
    expect(JSON.stringify(f.state())).not.toContain('fyc_');
  });
});

describe('the connector state file', () => {
  test('is declared 0600, one format, hash-only', () => {
    expect(CONNECTOR_STATE.mode).toBe(0o600);
    expect(CONNECTOR_STATE.format).toBe(1);
    expect(CONNECTOR_STATE.path).toBe('connector.json');
  });

  test('refuses a v4 file (`version`, bare digests) and a field that could hold a raw token', async () => {
    const f = fixture();
    const flow = await f.flow();
    const state = f.state();
    expect(ConnectorStateFileSchema.safeParse(state).success).toBe(true);
    expect(ConnectorStateFileSchema.safeParse({ ...state, format: undefined, version: 1 }).success).toBe(false);
    const grant = state.grants[0];
    expect(grant).toBeDefined();
    const withToken = { ...state, grants: [{ ...grant, accessToken: flow.tokens.access_token }] };
    expect(ConnectorStateFileSchema.safeParse(withToken).success).toBe(false);
    const bare = { ...state, grants: [{ ...grant, usedRefresh: ['a'.repeat(64)] }] };
    expect(ConnectorStateFileSchema.safeParse(bare).success).toBe(false);
  });
});
