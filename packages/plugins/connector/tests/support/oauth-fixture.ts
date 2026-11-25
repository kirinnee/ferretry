import {
  ConnectorAuthority,
  type AuthorizeInput,
  type ExchangeInput,
  type RegisterInput,
} from '../../daemon/lib/oauth/authority.ts';
import { ConnectorStateFileSchema, type ConnectorState } from '../../contract/index.ts';
import { ConnectorMemory, type ConnectorStore, base64url } from '../../daemon/lib/oauth/model.ts';
import { ConnectorRateLimiter } from '../../daemon/lib/oauth/rate-limiter.ts';
import type { ConnectorAuditEvent, ConnectorEndpoints } from '../../daemon/lib/ports.ts';

export const endpoints: ConnectorEndpoints = {
  issuer: 'https://connector.example',
  resource: 'https://connector.example/mcp',
  resourceMetadataUrl: 'https://connector.example/.well-known/oauth-protected-resource/mcp',
  appOrigin: 'https://app.example',
  daemonId: 'daemon-fixture',
};
export const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
export const verifier = 'v'.repeat(43);

export function fixture() {
  let time = Date.parse('2026-11-24T10:00:00.000Z');
  let count = 1234567;
  let state: ConnectorState = { format: 1, clients: [], grants: [] };
  let saves = 0;
  let broken = false;
  const clock = { now: () => time };
  const cryptoPort = {
    randomBytes: (length: number) =>
      Uint8Array.from({ length }, () => {
        count = (Math.imul(count, 1664525) + 1013904223) >>> 0;
        return count >>> 24;
      }),
    sha256: async (text: string) =>
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))),
  };
  const store: ConnectorStore = {
    load: async () => {
      if (broken) throw new Error('damaged');
      return structuredClone(state);
    },
    save: async value => {
      if (broken) throw new Error('damaged');
      state = ConnectorStateFileSchema.parse(value);
      saves++;
    },
  };
  const events: ConnectorAuditEvent[] = [];
  const memory = new ConnectorMemory();
  const limiter = new ConnectorRateLimiter(clock);
  const options = {
    clock,
    crypto: cryptoPort,
    store,
    audit: {
      record: async (event: ConnectorAuditEvent) => {
        events.push(event);
      },
    },
    endpoints,
    allowedRedirectUris: [redirectUri, `${redirectUri}?existing=1`],
    memory,
    limiter,
  };
  const authority = new ConnectorAuthority(options);

  const register = (input: Partial<RegisterInput> = {}) =>
    authority.register({ redirect_uris: [redirectUri], ...input });
  const authorize = async (clientId: string, input: Partial<AuthorizeInput> = {}) => {
    const challenge = base64url(await cryptoPort.sha256(verifier));
    const location = await authority.startAuthorization({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge_method: 'S256',
      code_challenge: challenge,
      ...input,
    });
    return new URL(location).searchParams.get('h') ?? '';
  };
  const approved = async (input: Partial<RegisterInput> = {}, auth: Partial<AuthorizeInput> = {}) => {
    const client = await register(input);
    const handle = await authorize(client.client_id, auth);
    const pending = (await authority.pending())[0];
    if (!pending) throw new Error('missing request');
    const approval = await authority.approve(pending.id, 'admin-cli');
    if (!approval.ok) throw new Error('approval failed');
    const answer = await authority.waitPage(handle);
    if (answer.kind !== 'redirect') throw new Error('missing redirect');
    const code = new URL(answer.location).searchParams.get('code') ?? '';
    const exchange: ExchangeInput = {
      grant_type: 'authorization_code',
      client_id: client.client_id,
      code,
      code_verifier: verifier,
      redirect_uri: auth.redirect_uri ?? redirectUri,
      client_secret: client.client_secret,
    };
    return { client, handle, code, grant: approval.value, exchange };
  };
  const flow = async () => {
    const result = await approved();
    return { ...result, tokens: await authority.exchange(result.exchange) };
  };
  return {
    authority,
    options,
    register,
    authorize,
    approved,
    flow,
    store,
    memory,
    limiter,
    events,
    state: () => structuredClone(state),
    saves: () => saves,
    breakStore: () => {
      broken = true;
    },
    advance: (ms: number) => {
      time += ms;
    },
  };
}
