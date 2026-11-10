import { describe, expect, test } from 'bun:test';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { FakeSealedDocuments, FakeVault } from '@ferretry/core-vault/contract/testing';
import { ferret, testHost } from '@ferretry/kernel/testing';
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
  /**
   * A governed standing that passes the route but is NOT the owner (a device the kernel's owner question refuses),
   * instead of the stand-in's. Gate's own judge is tested in core/gate; here the question is answered by `governed`.
   */
  readonly notOwner?: true;
}

/**
 * The kernel's owner question (`secretAdd`) as Gate answers it for a stand-in standing: the host admin (ungoverned)
 * applies, a governed caller holds. Anything else the writer asks is applied, as nothing here loosens a limit.
 */
const ownerQuestion = (input: { readonly secretAdd?: true; readonly standing?: { readonly governance?: unknown } }) =>
  input.secretAdd !== true || (input.standing?.governance as { governed?: boolean } | undefined)?.governed === false
    ? ('apply' as const)
    : ('hold' as const);

/** A governed device that holds every capability the route asks but is not the owner at the machine. */
const governedStanding = () => ({
  ...ownerStanding('ui'),
  governance: { governed: true, decide: () => ({ allowed: true, refusal: 'granted' as const }) },
});

const standIn = (standing: () => ReturnType<typeof ownerStanding>) =>
  Object.assign(new StandInAdmission(() => standing()), { judgeConfigWrite: ownerQuestion });

async function world(options: Options = {}) {
  const ferrets = new FakeFerrets();
  ferrets.add({ id: ferretId('f1'), folder: ROOT, runtime: RUNTIME.id });
  ferrets.add({ id: ferretId('f2'), folder: '/elsewhere/app', runtime: RUNTIME.id });
  ferrets.add({ id: ferretId('f3'), folder: ROOT });
  // A runtime Runtimes does not answer (removed, or never there).
  ferrets.add({ id: ferretId('f4'), folder: ROOT, runtime: RuntimeIdSchema.parse('ghost') });
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
    ...(options.owner === true ? { gate: standIn(() => ownerStanding()) } : {}),
    ...(options.notOwner === true ? { gate: standIn(governedStanding) } : {}),
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
    // Refused before any write: no item file was made, so none is left in effect.
    expect(h.configChanges).toEqual([]);
    expect(runtimes.changes).toEqual([]);
  });

  const WITH_SECRET = { name: 'acme', server: { ...COMMAND, env: { TOKEN: '${secret:ACME_TOKEN}' } } };

  test('R-0351 the OWNER adds a server whose env names a secret: the item is in effect and ONE layer is added at once', async () => {
    const { h, runtimes } = await world({ owner: true });

    const added = await h.request('POST', '/v1/ferrets/f1/mcp/login', { body: WITH_SECRET });

    expect(added.status).toBe(200);
    expect(added.json()).toEqual({ scope: 'login', name: 'acme', runtime: 'claude-work', profile: 'work' });
    expect(h.configChanges.map(change => `${change.path}:${change.state}`)).toEqual(['mcp/acme.yaml:valid']);
    expect(runtimes.changes).toEqual([{ kind: 'add', profile: 'work', layer: 'mcp/acme', ifMatch: 'etag-1' }]);
    // In effect: the preview now sees it as a replacement.
    const preview = await h.request('POST', '/v1/ferrets/f1/mcp/login/preview', { body: WITH_SECRET });
    expect(preview.json<{ replaces: boolean }>().replaces).toBe(true);
  });

  test('R-0351 a caller who is not the owner keeps the hold on a secret env: nothing in effect and no layer', async () => {
    const { h, runtimes } = await world({ notOwner: true });

    const held = await h.request('POST', '/v1/ferrets/f1/mcp/login', { body: WITH_SECRET });

    expect(held.status).toBe(409);
    expect(held.json<{ code: string }>().code).toBe('mcp_change_held');
    expect(held.json<{ error: string }>().error).toContain('not in effect and the profile was not changed');
    expect(held.json<{ error: string }>().error).toContain('ACME_TOKEN');
    expect(runtimes.changes).toEqual([]);
    expect(h.published.filter(entry => entry.event === McpServerAdded.name)).toEqual([]);
    const preview = await h.request('POST', '/v1/ferrets/f1/mcp/login/preview', { body: WITH_SECRET });
    expect(preview.json<{ replaces: boolean }>().replaces).toBe(false);
  });

  test("R-0351 a ferret's session credential never reaches the login add (the route is a person's), so nothing is written", async () => {
    const { h, runtimes } = await world();

    const refused = await h.request('POST', '/v1/ferrets/f1/mcp/login', { body: WITH_SECRET, as: ferret('f1') });

    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(refused.status).not.toBe(409);
    expect(h.configChanges).toEqual([]);
    expect(runtimes.changes).toEqual([]);
  });

  test('R-0351 a profile Runtimes refuses AFTER the item was written takes the new item back', async () => {
    const { h, runtimes } = await world({ owner: true });
    runtimes.setChangeOutcome({ kind: 'conflict', profile: 'work' });

    const refused = await h.request('POST', '/v1/ferrets/f1/mcp/login', { body: ADD });

    expect(refused.status).toBe(409);
    expect(refused.json<{ code: string }>().code).toBe('mcp_profile_changed');
    // The item was written, then removed: its file is absent again, so a retry creates it cleanly.
    expect(h.configChanges.map(change => `${change.path}:${change.state}`)).toEqual([
      'mcp/acme.yaml:valid',
      'mcp/acme.yaml:absent',
    ]);
    expect(h.published.filter(entry => entry.event === McpServerAdded.name)).toEqual([]);
    runtimes.setChangeOutcome(undefined);
    const again = await h.request('POST', '/v1/ferrets/f1/mcp/login', { body: ADD });
    expect(again.status).toBe(200);
  });

  test('R-0352 a ferret with no runtime, an unknown runtime, or Runtimes off has no login to add to', async () => {
    const { h } = await world();
    for (const id of ['f3', 'f4']) {
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
