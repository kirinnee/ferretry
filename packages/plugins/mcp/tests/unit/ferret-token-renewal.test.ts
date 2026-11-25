import { describe, expect, test } from 'bun:test';
import type { SecretName } from '@ferretry/core-vault/contract';
import type { RuntimeId } from '@ferretry/plugin-runtimes/contract';
import { type McpItem, mcpOAuthSecretNames } from '../../contract/index.ts';
import { FerretMcpTokens } from '../../daemon/features/token/service.ts';
import { McpLaunchParts } from '../../daemon/lib/launch-parts.ts';
import { PWA_REDIRECT, world, type World } from './oauth/support.ts';

/**
 * THE TOKEN ROUTE STARTS NO PROVIDER WORK UNTIL IT KNOWS THE BINDING: a request for a variable this ferret's launch does
 * not hold is a 404 that the fake provider never hears of, and a request for one it does hold renews exactly that one
 * sign-in. Real sign-in service, fake provider, fake tokens.
 */
const SERVER = 'http://127.0.0.1:4100/mcp';
const NAMES = mcpOAuthSecretNames('linear', SERVER);
const OTHER = mcpOAuthSecretNames('other', 'https://other.example.test/mcp');
const ITEMS: ReadonlyMap<string, McpItem> = new Map<string, McpItem>([['linear', { url: SERVER, auth: 'oauth' }]]);
const FERRET = {
  id: 'f1',
  harness: 'claude-code' as const,
  folder: '/work/app',
  runtime: 'claude-default' as RuntimeId,
};

async function due(): Promise<{ w: World; tokens: FerretMcpTokens; projectRenewals: boolean[] }> {
  const w = world({ expiresIn: 10 });
  const flow = await w.service.start('linear', { redirectUri: PWA_REDIRECT });
  await w.service.complete(flow.flowId, { callback: await w.provider.approve(flow.authorizeUrl) });
  w.clock.at += 60_000;
  const projectRenewals: boolean[] = [];
  const launch = new McpLaunchParts({
    client: 'fy',
    items: () => ITEMS,
    held: async () => new Set(w.secrets.entries.keys()),
    renewal: w.service,
    mcpFormat: () => 'json',
    layered: async () => new Set(ITEMS.keys()),
    project: async (_spec, options) => {
      projectRenewals.push(options?.renew !== false);
      return { root: '', servers: {}, env: {} };
    },
  });
  const tokens = new FerretMcpTokens({
    now: () => w.clock.at,
    ferret: async id => (id === FERRET.id ? FERRET : undefined),
    bindings: async subject => await launch.bindings(subject),
    renew: async name => await w.service.refreshForLaunch([name]),
    signInRequired: async name => await w.service.signInRequired(name),
    value: async name => w.secrets.entries.get(name),
  });
  return { w, tokens, projectRenewals };
}

describe('the token route and the provider', () => {
  test('a variable this ferret does not hold: 404, and the fake provider saw ZERO calls', async () => {
    const { w, tokens, projectRenewals } = await due();
    const before = { token: w.provider.tokenRequests.length, requests: w.http.requests.length };

    await expect(tokens.headers('f1', OTHER.variable)).rejects.toMatchObject({
      status: 404,
      code: 'not_this_ferrets_server',
    });

    expect(w.provider.tokenRequests).toHaveLength(before.token);
    expect(w.http.requests.length).toBe(before.requests);
    expect(projectRenewals).toEqual([false]);
  });

  test('a variable it does hold renews exactly that one sign-in (one refresh grant) and answers the renewed token', async () => {
    const { w, tokens } = await due();
    const before = w.provider.tokenRequests.length;

    const answer = await tokens.headers('f1', NAMES.variable);

    expect(w.provider.tokenRequests).toHaveLength(before + 1);
    expect(w.provider.tokenRequests.at(-1)?.get('grant_type')).toBe('refresh_token');
    expect(answer.headers.Authorization).toBe(`Bearer ${w.secrets.entries.get(NAMES.access as SecretName)}`);
    expect(w.provider.issued).toContain(answer.headers.Authorization.replace(/^Bearer /u, ''));
  });
});
