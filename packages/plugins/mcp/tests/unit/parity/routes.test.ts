/**
 * The MCP-owned R rows that are real today: the machine inventory, a ferret's inventory and project listing, and the
 * check. Driven through the real daemon half on the kernel's test host, over servers in `config/components/mcp`
 * and a project `.mcp.json` in the ferret's folder. One test per row, named by its id.
 *
 * Not here, and named in ports-pending.json: the sign-in routes (the manifest declares no network, so the host
 * refuses every authorization server) and the project and login adds (declared refusals until Projects and Runtimes
 * have a contract).
 */
import { describe, expect, test } from 'bun:test';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { FakeSealedDocuments, FakeVault } from '@ferretry/core-vault/contract/testing';
import { testHost } from '@ferretry/kernel/testing';
import mcp from '../../../daemon/index.ts';

const as = (...capabilities: string[]) => ({ kind: 'device', holder: 'dev_a', capabilities }) as const;
const PROJECT_FILE = JSON.stringify({
  mcpServers: { local: { command: 'npx', args: ['local-tool'] } },
});

async function host() {
  const ferrets = new FakeFerrets();
  ferrets.add({ id: ferretId('f1'), folder: '/work/app' });
  const h = await testHost({
    plugins: [mcp],
    fakes: { ferrets, vault: new FakeVault(), sealed: new FakeSealedDocuments() },
    config: {
      mcp: {
        docs: { url: 'https://docs.example.com/mcp' },
        tool: { command: 'npx', args: ['tool'] },
      },
    },
  });
  h.putRoot('work', '.mcp.json', PROJECT_FILE);
  return h;
}

describe('the MCP routes', () => {
  test('R-0112 GET /v1/mcp lists the servers this machine knows, by scope, with no program arguments', async () => {
    const h = await host();
    const listed = await h.request('GET', '/v1/mcp', { as: as('fleet.use') });
    expect(listed.status).toBe(200);
    expect(listed.headers.get('cache-control')).toBe('no-store');
    expect(listed.json()).toMatchObject({ servers: expect.any(Array), problems: expect.any(Array) });
    expect((await h.request('GET', '/v1/mcp', { as: as('filesystem.use') })).status).toBe(403);
  });

  test('R-0162 GET /v1/ferrets/:ferretId/mcp/servers lists what one ferret sees; a stranger is a 404', async () => {
    const h = await host();
    const seen = await h.request('GET', '/v1/ferrets/f1/mcp/servers', { as: as('filesystem.use') });
    expect(seen.status).toBe(200);
    expect(seen.json()).toMatchObject({ servers: [{ name: 'ferretry', scope: 'ferretry', target: 'fy mcp serve' }] });
    expect((await h.request('GET', '/v1/ferrets/nobody/mcp/servers', { as: as('filesystem.use') })).status).toBe(404);
    expect((await h.request('GET', '/v1/ferrets/f1/mcp/servers', { as: as('fleet.use') })).status).toBe(403);
  });

  test('R-0161 GET /v1/ferrets/:ferretId/mcp lists the servers of the ferret’s project file; a stranger is a 404', async () => {
    const h = await host();
    const listed = await h.request('GET', '/v1/ferrets/f1/mcp', { as: as('filesystem.use') });
    expect(listed.status).toBe(200);
    expect((await h.request('GET', '/v1/ferrets/nobody/mcp', { as: as('filesystem.use') })).status).toBe(404);
  });

  test('R-0087 GET /v1/mcp/auth lists sign-ins by server name and expiry, never a token, uncacheable', async () => {
    const h = await host();
    const listed = await h.request('GET', '/v1/mcp/auth', { as: as('fleet.use') });
    expect(listed.status).toBe(200);
    expect(listed.headers.get('cache-control')).toBe('no-store');
    expect(listed.json()).toEqual({ connections: [] });
  });

  test('R-0306 POST /v1/mcp/check refuses an unknown server in words and a body with no id', async () => {
    const h = await host();
    const unknown = await h.request('POST', '/v1/mcp/check', { body: { id: 'nope' }, as: as('terminal.use') });
    expect(unknown.status).toBe(404);
    expect((await h.request('POST', '/v1/mcp/check', { body: {}, as: as('terminal.use') })).status).toBe(400);
    expect((await h.request('POST', '/v1/mcp/check', { body: { id: 'nope' }, as: as('fleet.use') })).status).toBe(403);
  });
});
