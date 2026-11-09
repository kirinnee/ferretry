import { describe, expect, test } from 'bun:test';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { FakeSealedDocuments, FakeVault } from '@ferretry/core-vault/contract/testing';
import { testHost } from '@ferretry/kernel/testing';
import { RuntimeIdSchema, type RuntimeSummary } from '@ferretry/plugin-runtimes/contract';
import { fakeRuntimes } from '@ferretry/plugin-runtimes/contract/testing';
import { fakeProjects } from '@ferretry/plugin-projects/contract/testing';
import { McpServerAdded } from '../../contract/index.ts';
import mcp from '../../daemon/index.ts';

/**
 * Adding a server for one ferret, through the daemon half as it is wired: the known-root set Projects supplies
 * (R-0161, R-0353, R-0354, G177) and the login target over Runtimes (R-0351, R-0352). Fakes only, in memory.
 */

const ROOT = '/work/app';
const COMMAND = { transport: 'command', command: 'npx', args: ['acme'], env: {} };
const ADD = { name: 'acme', server: COMMAND };
const PROJECT_FILE = '{"mcpServers":{"docs":{"url":"https://docs.example.com/mcp"}}}';
const RUNTIME: RuntimeSummary = {
  id: RuntimeIdSchema.parse('claude-work'),
  harness: 'claude-code',
  login: 'work',
  profile: 'work',
  agent: false,
  launch: { available: true },
};
const device = (...capabilities: string[]) => ({ kind: 'device', holder: 'dev_a', capabilities }) as const;

interface Options {
  /** Whether Projects is on (default yes) and the folders registered with it. */
  readonly projects?: 'off' | readonly string[];
  /** Whether Runtimes is on (default yes). */
  readonly runtimes?: 'off';
  /** The owner's standing on every call (Gate's real standing carries governance), instead of the stand-in's. */
  readonly owner?: true;
}

async function world(options: Options = {}) {
  const ferrets = new FakeFerrets();
  ferrets.add({ id: ferretId('f1'), folder: ROOT, runtime: RUNTIME.id });
  ferrets.add({ id: ferretId('f2'), folder: '/elsewhere/app', runtime: RUNTIME.id });
  ferrets.add({ id: ferretId('f3'), folder: ROOT });
  const projects = fakeProjects();
  if (options.projects !== 'off')
    for (const path of options.projects ?? [ROOT]) await projects.register({ kind: 'existing-folder', path });
  const runtimes = fakeRuntimes();
  runtimes.setRuntimes([RUNTIME]);
  runtimes.setProfiles([{ name: 'work', layers: ['instructions/base'], etag: 'etag-1' }]);
  const h = await testHost({
    plugins: [mcp],
    fakes: { ferrets, vault: new FakeVault(), sealed: new FakeSealedDocuments() },
    uses: {
      ...(options.projects === 'off' ? {} : { projects }),
      ...(options.runtimes === 'off' ? {} : { runtimes }),
    },
    ...(options.owner === true ? { gate: new StandInAdmission(() => ownerStanding()) } : {}),
  });
  return { h, runtimes };
}

describe('the project file of a ferret at a registered root', () => {
  test('R-0161 lists the project file servers, its path and its etag', async () => {
    const { h } = await world();
    h.putRoot('work', '.mcp.json', PROJECT_FILE);

    const listed = await h.request('GET', '/v1/ferrets/f1/mcp', { as: device('filesystem.use') });

    expect(listed.status).toBe(200);
    expect(listed.headers.get('cache-control')).toBe('no-store');
    const body = listed.json<{ project: { path: string; etag: string; servers: { name: string }[] } }>();
    expect(body.project.path).toBe(`${ROOT}/.mcp.json`);
    expect(body.project.etag).toMatch(/^[0-9a-f]{64}$/u);
    expect(body.project.servers.map(server => server.name)).toEqual(['docs']);
  });

  test('R-0354 R-0353 a preview shows the diff and writes nothing, then the add writes the file against its etag', async () => {
    const { h } = await world();
    h.putRoot('work', '.mcp.json', PROJECT_FILE);
    const as = device('filesystem.use', 'filesystem.configure');

    const preview = await h.request('POST', '/v1/ferrets/f1/mcp/project/preview', { body: ADD, as });
    expect(preview.status).toBe(200);
    const shown = preview.json<{ scope: string; path: string; etag: string; replaces: boolean }>();
    expect(shown).toMatchObject({ scope: 'project', path: `${ROOT}/.mcp.json`, replaces: false });
    expect(h.rootText('work', '.mcp.json')).toBe(PROJECT_FILE);
    expect(h.published.filter(entry => entry.event === McpServerAdded.name)).toEqual([]);

    const added = await h.request('POST', '/v1/ferrets/f1/mcp/project', { body: { ...ADD, etag: shown.etag }, as });
    expect(added.status).toBe(200);
    expect(added.json()).toMatchObject({ scope: 'project', name: 'acme', path: `${ROOT}/.mcp.json` });
    const written = JSON.parse(h.rootText('work', '.mcp.json') ?? '{}') as { mcpServers: Record<string, unknown> };
    expect(Object.keys(written.mcpServers).sort()).toEqual(['acme', 'docs']);
    expect(h.published.filter(entry => entry.event === McpServerAdded.name)).toEqual([
      expect.objectContaining({ payload: { name: 'acme', scope: 'project' } }),
    ]);

    const stale = await h.request('POST', '/v1/ferrets/f1/mcp/project', { body: { ...ADD, etag: shown.etag }, as });
    expect(stale.status).toBe(409);
    expect(stale.json<{ code: string }>().code).toBe('mcp_file_changed');
  });

  test('G177 a ferret in a folder that is no known project has no project file and nothing is written', async () => {
    const { h } = await world();
    const as = device('filesystem.use', 'filesystem.configure');
    h.putRoot('work', '.mcp.json', PROJECT_FILE);

    const listed = await h.request('GET', '/v1/ferrets/f2/mcp', { as });
    expect(listed.json<{ project: unknown; projectUnavailable: string }>()).toMatchObject({
      project: null,
      projectUnavailable: expect.stringContaining('is not inside a registered project'),
    });
    const preview = await h.request('POST', '/v1/ferrets/f2/mcp/project/preview', { body: ADD, as });
    expect([preview.status, preview.json<{ code: string }>().code]).toEqual([409, 'mcp_project_unavailable']);
    const added = await h.request('POST', '/v1/ferrets/f2/mcp/project', { body: { ...ADD, etag: null }, as });
    expect([added.status, added.json<{ code: string }>().code]).toEqual([409, 'mcp_project_unavailable']);
    expect(h.rootText('work', '.mcp.json')).toBe(PROJECT_FILE);
    expect(h.published.filter(entry => entry.event === McpServerAdded.name)).toEqual([]);
  });

  test('G177 with Projects off no folder is a known root, so every project add is refused', async () => {
    const { h } = await world({ projects: 'off' });
    const as = device('filesystem.use', 'filesystem.configure');
    const preview = await h.request('POST', '/v1/ferrets/f1/mcp/project/preview', { body: ADD, as });
    expect([preview.status, preview.json<{ code: string }>().code]).toEqual([409, 'mcp_project_unavailable']);
  });
});

describe('a login add at the runtime a ferret launches on', () => {
  test('R-0352 the preview names the runtime, its profile and how many ferrets it reaches, and writes nothing', async () => {
    const { h, runtimes } = await world();
    const preview = await h.request('POST', '/v1/ferrets/f1/mcp/login/preview', { body: ADD, as: device('fleet.use') });
    expect(preview.status).toBe(200);
    expect(preview.json()).toEqual({
      scope: 'login',
      runtime: 'claude-work',
      profile: 'work',
      replaces: false,
      ferrets: 2,
    });
    expect(runtimes.changes).toEqual([]);
    expect(h.configChanges).toEqual([]);
  });

  test('R-0351 the add writes config/mcp/<name>.yaml and adds ONE layer to the profile, as the owner', async () => {
    const { h, runtimes } = await world({ owner: true });
    const added = await h.request('POST', '/v1/ferrets/f1/mcp/login', { body: ADD });
    expect(added.status).toBe(200);
    expect(added.json()).toEqual({ scope: 'login', name: 'acme', runtime: 'claude-work', profile: 'work' });
    expect(h.configChanges.map(change => `${change.plugin}:${change.path}`)).toEqual(['mcp:mcp/acme.yaml']);
    expect(runtimes.changes).toEqual([{ kind: 'add', profile: 'work', layer: 'mcp/acme', ifMatch: 'etag-1' }]);
    expect((await runtimes.profiles())[0]?.layers).toEqual(['instructions/base', 'mcp/acme']);
    expect(h.published.filter(entry => entry.event === McpServerAdded.name)).toEqual([
      expect.objectContaining({ payload: { name: 'acme', scope: 'login' } }),
    ]);
    // The preview now says the item is replaced, and a second add changes the item but not the profile.
    const again = await h.request('POST', '/v1/ferrets/f1/mcp/login', { body: ADD });
    expect(again.status).toBe(200);
    expect(runtimes.changes.length).toBe(1);
  });

  test('R-0351 a caller Runtimes cannot place is refused in its words, and the profile is not touched', async () => {
    const { h, runtimes } = await world();
    const refused = await h.request('POST', '/v1/ferrets/f1/mcp/login', { body: ADD, as: device('fleet.configure') });
    expect(refused.status).toBe(409);
    expect(refused.json()).toMatchObject({
      code: 'mcp_profile_refused',
      error: 'this daemon cannot say whether this caller may change the fleet',
    });
    expect((await runtimes.profiles())[0]?.layers).toEqual(['instructions/base']);
    expect(h.published.filter(entry => entry.event === McpServerAdded.name)).toEqual([]);
  });

  test('R-0352 a ferret with no runtime, an unknown runtime, or Runtimes off has no login to add to', async () => {
    const { h } = await world();
    for (const id of ['f3']) {
      const none = await h.request('POST', `/v1/ferrets/${id}/mcp/login/preview`, {
        body: ADD,
        as: device('fleet.use'),
      });
      expect([none.status, none.json<{ code: string }>().code]).toEqual([409, 'mcp_runtime_unknown']);
    }
    const off = await world({ runtimes: 'off' });
    const refused = await off.h.request('POST', '/v1/ferrets/f1/mcp/login', {
      body: ADD,
      as: device('fleet.configure'),
    });
    expect([refused.status, refused.json<{ code: string }>().code]).toEqual([409, 'mcp_runtime_unknown']);
  });
});
