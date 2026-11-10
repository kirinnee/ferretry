import { describe, expect, test } from 'bun:test';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { FakeSealedDocuments, FakeVault } from '@ferretry/core-vault/contract/testing';
import { testHost } from '@ferretry/kernel/testing';
import { McpServerAdded, mcpServerRefusal, McpSignInChanged } from '../../contract/index.ts';
import mcp from '../../daemon/index.ts';
import manifest from '../../manifest.ts';
import { leaks, PWA_REDIRECT, world } from '../unit/oauth/support.ts';

const route = (key: string) => manifest.actions.routes.find(candidate => candidate.key === key);
const demand = (key: string): string => `${String(route(key)?.capability?.capability)}.${route(key)?.capability?.axis}`;

const COMMAND = { transport: 'command', command: 'npx', args: ['acme'], env: {} };
const ADD = { name: 'acme', server: COMMAND };
const as = (...capabilities: string[]) => ({ kind: 'device', holder: 'dev_a', capabilities }) as const;

async function host() {
  const ferrets = new FakeFerrets();
  ferrets.add({ id: ferretId('f1'), folder: '/work/app' });
  return await testHost({
    plugins: [mcp],
    fakes: { ferrets, vault: new FakeVault(), sealed: new FakeSealedDocuments() },
  });
}

describe('adding an MCP server for one ferret', () => {
  test('G176 each MCP-add route declares exactly one capability, and a device without it is refused', async () => {
    expect(demand('POST /v1/ferrets/:ferretId/mcp/project/preview')).toBe('filesystem.use');
    expect(demand('POST /v1/ferrets/:ferretId/mcp/login/preview')).toBe('fleet.use');
    expect(demand('POST /v1/ferrets/:ferretId/mcp/project')).toBe('filesystem.configure');
    expect(demand('POST /v1/ferrets/:ferretId/mcp/login')).toBe('fleet.configure');
    const h = await host();
    const post = async (path: string, ...capabilities: string[]) =>
      (await h.request('POST', `/v1/ferrets/f1/mcp/${path}`, { body: ADD, as: as(...capabilities) })).status;
    // The wrong capability is refused at admission, whichever of the others the device holds.
    expect(await post('project/preview', 'fleet.use', 'fleet.configure', 'filesystem.configure')).toBe(403);
    expect(await post('login/preview', 'filesystem.use', 'fleet.configure')).toBe(403);
    expect(await post('project', 'filesystem.use', 'fleet.configure')).toBe(403);
    expect(await post('login', 'filesystem.configure', 'fleet.use')).toBe(403);
    // The right one is admitted.
    expect(await post('project/preview', 'filesystem.use')).toBe(409);
    expect(await post('login/preview', 'fleet.use')).toBe(409);
  });

  test('G177 a project add refuses a ferret whose folder is no registered project or managed worktree', async () => {
    const h = await host();
    const device = as('filesystem.use', 'filesystem.configure');

    const preview = await h.request('POST', '/v1/ferrets/f1/mcp/project/preview', { body: ADD, as: device });
    expect(preview.status).toBe(409);
    expect(preview.json()).toMatchObject({ code: 'mcp_project_unavailable' });
    const missing = await h.request('POST', '/v1/ferrets/f1/mcp/project', { body: ADD, as: device });
    expect(missing.status).toBe(400);
    expect(missing.json<{ code: string }>().code).toBe('mcp_etag_required');
    const added = await h.request('POST', '/v1/ferrets/f1/mcp/project', { body: { ...ADD, etag: null }, as: device });
    expect(added.status).toBe(409);
    expect(added.json()).toMatchObject({ code: 'mcp_project_unavailable' });
    // A ferret that does not exist has no project.
    const nobody = await h.request('GET', '/v1/ferrets/nobody/mcp', { as: as('filesystem.use') });
    expect(nobody.status).toBe(404);
  });

  test('G178 a login add is two changes through the runtime, so a ferret with no runtime is refused in words', async () => {
    expect(route('POST /v1/ferrets/:ferretId/mcp/login')?.caller).toBe('person');
    const h = await host();
    const refused = await h.request('POST', '/v1/ferrets/f1/mcp/login', { body: ADD, as: as('fleet.configure') });
    // A ferret itself is refused before anything is read (a login add is a person route).
    const byFerret = await h.request('POST', '/v1/ferrets/f1/mcp/login', {
      body: ADD,
      as: { kind: 'ferret', id: 'f1' },
    });
    expect(byFerret.status).toBe(403);
    expect(refused.status).toBe(409);
    expect(refused.json<{ code: string }>().code).toBe('mcp_runtime_unknown');
  });

  test('G179 an add declares fleet.configured with its scope, and previews and refused adds publish no event', async () => {
    expect(route('POST /v1/ferrets/:ferretId/mcp/project')?.audit as unknown).toEqual({
      record: 'fleet.configured:mcp-add-project',
    });
    expect(route('POST /v1/ferrets/:ferretId/mcp/login')?.audit as unknown).toEqual({
      record: 'fleet.configured:mcp-add-login',
    });
    for (const key of [
      'POST /v1/ferrets/:ferretId/mcp/project/preview',
      'POST /v1/ferrets/:ferretId/mcp/login/preview',
    ])
      expect('skip' in (route(key)?.audit ?? {})).toBe(true);
    const h = await host();
    const device = as('filesystem.use', 'filesystem.configure');
    const server = { transport: 'command', command: 'npx', args: ['--key-in-args'], env: { A: 'plain' } };
    await h.request('POST', '/v1/ferrets/f1/mcp/project/preview', { body: { name: 'acme', server }, as: device });
    expect(h.published.filter(entry => entry.event === McpServerAdded.name)).toEqual([]);
    const refused = await h.request('POST', '/v1/ferrets/f1/mcp/project', {
      body: { name: 'acme', server, etag: null },
      as: device,
    });
    expect(refused.status).toBe(409);
    expect(h.published.filter(entry => entry.event === McpServerAdded.name)).toEqual([]);
  });

  test('G180 no secret value crosses either route: a raw key is refused by the form rule and by the service', async () => {
    const raw = { transport: 'command', command: 'npx', args: [], env: { KEY: 'sk-live-0123456789abcdef' } };
    expect(mcpServerRefusal('project', raw as never)).not.toBeNull();
    expect(mcpServerRefusal('login', raw as never)).not.toBeNull();
    const h = await host();
    for (const [path, capability] of [
      ['project/preview', 'filesystem.use'],
      ['login/preview', 'fleet.use'],
    ] as const) {
      const response = await h.request('POST', `/v1/ferrets/f1/mcp/${path}`, {
        body: { name: 'acme', server: raw },
        as: as(capability),
      });
      expect(response.status).toBe(400);
      expect(response.json<{ code: string }>().code).toBe('mcp_server_refused');
      expect(response.body).not.toContain('sk-live');
    }
  });
});

describe('the MCP sign-in', () => {
  test('S8 the service opens an access token only to revoke it at sign-out, and files what it must keep in the second store', async () => {
    const w = world({ expiresIn: 3600 });
    const flow = await w.service.start('linear', { redirectUri: PWA_REDIRECT });
    await w.service.complete(flow.flowId, { callback: await w.provider.approve(flow.authorizeUrl) });

    // The access token is in the ordinary store; the refresh token is not (it rests in the second one).
    const access = [...w.secrets.entries.keys()].filter(name => name.endsWith('_ACCESS'));
    const refresh = [...w.internal.entries.keys()].filter(name => name.endsWith('_REFRESH'));
    expect(access.length).toBe(1);
    expect(refresh.length).toBe(1);
    expect([...w.secrets.entries.keys()].some(name => name.endsWith('_REFRESH'))).toBe(false);
    expect(w.provider.revoked.length).toBe(0);

    const out = await w.service.signOut('linear');
    expect(out).toEqual({ component: 'linear', removed: true, revoked: true });
    expect(w.provider.revoked.length).toBe(1);
  });

  test('S37 only a person starts a sign-in, and the only value stored is what the authorization server returned', async () => {
    for (const key of [
      'POST /v1/mcp/auth/:component',
      'POST /v1/mcp/auth/flows/:flowId',
      'DELETE /v1/mcp/auth/:component',
      'DELETE /v1/mcp/auth/flows/:flowId',
    ])
      expect(route(key)?.caller).toBe('person');
    const h = await host();
    const byFerret = await h.request('POST', '/v1/mcp/auth/linear', { as: { kind: 'ferret', id: 'f1' } });
    expect(byFerret.status).toBe(403);
    // Every value filed is a token the provider issued, nothing the caller chose.
    const w = world({ expiresIn: 3600 });
    const flow = await w.service.start('linear', { redirectUri: PWA_REDIRECT });
    await w.service.complete(flow.flowId, { callback: await w.provider.approve(flow.authorizeUrl) });
    const filed = [...w.secrets.entries.values(), ...w.internal.entries.values()];
    expect(filed.length).toBeGreaterThan(0);
    for (const value of filed) expect(w.provider.issued).toContain(value);
  });

  test('S174 an access token is listed by name and never returned; sign-out deletes every secret it filed', async () => {
    const w = world({ expiresIn: 3600 });
    const flow = await w.service.start('linear', { redirectUri: PWA_REDIRECT });
    const done = await w.service.complete(flow.flowId, { callback: await w.provider.approve(flow.authorizeUrl) });
    const connections = await w.service.connections();

    expect(leaks(w.provider, flow, done, connections)).toEqual([]);
    expect(connections[0]?.state).toBe('signed-in');
    expect([...w.secrets.entries.keys()][0]).toMatch(/^MCP_LINEAR_[0-9A-F]+_ACCESS$/u);

    await w.service.signOut('linear');
    expect(w.secrets.entries.size).toBe(0);
    expect(w.internal.entries.size).toBe(0);

    // At the front door: the list route carries names and expiries, never a token, and is uncacheable.
    const h = await host();
    const listed = await h.request('GET', '/v1/mcp/auth', { as: as('fleet.use') });
    expect(listed.status).toBe(200);
    expect(listed.headers.get('cache-control')).toBe('no-store');
    expect(listed.json()).toEqual({ connections: [] });
    expect(McpSignInChanged.name).toBe('mcp.sign-in-changed');
  });
});

describe('the MCP half as the host runs it', () => {
  test('the inventory answers for a ferret that exists and is 404 for one that does not', async () => {
    const h = await host();
    expect((await h.request('GET', '/v1/ferrets/f1/mcp/servers', { as: as('filesystem.use') })).status).toBe(200);
    expect((await h.request('GET', '/v1/ferrets/nobody/mcp/servers', { as: as('filesystem.use') })).status).toBe(404);
    expect((await h.request('GET', '/v1/mcp', { as: as('fleet.use') })).status).toBe(200);
  });

  test('a launch gets one mcp part per item the harness may run, with its secret references and no value', async () => {
    const ferrets = new FakeFerrets();
    ferrets.add({ id: ferretId('f1'), folder: '/work/app' });
    const h = await testHost({
      plugins: [mcp],
      fakes: { ferrets, vault: new FakeVault(), sealed: new FakeSealedDocuments() },
      config: {
        mcp: {
          docs: { url: 'https://docs.example.com/mcp' },
          tool: { command: 'npx', args: ['tool'], env: { TOKEN: '${secret:TOOL_TOKEN}' } },
          only: { command: 'only', harness: 'codex' },
        },
      },
    });
    const { mcpParts } = await import('../../daemon/lib/launch-parts.ts');
    const items = new Map(
      Object.entries({
        docs: { url: 'https://docs.example.com/mcp' },
        tool: { command: 'npx', args: ['tool'], env: { TOKEN: '${secret:TOOL_TOKEN}' } },
        only: { command: 'only', harness: 'codex' as const },
      }),
    );
    expect(mcpParts(items as never, 'claude-code')).toEqual([
      { kind: 'mcp', name: 'docs', config: { url: 'https://docs.example.com/mcp' } },
      { kind: 'mcp', name: 'tool', config: { command: 'npx', args: ['tool'], env: { TOKEN: '${secret:TOOL_TOKEN}' } } },
    ]);
    expect(h.jobIds()).toBeDefined();
  });
});
