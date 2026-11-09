import { describe, expect, test } from 'bun:test';
import { SignInReach } from '../../daemon/lib/reach.ts';
import { EMPTY_MCP_OAUTH_STATE } from '../../daemon/lib/oauth/service.ts';
import type { McpOAuthRecord, McpOAuthServer, McpOAuthStateDocument } from '../../daemon/lib/oauth/ports.ts';

const TTL = 1000;

function reach() {
  const clock = {
    at: 5000,
    now(): number {
      return this.at;
    },
  };
  return { clock, reach: new SignInReach(clock, TTL) };
}

const record = (over: Partial<McpOAuthRecord> = {}): McpOAuthRecord => ({
  serverUrl: 'https://mcp.example.test/mcp',
  issuer: 'https://auth.example.test',
  redirectUri: 'https://app.example.test/oauth/mcp-callback',
  tokenEndpoint: 'https://token.example.test/token',
  revocationEndpoint: 'https://token.example.test/revoke',
  clientId: 'c',
  hasClientSecret: false,
  resource: 'https://mcp.example.test/mcp',
  signedInAt: '2026-11-09T00:00:00.000Z',
  renewable: true,
  ...over,
});

describe('the sign-in reach', () => {
  test('answers nothing until something names a host', () => {
    expect(reach().reach.hosts()).toEqual([]);
  });

  test('the servers that may sign in are named by their listing, and only those with a web address and oauth', async () => {
    const { reach: r } = reach();
    const listed: McpOAuthServer[] = [
      { component: 'a', url: 'https://A.example.test:8443/mcp', auth: 'oauth' },
      { component: 'b', url: 'https://plain.example.test/mcp' },
      { component: 'c', auth: 'oauth' },
      { component: 'd', url: 'not a url', auth: 'oauth' },
    ];
    const servers = r.observeServers({ list: async () => listed, missing: async name => `no ${name}` });
    expect(await servers.list()).toEqual(listed);
    expect(r.hosts()).toEqual(['a.example.test:8443']);
    expect(await servers.missing?.('x')).toBe('no x');
    // The list is replaced, not grown: a server taken out of the configuration is no longer reachable.
    listed.length = 0;
    await servers.list();
    expect(r.hosts()).toEqual([]);
  });

  test('the providers of recorded sign-ins are named by the state document, read or written', async () => {
    const { reach: r } = reach();
    let held: McpOAuthStateDocument = { ...EMPTY_MCP_OAUTH_STATE, connections: { linear: record() } };
    const store = r.observeState({
      read: async () => held,
      write: async document => {
        held = document;
      },
    });
    expect(await store.read()).toBe(held);
    expect(r.hosts()).toEqual(['auth.example.test', 'token.example.test']);
    await store.write({ ...EMPTY_MCP_OAUTH_STATE, connections: { linear: record({ revocationEndpoint: undefined }) } });
    expect(r.hosts()).toEqual(['auth.example.test', 'token.example.test']);
    await store.write(EMPTY_MCP_OAUTH_STATE);
    expect(r.hosts()).toEqual([]);
    // An address that is not one names nothing.
    await store.write({
      ...EMPTY_MCP_OAUTH_STATE,
      connections: { linear: record({ tokenEndpoint: 'nope', revocationEndpoint: 'nope' }) },
    });
    expect(r.hosts()).toEqual(['auth.example.test']);
  });

  test('a discovered host lasts for the time to live, and not a millisecond longer', () => {
    const { clock, reach: r } = reach();
    r.discovered('linear', 'https://token.example.test/token');
    expect(r.hosts()).toEqual(['token.example.test']);
    clock.at += TTL - 1;
    expect(r.hosts()).toEqual(['token.example.test']);
    clock.at += 1;
    expect(r.hosts()).toEqual([]);
  });

  test('a flow ending takes its hosts and nobody else’s', () => {
    const { reach: r } = reach();
    r.discovered('one', 'https://one.example.test/x');
    r.discovered('two', 'https://two.example.test/x');
    r.release('one');
    expect(r.hosts()).toEqual(['two.example.test']);
    r.release('absent');
    expect(r.hosts()).toEqual(['two.example.test']);
  });

  test('an address that is not one is never recorded, and an expired flow makes room', () => {
    const { clock, reach: r } = reach();
    r.discovered('one', 'not a url');
    expect(r.hosts()).toEqual([]);
    r.discovered('one', 'https://one.example.test');
    clock.at += TTL;
    r.discovered('two', 'https://two.example.test');
    expect(r.hosts()).toEqual(['two.example.test']);
  });

  test('a flow names a bounded number of hosts and only a bounded number of flows discover at once', () => {
    const { reach: r } = reach();
    for (let index = 0; index < 20; index += 1) r.discovered('one', `https://h${String(index)}.example.test`);
    expect(r.hosts().length).toBe(8);
    for (let index = 0; index < 20; index += 1)
      r.discovered(`flow${String(index)}`, `https://f${String(index)}.example.test`);
    expect(r.hosts().length).toBeLessThanOrEqual(16 * 8);
    expect(r.hosts()).not.toContain('h0.example.test');
    expect(r.hosts()).toContain('f19.example.test');
  });
});
