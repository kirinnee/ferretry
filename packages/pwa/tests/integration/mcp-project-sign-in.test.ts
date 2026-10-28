/**
 * SIGNING IN TO A PROJECT'S MCP SERVER, FROM THE BROWSER'S END TO CLAUDE'S CONFIG.
 *
 * The owner's failure: a ferret working in a repository no Ferretry project is registered for listed its
 * `.mcp.json` server "phoebe" as "Needs sign-in", and Sign in answered `There is no MCP server named
 * "phoebe..048c658abfb9" here.` — the inventory had derived the server's project from the ferret's own
 * folder, while the sign-in list (and the launch) knew only registered folders.
 *
 * Every real half is wired together here: the PWA's own API calls (`readSessionMcpServers`,
 * `startMcpSignIn`, `finishMcpSignIn`) through the protocol client to the daemon's real routes, the real
 * inventory, sign-in and launch services over real files, and the real `fetch` adapter against a fake
 * MCP server + OAuth provider listening on loopback — it answers the first call `401` with a
 * `WWW-Authenticate` that points at its discovery documents, the way a real one does. Nothing here
 * reaches a real account or leaves the machine.
 *
 * The daemon and test-support halves are imported by relative path deliberately: they are the files
 * that ship, not a re-export a test could pass against.
 */

import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type IFyHttpTransport, mcpOAuthSecretNames } from '@ferretry/protocol';
import { FyApiClient, FyHttpError } from '@ferretry/protocol/client';
import should from 'should';
import { FileClaudeLocalScope, FileMcpHarnessDocuments } from '../../../daemon/src/adapters/mcp-inventory/index.ts';
import { FetchMcpOAuthHttp } from '../../../daemon/src/adapters/mcp-oauth/index.ts';
import { ApiDispatcher } from '../../../daemon/src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../daemon/src/lib/api/router.ts';
import {
  combinedMcpOAuthServers,
  KnownAndFerretFolders,
  McpCheckService,
  type McpInventoryAccount,
  McpInventoryService,
  mcpFolderSubject,
  ProjectMcpLaunch,
  ProjectMcpOAuthServers,
} from '../../../daemon/src/lib/mcp-inventory/index.ts';
import { McpOAuthService } from '../../../daemon/src/lib/mcp-oauth/index.ts';
import { mcpInventoryRoutes } from '../../../daemon/src/lib/runtime/mounts/mcp-inventory.ts';
import { mcpOAuthRoutes } from '../../../daemon/src/lib/runtime/mounts/mcp-oauth.ts';
import { request as apiRequest } from '../../../daemon/tests/unit/api/support.ts';
import { FakeProvider, type FakeProviderOptions } from '../../../daemon/tests/unit/mcp-oauth/fake-provider.ts';
import { leaks, PWA_REDIRECT, testCrypto, world } from '../../../daemon/tests/unit/mcp-oauth/support.ts';
import { CREDENTIALS, GRANTED, sessionView } from '../../../daemon/tests/unit/runtime/mounts/support.ts';
import { finishMcpSignIn, startMcpSignIn } from '../../src/features/fleet/mcp-auth-api.ts';
import { readSessionMcpServers } from '../../src/features/mcp/mcp-api.ts';
import { plainFailure } from '../../src/features/mcp/mcp-model.ts';

const WRAPPER = '/fy/bin/claude-work';
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(async cleanup => await cleanup()));
});

/** The fake MCP server and OAuth provider, on a loopback port of its own. */
function listeningProvider(options: FakeProviderOptions = {}): FakeProvider {
  let provider: FakeProvider | undefined;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async request => await (provider as FakeProvider).handle(request),
  });
  provider = new FakeProvider(`http://127.0.0.1:${server.port}`, options);
  cleanups.push(async () => void (await server.stop(true)));
  return provider;
}

/** The PWA's client, whose every request is answered by the daemon's real routes in process. */
async function browserClient(dispatcher: ApiDispatcher): Promise<FyApiClient> {
  const transport: IFyHttpTransport = {
    send: async (url, init) => {
      const target = new URL(url);
      const answer = await dispatcher.dispatch(
        apiRequest({
          method: init.method ?? 'GET',
          path: target.pathname,
          query: [...target.searchParams],
          headers: Object.fromEntries(new Headers(init.headers)),
          ...(typeof init.body === 'string' ? { body: init.body } : {}),
          loopback: true,
        }),
      );
      return new Response(answer.status === 204 ? null : answer.body, {
        status: answer.status,
        headers: Object.fromEntries(answer.headers),
      });
    },
  };
  return await FyApiClient.connect({
    baseUrl: 'http://127.0.0.1:7431',
    token: CREDENTIALS.admin,
    version: '4.89.0',
    transport,
  });
}

/** `entry` adds fields to phoebe's `.mcp.json` entry — Claude's `oauth` block, say. */
async function machine(options: FakeProviderOptions = {}, entry: Record<string, unknown> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'fy-pwa-mcp-signin-'));
  cleanups.push(async () => await rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'fleet/homes/claude-work-id');
  const registered = path.join(root, 'work/app');
  // The owner's PE checkout: a repository with a `.mcp.json`, and no Ferretry project registered for it.
  const pe = path.join(root, 'work/vungle/PE');
  await Promise.all([home, registered, pe].map(async folder => await mkdir(folder, { recursive: true })));
  const provider = listeningProvider(options);
  await writeFile(
    path.join(pe, '.mcp.json'),
    JSON.stringify({ mcpServers: { phoebe: { type: 'http', url: provider.serverUrl, ...entry } } }),
  );
  await writeFile(path.join(home, '.claude.json'), JSON.stringify({ numStartups: 3, projects: {} }));

  const accounts: readonly McpInventoryAccount[] = [
    { runtime: 'claude-work', harness: 'claude', home, wrapper: WRAPPER },
  ];
  const ferret = sessionView('s1', { cwd: pe, agent: WRAPPER });
  const folders = new KnownAndFerretFolders(
    async () => [{ root: registered, project: registered, name: 'app' }],
    async () => [ferret.config.cwd],
  );
  const documents = new FileMcpHarnessDocuments();
  // The stores are the in-memory ones: what is under test is which server a sign-in is FOR.
  const stores = world();
  const oauth = new McpOAuthService({
    servers: combinedMcpOAuthServers({ list: async () => [] }, new ProjectMcpOAuthServers(folders, documents)),
    http: new FetchMcpOAuthHttp(),
    crypto: testCrypto,
    clock: stores.clock,
    state: stores.state,
    secrets: stores.secrets,
    values: stores.secrets,
    internal: stores.internal,
  });
  const inventory = new McpInventoryService({
    accounts: async () => accounts,
    components: async () => [],
    folders,
    connections: async () => await oauth.connections(),
    documents,
    sessions: { get: async id => (id === 's1' ? ferret : undefined) },
  });
  const check = new McpCheckService({
    inventory,
    probe: { probe: async () => ({ serverName: 'unused', tools: [] }) },
    launchEnvironment: async () => ({}),
    baseEnvironment: () => ({}),
    bearer: async () => undefined,
    redactor: { redact: async text => text },
    now: () => 0,
  });
  const dispatcher = new ApiDispatcher(
    new ApiRouter([...mcpInventoryRoutes({ inventory, check }), ...mcpOAuthRoutes(oauth)]),
    CREDENTIALS,
    GRANTED,
  );
  const launch = new ProjectMcpLaunch({
    accounts: async () => accounts,
    folders,
    documents,
    secrets: stores.secrets,
    renewal: oauth,
    localScope: new FileClaudeLocalScope(),
  });
  return { client: await browserClient(dispatcher), provider, stores, launch, folders, home, pe };
}

describe('signing in to a project MCP server from the PWA', () => {
  it('should sign in to a server of an unregistered repository and hand Claude its local-scope entry', async () => {
    // Arrange — the row the Info › Context › MCP list shows, read the way the PWA reads it.
    const m = await machine();
    const before = (await readSessionMcpServers(m.client, 's1')).servers.find(server => server.name === 'phoebe');
    should(before).containEql({ scope: 'project', transport: 'http' });
    const subject = before?.signIn?.subject ?? '';
    should(subject).equal(mcpFolderSubject(await m.folders.forCwd(m.pe), 'phoebe'));

    // Act — Sign in, approve at the provider, and hand the daemon the address it sent the browser back to.
    const flow = await startMcpSignIn(m.client, subject, { redirectUri: PWA_REDIRECT });
    const completion = await finishMcpSignIn(m.client, flow.flowId, await m.provider.approve(flow.authorizeUrl));
    const env = await m.launch.forLaunch(WRAPPER, m.pe);

    // Assert — signed in, the row says so, and the token reaches Claude only as a launch variable that the
    // local-scope entry for this folder names.
    should(completion.connection).containEql({ component: subject, state: 'signed-in' });
    const after = (await readSessionMcpServers(m.client, 's1')).servers.find(server => server.name === 'phoebe');
    should(after?.connection?.state).equal('signed-in');
    const names = mcpOAuthSecretNames(subject, m.provider.serverUrl);
    should(env).deepEqual({ [names.variable]: m.provider.issued[0] });
    const claudeJson = await readFile(path.join(m.home, '.claude.json'), 'utf8');
    const written = JSON.parse(claudeJson) as {
      numStartups: number;
      projects: Record<string, { mcpServers?: Record<string, unknown> }>;
    };
    should(written.numStartups).equal(3);
    should(written.projects[m.pe]?.mcpServers).deepEqual({
      phoebe: {
        type: 'http',
        url: m.provider.serverUrl,
        headers: { Authorization: `Bearer \${${names.variable}}` },
      },
    });
    should(leaks(m.provider, completion, claudeJson, m.stores.state.document)).deepEqual([]);
  });

  it('should name the project when a sign-in is asked for a server its project no longer declares', async () => {
    // Arrange
    const m = await machine();
    const subject = (await readSessionMcpServers(m.client, 's1')).servers.find(server => server.name === 'phoebe')
      ?.signIn?.subject;
    await writeFile(path.join(m.pe, '.mcp.json'), JSON.stringify({ mcpServers: {} }));

    // Act
    const refused = await startMcpSignIn(m.client, subject ?? '', { redirectUri: PWA_REDIRECT }).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert
    should(String(refused)).containEql(`in ${m.pe}/.mcp.json any more`);
  });
});

describe('when phoebe’s sign-in provider will not register Ferretry', () => {
  /** The row's sign-in subject, read the way the PWA reads it. */
  const subjectOf = async (m: Awaited<ReturnType<typeof machine>>): Promise<string> =>
    (await readSessionMcpServers(m.client, 's1')).servers.find(server => server.name === 'phoebe')?.signIn?.subject ??
    '';

  it('should say why — the provider’s reason, its status, its host — as a sign-in refusal, not a dead machine', async () => {
    // Arrange — every registration is refused the way a provider that wants admin approval refuses it.
    const m = await machine({
      refuseRegistration: () => ({
        status: 403,
        error: 'access_denied',
        error_description: 'new clients must be approved by an administrator',
      }),
    });

    // Act
    const refused = await startMcpSignIn(m.client, await subjectOf(m), { redirectUri: PWA_REDIRECT }).then(
      () => undefined,
      (error: unknown) => error,
    );

    // Assert
    should(refused).be.instanceOf(FyHttpError);
    should((refused as FyHttpError).code).equal('mcp_auth_registration');
    should((refused as FyHttpError).message).startWith(
      'The sign-in provider refused new apps: access_denied — new clients must be approved by an administrator.',
    );
    should((refused as FyHttpError).message).containEql(`${new URL(m.provider.origin).host} answered HTTP 403`);
    should(plainFailure((refused as Error).message, 'Liftoff MBP', 'start signing in to phoebe', true).headline).equal(
      'Couldn’t start signing in to phoebe',
    );
  });

  it('should sign in with the client Claude’s `.mcp.json` names, registering nothing', async () => {
    // Arrange — the provider has no registration endpoint; the client was registered by hand for port 8123.
    const m = await machine({ noRegistration: true }, { oauth: { clientId: 'hand-1', callbackPort: 8123 } });
    m.provider.preRegister('hand-1', ['http://localhost:8123/callback']);

    // Act
    const flow = await startMcpSignIn(m.client, await subjectOf(m), { redirectUri: PWA_REDIRECT });
    const completion = await finishMcpSignIn(m.client, flow.flowId, await m.provider.approve(flow.authorizeUrl));

    // Assert
    should(flow).containEql({ mode: 'paste', redirectUri: 'http://localhost:8123/callback' });
    should(completion.connection.state).equal('signed-in');
    should(m.provider.registrationRequests).have.length(0);
  });
});
