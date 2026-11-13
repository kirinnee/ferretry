/**
 * A check through the daemon half as it is wired: the pieces a check needs from the machine are real here, not stubs. A
 * signed-in server is reached with its held access token (the Vault holds it; MCP presents it on one request and never
 * logs it), and a command's own `${HOME}` fills from the machine's home. Fakes only, in memory; the network is the test's.
 */
import { describe, expect, test } from 'bun:test';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { FakeSealedDocuments, FakeVault } from '@ferretry/core-vault/contract/testing';
import { testHost } from '@ferretry/kernel/testing';
import { RuntimeIdSchema, type RuntimeSummary } from '@ferretry/plugin-runtimes/contract';
import { fakeRuntimes } from '@ferretry/plugin-runtimes/contract/testing';
import type { RuntimeHomeReader } from '@ferretry/plugin-runtimes/contract';
import { mcpOAuthSecretNames } from '../../contract/index.ts';
import mcp from '../../daemon/index.ts';

const URL_OF_SERVER = 'https://mcp.example.com/mcp';
const TOKEN = 'tok-held-0123456789';
const RUNTIME: RuntimeSummary = {
  id: RuntimeIdSchema.parse('claude-work'),
  harness: 'claude-code',
  login: 'work',
  profile: 'work',
  agent: false,
  launch: { available: true },
};

const rpc = (id: number | undefined, result: unknown): Response =>
  new Response(id === undefined ? '' : JSON.stringify({ jsonrpc: '2.0', id, result }), {
    status: id === undefined ? 202 : 200,
    headers: { 'content-type': 'application/json' },
  });

/** A home whose `.claude.json` is `document`: the one file the inventory reads of it. */
const reader = (document: unknown): RuntimeHomeReader => ({
  document: async file => (file === '.claude.json' ? JSON.stringify(document) : null),
  skills: async () => [],
  skillManifest: async () => undefined,
  skillTree: async () => undefined,
  skillFile: async () => ({ ok: false, reason: 'unreadable' }),
});

async function world(config: Record<string, unknown>, mcpNames: readonly string[], servers: Record<string, unknown>) {
  const ferrets = new FakeFerrets();
  ferrets.add({ id: ferretId('f1'), folder: '/work/app', runtime: RUNTIME.id });
  const runtimes = fakeRuntimes();
  runtimes.setRuntimes([RUNTIME]);
  runtimes.setProfiles(
    [{ name: 'work', layers: [], etag: 'e1' }],
    [{ runtime: RUNTIME.id, profile: 'work', mcp: mcpNames, skills: [] }],
  );
  runtimes.setHomes(
    [
      {
        id: 'h1',
        harness: 'claude-code',
        runtimes: [RUNTIME.id],
        home: '/fleet/homes/h1',
        wrapper: '/fleet/bin/claude-work',
      },
    ],
    { h1: reader({ mcpServers: servers }) },
  );
  const names = mcpOAuthSecretNames('linear', URL_OF_SERVER);
  const vault = new FakeVault();
  await vault.put(names.access, TOKEN);
  const seen: { url: string; authorization: string | null }[] = [];
  const host = await testHost({
    plugins: [mcp],
    fakes: { ferrets, vault, sealed: new FakeSealedDocuments() },
    uses: { runtimes },
    config,
    vault: { [names.access]: TOKEN },
    fetch: async (url, init) => {
      const headers = new Headers(init?.headers);
      seen.push({ url: url.toString(), authorization: headers.get('authorization') });
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as { id?: number; method?: string }) : {};
      if (init?.method === 'DELETE') return new Response('', { status: 200 });
      if (body.method === 'initialize')
        return rpc(body.id, { protocolVersion: '2025-03-26', serverInfo: { name: 'Linear' } });
      if (body.method === 'tools/list') return rpc(body.id, { tools: [{ name: 'search' }, { name: 'create' }] });
      return rpc(undefined, {});
    },
  });
  return { host, seen };
}

describe('a check presents what the machine holds', () => {
  test('a signed-in server is reached with its held access token, and the answer carries no token', async () => {
    const names = mcpOAuthSecretNames('linear', URL_OF_SERVER);
    const { host, seen } = await world({ mcp: { linear: { url: URL_OF_SERVER, auth: 'oauth' } } }, ['linear'], {
      linear: { type: 'http', url: URL_OF_SERVER, headers: { Authorization: `Bearer \${${names.variable}}` } },
    });
    try {
      const listed = await host.request('GET', '/v1/mcp');
      const id = listed
        .json<{ servers: { id: string; name: string }[] }>()
        .servers.find(row => row.name === 'linear')?.id;
      expect(id).toBeDefined();

      const checked = await host.request('POST', '/v1/mcp/check', { body: { id } });

      expect(checked.status).toBe(200);
      expect(checked.json<{ outcome: string; toolCount?: number }>()).toMatchObject({
        outcome: 'connected',
        toolCount: 2,
      });
      expect(seen.length).toBeGreaterThan(0);
      for (const request of seen.filter(entry => entry.url === URL_OF_SERVER && entry.authorization !== null))
        expect(request.authorization).toBe(`Bearer ${TOKEN}`);
      expect(seen.some(entry => entry.authorization === `Bearer ${TOKEN}`)).toBe(true);
      expect(checked.body).not.toContain(TOKEN);
      expect(JSON.stringify(host.logs)).not.toContain(TOKEN);
    } finally {
      await host.stop();
    }
  });

  test('a command’s own ${HOME} fills from this machine’s home, instead of being reported as not set', async () => {
    const { host } = await world({ mcp: { tool: { command: 'tool' } } }, ['tool'], {
      tool: { command: '${HOME}/bin/tool' },
    });
    try {
      const listed = await host.request('GET', '/v1/mcp');
      const id = listed
        .json<{ servers: { id: string; name: string }[] }>()
        .servers.find(row => row.name === 'tool')?.id;

      const checked = await host.request('POST', '/v1/mcp/check', { body: { id } });

      expect(checked.status).toBe(200);
      // The command cannot start here (no process is run in this test), and the sentence says which command it was.
      expect(checked.json<{ message?: string }>().message).toContain('/home/owner/bin/tool');
      expect(checked.body).not.toContain('Not set for this check');
    } finally {
      await host.stop();
    }
  });
});
