import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, it } from 'bun:test';
import { mcpOAuthRedirectPath, mcpOAuthSecretNames } from '@ferretry/protocol';
import { type McpComponent, MissingFleetSecretsError } from '@ferretry/fleet';
import should from 'should';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import {
  AccountModelMcpServers,
  FetchMcpOAuthHttp,
  FileMcpOAuthStateStore,
  MCP_OAUTH_HTTP_MAX_BYTES,
  MCP_OAUTH_STATE_DOCUMENT,
  transportReason,
  webCryptoMcpOAuth,
} from '../../../src/adapters/mcp-oauth/index.ts';
import {
  BunSecretChildRunner,
  FileSecretDocumentStore,
  FileSecretKey,
  MCP_OAUTH_SECRETS_DOCUMENT,
  WebCryptoSecretCipher,
} from '../../../src/adapters/secrets/index.ts';
import { ApiDispatcher } from '../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../src/lib/api/router.ts';
import type { AuditEntry } from '../../../src/lib/audit/types.ts';
import { auditedRoutes } from '../../../src/lib/audit/routes.ts';
import {
  createFoundationPaths,
  FleetLaunchEnvironment,
  McpOAuthService,
  McpOAuthUnreachable,
  resolveStateHome,
  SecretDirectory,
  SecretVault,
  SecretUseService,
  UnknownSecretError,
} from '../../../src/lib/index.ts';
import { mcpOAuthRoutes } from '../../../src/lib/runtime/mounts/mcp-oauth.ts';
import { jsonBody, request } from '../../unit/api/support.ts';
import { FakeProvider, type FakeProviderOptions } from '../../unit/mcp-oauth/fake-provider.ts';
import { CREDENTIALS, GRANTED, human } from '../../unit/runtime/mounts/support.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

/**
 * The MCP sign-in end to end against a FAKE OAuth + MCP server on loopback — real network, real files,
 * real WebCrypto, the real secret store, the real audit decorator. Never the network beyond localhost,
 * never a real account.
 *
 * The claim this tier exists for: after a whole sign-in, a refresh and a sign-out, NO issued token and no
 * authorization code appears in any HTTP answer, any audit entry, anything written to the console, or any
 * file in the state home except the sealed vault — where it is ciphertext. And the MCP server, called the
 * way a harness would call it with the launch environment's value, accepts it.
 */

const PWA_REDIRECT = 'https://ferretry.example.test/oauth/mcp-callback';

interface Harness {
  readonly provider: FakeProvider;
  readonly api: ApiDispatcher;
  readonly audit: AuditEntry[];
  readonly console: string[];
  readonly stateDir: string;
  readonly service: McpOAuthService;
  readonly vault: SecretVault;
  /** The ordinary store's management half, where a person files a secret. */
  readonly secrets: SecretDirectory;
  /** The daemon-internal store: refresh tokens and client secrets. */
  readonly internal: SecretVault;
  readonly clock: { at: number; now: () => number };
  readonly stop: () => void;
}

const servers: { stop: (force?: boolean) => void }[] = [];
let restoreConsole: (() => void) | undefined;

async function harness(
  options: FakeProviderOptions = {},
  /** Extra fields for the `linear` component: a hand-registered client, say. */
  component: Partial<McpComponent> = {},
): Promise<Harness> {
  let provider: FakeProvider | undefined;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async request => await (provider as FakeProvider).handle(request),
  });
  servers.push(server);
  provider = new FakeProvider(`http://127.0.0.1:${String(server.port)}`, options);

  const home = await tempDirectory('mcp-oauth');
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  const files = new StateFileSystem(paths);
  for (const directory of [paths.home, paths.state, paths.temporary]) await files.ensureDirectory(directory, 0o700);
  const documents = new FileSecretDocumentStore(paths, files);
  const cipher = new WebCryptoSecretCipher(new FileSecretKey(documents.keyFile, files));
  const vault = new SecretVault(documents, cipher);
  const internalDocuments = new FileSecretDocumentStore(paths, files, MCP_OAUTH_SECRETS_DOCUMENT);
  const internalDirectory = new SecretDirectory(internalDocuments, cipher, {
    now: () => new Date(clock.at).toISOString(),
  });
  const internal = new SecretVault(internalDocuments, cipher);
  const clock = {
    at: Date.now(),
    now(): number {
      return this.at;
    },
  };
  const ordinary = new SecretDirectory(documents, cipher, { now: () => new Date(clock.at).toISOString() });
  const service = new McpOAuthService({
    servers: new AccountModelMcpServers(async () => ({
      components: { mcp: { linear: { url: (provider as FakeProvider).serverUrl, auth: 'oauth', ...component } } },
    })),
    http: new FetchMcpOAuthHttp(),
    crypto: webCryptoMcpOAuth,
    clock,
    state: new FileMcpOAuthStateStore(paths, files),
    secrets: ordinary,
    values: vault,
    internal: {
      list: async () => await internalDirectory.list(),
      put: async (name, value) => await internalDirectory.put(name, value),
      remove: async name => await internalDirectory.remove(name),
      values: async () => await internal.values(),
    },
  });
  const audit: AuditEntry[] = [];
  const routes = auditedRoutes(
    {
      log: { record: async entry => void audit.push(entry) },
      failures: { auditWriteFailed: () => undefined },
      deviceName: async () => undefined,
    },
    mcpOAuthRoutes(service),
  );

  // Everything the process says while this runs, so "never logged" is checked rather than assumed.
  const said: string[] = [];
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const originals = methods.map(method => console[method]);
  for (const method of methods)
    console[method] = (...parts: unknown[]) => void said.push(parts.map(part => String(part)).join(' '));
  restoreConsole = () => {
    for (const [index, method] of methods.entries()) console[method] = originals[index] as never;
  };

  return {
    provider,
    api: new ApiDispatcher(new ApiRouter(routes), CREDENTIALS, GRANTED),
    audit,
    console: said,
    stateDir: paths.state,
    service,
    vault,
    secrets: ordinary,
    internal,
    clock,
    stop: () => server.stop(true),
  };
}

const post = (path: string, body?: unknown) =>
  request({
    method: 'POST',
    path,
    headers: { ...human, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

/** What a person's browser does: open the authorization URL and land on the redirect. */
async function browse(authorizeUrl: string): Promise<string> {
  const response = await fetch(authorizeUrl, { redirect: 'manual' });
  const location = response.headers.get('location');
  if (response.status !== 302 || location === null) throw new Error(`authorize answered ${String(response.status)}`);
  return location;
}

/** Every credential the fake provider ever handed out, found in `text`. */
const found = (provider: FakeProvider, text: string): readonly string[] =>
  [...provider.issued, ...provider.authorizationCodes].filter(token => text.includes(token));

afterEach(() => {
  restoreConsole?.();
  restoreConsole = undefined;
});

afterAll(async () => {
  for (const server of servers) server.stop(true);
  await cleanupTempDirectories();
});

describe('signing in to a remote MCP server, end to end', () => {
  it('should sign in through the PWA redirect, refresh on use, sign out — and leak no token anywhere', async () => {
    // Arrange
    const h = await harness({ expiresIn: 120 });
    const names = mcpOAuthSecretNames('linear', h.provider.serverUrl);
    const answers: string[] = [];

    // Act — the browser starts, the person approves at the provider, the callback page hands back.
    const started = await h.api.dispatch(post('/v1/fleet/mcp-auth/linear', { redirectUri: PWA_REDIRECT }));
    answers.push(started.body);
    const flow = jsonBody(started) as { flowId: string; authorizeUrl: string; mode: string };
    const callback = await browse(flow.authorizeUrl);
    const finished = await h.api.dispatch(post(`/v1/fleet/mcp-auth/flows/${flow.flowId}`, { callback }));
    answers.push(finished.body);
    const replay = await h.api.dispatch(post(`/v1/fleet/mcp-auth/flows/${flow.flowId}`, { callback }));
    answers.push(replay.body);
    const listed = await h.api.dispatch(request({ path: '/v1/fleet/mcp-auth', headers: human }));
    answers.push(listed.body);

    // A launch: the runtime's manifest binds the variable to the secret; the launch resolves it.
    const launch = new FleetLaunchEnvironment(
      {
        accounts: async () => [
          {
            id: '00000000-0000-4000-8000-000000000001',
            kind: 'claude',
            mode: 'auto',
            wrapper: '/fleet/bin/claude-auto-x',
            home: '/fleet/homes/x',
            displayName: 'x',
            defaultModel: 'm',
            models: [{ id: 'm', available: true }],
            available: true,
            unavailableReason: null,
            secretEnv: { [names.variable]: `\${secret:${names.access}}` },
          },
        ],
      },
      h.vault,
      h.service,
    );
    const firstLaunch = await launch.forWrapper('/fleet/bin/claude-auto-x');
    h.clock.at += 100_000; // within a minute of expiry: the next launch refreshes first.
    const secondLaunch = await launch.forWrapper('/fleet/bin/claude-auto-x');

    // The harness calls the MCP server with the header the materialiser wrote.
    const mcp = await fetch(h.provider.serverUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${secondLaunch[names.variable] as string}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });

    const signedOut = await h.api.dispatch(
      request({ method: 'DELETE', path: '/v1/fleet/mcp-auth/linear', headers: human }),
    );
    answers.push(signedOut.body);

    // Assert — the journey worked.
    should(flow.mode).equal('pwa');
    should(new URL(callback).origin + new URL(callback).pathname).equal(
      `https://ferretry.example.test${mcpOAuthRedirectPath(h.provider.issuer)}`,
    );
    should(finished.status).equal(200);
    should(replay.status).equal(404);
    should(firstLaunch[names.variable]).equal(h.provider.issued[0]);
    should(secondLaunch[names.variable]).equal(h.provider.issued[2]);
    should(mcp.status).equal(200);
    should(jsonBody(signedOut)).deepEqual({ component: 'linear', removed: true, revoked: true });
    should(h.provider.revoked).deepEqual([h.provider.issued[3]]);

    // Assert — NO token or code in any answer, audit entry, console line, or state file but the vault.
    should(found(h.provider, answers.join('\n'))).deepEqual([]);
    should(found(h.provider, JSON.stringify(h.audit))).deepEqual([]);
    should(found(h.provider, h.console.join('\n'))).deepEqual([]);
    should(found(h.provider, callback)).not.be.empty();
    should(found(h.provider, JSON.stringify(h.audit))).deepEqual([]);
    const stateFile = await readFile(join(h.stateDir, MCP_OAUTH_STATE_DOCUMENT), 'utf8');
    should(found(h.provider, stateFile)).deepEqual([]);
    should(found(h.provider, await readFile(join(h.stateDir, 'secrets.json'), 'utf8'))).deepEqual([]);
    should(found(h.provider, await readFile(join(h.stateDir, MCP_OAUTH_SECRETS_DOCUMENT), 'utf8'))).deepEqual([]);
    should((await stat(join(h.stateDir, MCP_OAUTH_STATE_DOCUMENT))).mode & 0o777).equal(0o600);

    // Assert — the audit log names the component and the flow, and nothing else.
    should(h.audit.map(entry => [entry.event, entry.subject, entry.outcome, entry.detail?.action])).deepEqual([
      ['fleet.configured', 'linear', 'succeeded', 'mcp-sign-in'],
      ['fleet.configured', flow.flowId, 'succeeded', 'mcp-sign-in-finish'],
      ['fleet.configured', flow.flowId, 'refused', 'mcp-sign-in-finish'],
      ['fleet.configured', 'linear', 'succeeded', 'mcp-sign-out'],
    ]);
    should(h.audit[1]?.detail?.component).equal('linear');
  });

  it('should fall back to the paste address when the provider refuses the PWA one', async () => {
    // Arrange
    const h = await harness({ refuseRedirect: uri => uri.startsWith('https://') });

    // Act
    const started = await h.api.dispatch(post('/v1/fleet/mcp-auth/linear', { redirectUri: PWA_REDIRECT }));
    const flow = jsonBody(started) as { flowId: string; authorizeUrl: string; mode: string; redirectUri: string };
    const failedPage = await browse(flow.authorizeUrl);
    const finished = await h.api.dispatch(post(`/v1/fleet/mcp-auth/flows/${flow.flowId}`, { callback: failedPage }));

    // Assert
    should(flow.mode).equal('paste');
    should(flow.redirectUri).match(/^http:\/\/localhost:\d{5}\/callback$/u);
    should(failedPage).match(/^http:\/\/localhost:\d{5}\/callback\?/u);
    should(finished.status).equal(200);
    should(found(h.provider, started.body + finished.body + JSON.stringify(h.audit))).deepEqual([]);
  });

  it('should answer a provider that refuses every registration with its reason, status and host — and no secret', async () => {
    // Arrange
    const h = await harness({
      refuseRegistration: () => ({
        status: 400,
        error: 'invalid_client_metadata',
        error_description: 'apps must be approved by an admin, ref=abcdef0123456789abcdef01',
      }),
    });

    // Act
    const started = await h.api.dispatch(post('/v1/fleet/mcp-auth/linear', { redirectUri: PWA_REDIRECT }));

    // Assert
    should(started.status).equal(409);
    const body = jsonBody(started) as { error: string; code: string };
    should(body.code).equal('mcp_auth_registration');
    should(body.error).startWith(
      'The sign-in provider refused new apps: invalid_client_metadata — apps must be approved by an admin, [redacted].',
    );
    should(body.error).containEql(`${new URL(h.provider.origin).host} answered HTTP 400`);
    should(h.provider.registrationRequests.length).be.within(2, 4);
  });

  it('should sign in with a client registered by hand, its secret named in the store and sent as Basic', async () => {
    // Arrange — the provider takes only Basic, and has no registration endpoint at all.
    const secret = 'hand-secret-0123456789';
    const h = await harness(
      { noRegistration: true, tokenAuthMethods: ['client_secret_basic'] },
      { oauth: { clientId: 'hand-1', clientSecret: `\${secret:LINEAR_CLIENT_SECRET}`, callbackPort: 8123 } },
    );
    await h.secrets.put('LINEAR_CLIENT_SECRET', secret);
    h.provider.preRegister('hand-1', ['http://localhost:8123/callback'], secret);

    // Act
    const started = await h.api.dispatch(post('/v1/fleet/mcp-auth/linear', { redirectUri: PWA_REDIRECT }));
    const flow = jsonBody(started) as { flowId: string; authorizeUrl: string; mode: string; redirectUri: string };
    const failedPage = await browse(flow.authorizeUrl);
    const finished = await h.api.dispatch(post(`/v1/fleet/mcp-auth/flows/${flow.flowId}`, { callback: failedPage }));

    // Assert
    should(flow).containEql({ mode: 'paste', redirectUri: 'http://localhost:8123/callback' });
    should(finished.status).equal(200);
    should(h.provider.registrationRequests).have.length(0);
    should(h.provider.tokenAuthorizations[0]).startWith('Basic ');
    const stateFile = await readFile(join(h.stateDir, MCP_OAUTH_STATE_DOCUMENT), 'utf8');
    should(stateFile).not.containEql(secret);
    should(started.body + finished.body + JSON.stringify(h.audit) + h.console.join('\n')).not.containEql(secret);
  });

  it('should refuse a forged address with a sentence that quotes none of it', async () => {
    // Arrange
    const h = await harness();
    const started = await h.api.dispatch(post('/v1/fleet/mcp-auth/linear', { redirectUri: PWA_REDIRECT }));
    const flow = jsonBody(started) as { flowId: string; authorizeUrl: string };
    const callback = await browse(flow.authorizeUrl);

    // Act
    const forged = await h.api.dispatch(
      post(`/v1/fleet/mcp-auth/flows/${flow.flowId}`, {
        callback: callback.replace('ferretry.example.test', 'evil.example'),
      }),
    );

    // Assert
    should(forged.status).equal(409);
    should(found(h.provider, forged.body + JSON.stringify(h.audit))).deepEqual([]);
  });
});

describe('the MCP sign-in adapters', () => {
  let network: { stop: (force?: boolean) => void } | undefined;
  let origin = '';

  beforeEach(() => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: request => {
        const path = new URL(request.url).pathname;
        if (path === '/redirect')
          return new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } });
        if (path === '/huge') return new Response('x'.repeat(MCP_OAUTH_HTTP_MAX_BYTES + 1));
        if (path === '/empty') return new Response(null, { status: 204 });
        return new Response('hello', { headers: { 'x-answer': 'yes' } });
      },
    });
    network = server;
    origin = `http://127.0.0.1:${String(server.port)}`;
  });

  afterEach(() => network?.stop(true));

  it('should answer status, headers and body, and never follow a redirect', async () => {
    // Arrange
    const http = new FetchMcpOAuthHttp();

    // Act
    const plain = await http.request({ method: 'POST', url: `${origin}/`, body: 'x' });
    const redirect = await http.request({ method: 'GET', url: `${origin}/redirect` });
    const empty = await http.request({ method: 'GET', url: `${origin}/empty` });

    // Assert
    should(plain.status).equal(200);
    should(plain.text).equal('hello');
    should(plain.header('x-answer')).equal('yes');
    should(plain.header('x-missing')).be.undefined();
    should(redirect.status).equal(302);
    should(empty.text).equal('');
  });

  it('should refuse an oversized body and a dead host with words that quote no address', async () => {
    // Arrange
    const http = new FetchMcpOAuthHttp();

    // Act / Assert
    await should(http.request({ method: 'GET', url: `${origin}/huge` })).be.rejectedWith(
      'network error: RESPONSE_TOO_LARGE',
    );
    const dead = await http
      .request({ method: 'GET', url: 'http://127.0.0.1:1/secret-path?code=abc' })
      .catch((error: unknown) => error);
    should(dead).be.instanceOf(McpOAuthUnreachable);
    should((dead as McpOAuthUnreachable).reason).match(/^[A-Za-z][A-Za-z0-9_]+$/u);
    should((dead as McpOAuthUnreachable).reason).not.equal('UNKNOWN');
    should((dead as Error).message).not.containEql('secret-path');
    should((dead as Error).message).not.containEql('abc');
  });

  it('should name a timeout, and only a well-formed transport code', () => {
    should(transportReason(Object.assign(new Error('x'), { name: 'TimeoutError' }))).equal('TIMEOUT');
    should(transportReason(Object.assign(new Error('x'), { code: 'ENOTFOUND' }))).equal('ENOTFOUND');
    should(transportReason(Object.assign(new Error('x'), { code: 'has spaces /path?q=1' }))).equal('UNKNOWN');
    should(transportReason('boom')).equal('UNKNOWN');
  });

  it('should read an absent state document as empty, a damaged one as a refusal, and write 0600', async () => {
    // Arrange
    const home = await tempDirectory('mcp-oauth-state');
    const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
    const files = new StateFileSystem(paths);
    for (const directory of [paths.home, paths.state, paths.temporary]) await files.ensureDirectory(directory, 0o700);
    const store = new FileMcpOAuthStateStore(paths, files);
    const path = join(paths.state, MCP_OAUTH_STATE_DOCUMENT);

    // Act / Assert
    should(await store.read()).deepEqual({ v: 1, registrations: {}, connections: {} });
    await store.write({ v: 1, registrations: {}, connections: {} });
    should((await stat(path)).mode & 0o777).equal(0o600);
    await writeFile(path, '{ not json');
    await should(store.read()).be.rejectedWith(/is not a document this daemon can read/u);
    await writeFile(path, JSON.stringify({ v: 2 }));
    await should(store.read()).be.rejectedWith(/is not a document this daemon can read/u);
    const withAuth = {
      v: 1 as const,
      registrations: {
        linear: [
          {
            issuer: 'https://a.example',
            redirectUri: 'http://localhost:50000/callback',
            paste: true as const,
            clientId: 'c',
            hasClientSecret: true,
            tokenAuth: 'client_secret_basic' as const,
          },
        ],
      },
      connections: {},
    };
    await store.write(withAuth);
    should(await store.read()).deepEqual(withAuth);
  });

  it('should list the configured MCP servers, and none on a host with no fleet', async () => {
    // Act
    const none = await new AccountModelMcpServers(async () => undefined).list();
    const some = await new AccountModelMcpServers(async () => ({
      components: {
        mcp: {
          remote: { url: 'https://example.test/mcp', auth: 'oauth' },
          local: { command: 'npx' },
          hand: {
            url: 'https://hand.example/mcp',
            auth: 'oauth',
            oauth: { clientId: 'h', clientSecret: `\${secret:HAND_SECRET}`, callbackPort: 8123 },
          },
        },
      },
    })).list();

    // Assert
    should(none).deepEqual([]);
    should(some).deepEqual([
      { component: 'remote', url: 'https://example.test/mcp', auth: 'oauth' },
      { component: 'local' },
      {
        component: 'hand',
        url: 'https://hand.example/mcp',
        auth: 'oauth',
        client: { clientId: 'h', clientSecret: 'HAND_SECRET', callbackPort: 8123 },
      },
    ]);
  });

  it('should make random bytes and a SHA-256 digest', async () => {
    should(webCryptoMcpOAuth.randomBytes(32)).have.length(32);
    should(Buffer.from(await webCryptoMcpOAuth.sha256('abc')).toString('hex')).equal(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('what the stored tokens can and cannot be used for (review M4, H1)', () => {
  /** Sign in end to end, and answer the names the tokens rest under. */
  async function signedIn(h: Harness) {
    const started = await h.api.dispatch(post('/v1/fleet/mcp-auth/linear', { redirectUri: PWA_REDIRECT }));
    const flow = jsonBody(started) as { flowId: string; authorizeUrl: string };
    const callback = await browse(flow.authorizeUrl);
    const finished = await h.api.dispatch(post(`/v1/fleet/mcp-auth/flows/${flow.flowId}`, { callback }));
    should(finished.status).equal(200);
    return mcpOAuthSecretNames('linear', h.provider.serverUrl);
  }

  /** A launch environment for one account that binds `secretEnv`. */
  const launchFor = (h: Harness, secretEnv: Record<string, string>) =>
    new FleetLaunchEnvironment(
      {
        accounts: async () => [
          {
            id: '00000000-0000-4000-8000-000000000001',
            kind: 'claude',
            mode: 'auto',
            wrapper: '/fleet/bin/claude-auto-x',
            home: '/fleet/homes/x',
            displayName: 'x',
            defaultModel: 'm',
            models: [{ id: 'm', available: true }],
            available: true,
            unavailableReason: null,
            secretEnv,
          },
        ],
      },
      h.vault,
      h.service,
    );

  it('M4: keeps the refresh token out of the ordinary store, so neither `use` nor ${secret:} can spend it', async () => {
    // Arrange
    const h = await harness();
    const names = await signedIn(h);
    const use = new SecretUseService(h.vault, new BunSecretChildRunner());

    // Act
    const ordinary = [...(await h.vault.values()).keys()];
    const spent = await use
      .run({ command: ['/bin/sh', '-c', 'true'], cwd: '/', secrets: [names.refresh], env: {}, timeoutMs: 5_000 })
      .catch((error: unknown) => error);
    const launched = await launchFor(h, { STOLEN: `\${secret:${names.refresh}}` })
      .forWrapper('/fleet/bin/claude-auto-x')
      .catch((error: unknown) => error);

    // Assert — only the access token is an ordinary secret; the refresh token is internal.
    should(ordinary).deepEqual([names.access]);
    should([...(await h.internal.values()).keys()]).deepEqual([names.refresh]);
    should(spent).be.instanceOf(UnknownSecretError);
    should(launched).be.instanceOf(MissingFleetSecretsError);
    should(found(h.provider, String(spent) + String(launched))).deepEqual([]);
  });

  it('H1: refuses the launch of a component moved to another server, sending that server nothing', async () => {
    // Arrange
    const h = await harness();
    await signedIn(h);
    const moved = mcpOAuthSecretNames('linear', 'https://evil.example/mcp');

    // Act — the materialiser binds the moved component's variable to the moved name.
    const launched = await launchFor(h, { [moved.variable]: `\${secret:${moved.access}}` })
      .forWrapper('/fleet/bin/claude-auto-x')
      .catch((error: unknown) => error);

    // Assert
    should(launched).be.instanceOf(MissingFleetSecretsError);
    should(found(h.provider, String(launched))).deepEqual([]);
  });
});
