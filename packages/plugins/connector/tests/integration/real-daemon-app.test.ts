import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  approveSignIn,
  type ConnectorClient,
  denySignIn,
  readConnector,
  revokeGrant,
  switchConnector,
} from '../../app/lib/client.ts';
import { bootRealDaemon, type RealDaemon } from '../support/daemon.ts';

/**
 * SETTINGS › CLAUDE CONNECTOR AGAINST A REAL DAEMON: the app half's own client code (`app/lib/client.ts`, the one the
 * tab calls) over a production `fyd` on a temp FY_HOME. Enable, see the address, see a real Claude sign-in WAIT with its
 * match code, approve it, revoke it. The waiting page's link is checked to name the tab the app serves.
 *
 * Own listener on 7482 (7480-7499 are the test range); the address is a fake loopback host. The passkey half of an
 * approval cannot be shown here: a plain HTTP caller at 127.0.0.1 is the owner at the machine and ungoverned, so no passkey is
 * asked of it; that half is `app-passkey.test.tsx` (the real tab and the real routes, a governed device).
 */
const PORT = 7482;
const ORIGIN = `http://127.0.0.1:${String(PORT)}`;
const CALLBACK = 'http://127.0.0.1:7483/cb';
const VERIFIER = 'app-e2e-verifier-'.padEnd(43, 'x');
const FILE = (enabled: boolean): string =>
  `enabled: ${String(enabled)}\npublicUrl: ${ORIGIN}\nport: ${String(PORT)}\nextraRedirectUris:\n  - ${CALLBACK}\n`;

const ROUTES: Readonly<Record<string, readonly [string, string]>> = {
  'GET /v1/connector': ['GET', '/v1/connector'],
  'PUT /v1/connector': ['PUT', '/v1/connector'],
  'POST /v1/connector/requests/:id/approve': ['POST', '/v1/connector/requests/:id/approve'],
  'POST /v1/connector/requests/:id/deny': ['POST', '/v1/connector/requests/:id/deny'],
  'POST /v1/connector/grants/:id/revoke': ['POST', '/v1/connector/grants/:id/revoke'],
};

let daemon: RealDaemon;
/** The app half's client slot, over the real daemon: it fills the path the way the shell's client does, and throws a refusal as `{status, code, message}`. */
const client: ConnectorClient = {
  call: async <Answer = unknown>(
    route: string,
    init?: { readonly params?: Readonly<Record<string, string>>; readonly body?: unknown },
  ): Promise<Answer> => {
    const known = ROUTES[route];
    if (known === undefined) throw new Error(`the app asked for ${route}, which the connector does not declare`);
    const path = known[1].replace(/:(\w+)/gu, (_, name: string) => encodeURIComponent(init?.params?.[name] ?? ''));
    const answer = await daemon.call(known[0], path, init?.body);
    if (answer.status >= 400) {
      const body = JSON.parse(answer.text) as { error?: string; code?: string };
      throw Object.assign(new Error(body.error ?? 'refused'), { status: answer.status, code: body.code ?? 'refused' });
    }
    return JSON.parse(answer.text) as Answer;
  },
};

beforeAll(async () => {
  daemon = await bootRealDaemon({ 'config/connector.yaml': FILE(false) });
  // The file on disk at first boot is an edit nobody confirmed (a new address loosens), so the owner confirms it once.
  const put = await daemon.call('PUT', '/v1/config/file', { path: 'connector.yaml', text: FILE(false) });
  expect(put.status, put.text).toBe(200);
}, 180_000);
afterAll(async () => {
  await daemon?.dispose();
});

const challenge = async (): Promise<string> =>
  Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(VERIFIER))).toString('base64url');

/** Claude's side: register a client and start an authorization; the page it lands on is the waiting page. */
async function startSignIn(name: string, source: string) {
  const registered = await fetch(`${ORIGIN}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': source },
    body: JSON.stringify({ client_name: name, redirect_uris: [CALLBACK], token_endpoint_auth_method: 'none' }),
  });
  expect(registered.status).toBe(201);
  const { client_id } = (await registered.json()) as { client_id: string };
  const started = await fetch(
    `${ORIGIN}/oauth/authorize?${new URLSearchParams({
      response_type: 'code',
      client_id,
      redirect_uri: CALLBACK,
      code_challenge: await challenge(),
      code_challenge_method: 'S256',
      resource: `${ORIGIN}/mcp`,
    }).toString()}`,
    { redirect: 'manual', headers: { 'cf-connecting-ip': source } },
  );
  const waitUrl = started.headers.get('location') ?? '';
  const html = await (await fetch(waitUrl)).text();
  return { waitUrl, html, code: /<strong class="code">([A-Z0-9]{3}-[A-Z0-9]{3})<\/strong>/u.exec(html)?.[1] ?? '' };
}

describe('the Claude connector tab’s client, on a real daemon', () => {
  test('it starts off: no address, and the daemon says why', async () => {
    const status = await readConnector(client);
    expect(status).toMatchObject({ enabled: false, switchedOn: false, pending: [], grants: [] });
    expect(status.mcpUrl).toBeUndefined();
    expect(status.disabledReason).toBeDefined();
    await expect(fetch(`${ORIGIN}/oauth/register`, { method: 'POST' })).rejects.toBeDefined();
  });

  test('switching it on shows the address Claude is given, and the door opens without a restart', async () => {
    const status = await switchConnector(client, true);
    expect(status).toMatchObject({
      enabled: true,
      switchedOn: true,
      publicUrlSource: 'configured',
      publicUrl: ORIGIN,
      mcpUrl: `${ORIGIN}/mcp`,
    });
    expect(await readConnector(client)).toMatchObject({ switchedOn: true, mcpUrl: `${ORIGIN}/mcp` });
    expect((await fetch(`${ORIGIN}/mcp`)).status).toBe(405);
  });

  test('a real Claude sign-in WAITS: the tab sees its match code, and the waiting page links to the tab with that request', async () => {
    const claude = await startSignIn('E2E Claude', '203.0.113.60');
    expect(claude.code, claude.html).not.toBe('');
    const seen = await readConnector(client);
    expect(seen.pending).toHaveLength(1);
    const [waiting] = seen.pending;
    expect(waiting).toMatchObject({
      matchCode: claude.code,
      clientName: 'E2E Claude',
      scopes: ['fleet:read', 'fleet:write'],
    });
    // The link the person opens from the waiting page is the tab (`/d/<daemon>/settings/connector`) and names this sign-in.
    const link = /href="([^"]+\/settings\/connector\?request=[^"]+)"/u.exec(claude.html)?.[1] ?? '';
    const url = new URL(link.replaceAll('&amp;', '&'));
    expect(url.pathname).toMatch(/^\/d\/[^/]+\/settings\/connector$/u);
    expect(url.searchParams.get('request')).toBe(waiting?.id ?? null);
    // Nothing the tab is told could be used to sign in as Claude.
    expect(JSON.stringify(seen)).not.toContain(claude.waitUrl.split('h=')[1] ?? 'missing');
  });

  test('approving the waiting sign-in makes a connected app; Claude can then finish; revoking ends it', async () => {
    const [waiting] = (await readConnector(client)).pending;
    expect(waiting).toBeDefined();
    await approveSignIn(client, waiting?.id ?? '');
    const after = await readConnector(client);
    expect(after.pending).toEqual([]);
    expect(after.grants).toEqual([
      expect.objectContaining({
        clientName: 'E2E Claude',
        approvedBy: 'admin-cli',
        scopes: ['fleet:read', 'fleet:write'],
      }),
    ]);
    expect(after.grants[0]?.revokedAt).toBeUndefined();

    const grant = after.grants[0];
    await revokeGrant(client, grant?.id ?? '');
    const revoked = (await readConnector(client)).grants[0];
    expect(revoked?.revokedAt).toBeDefined();
    // A sign-in that was already decided is refused by the daemon, which the tab says in words.
    await expect(approveSignIn(client, waiting?.id ?? '')).rejects.toMatchObject({ status: expect.any(Number) });
  }, 60_000);

  test('denying a second sign-in turns it down; the tab’s list is empty again', async () => {
    const second = await startSignIn('Second app', '203.0.113.61');
    const [waiting] = (await readConnector(client)).pending;
    expect(waiting?.matchCode).toBe(second.code);
    await denySignIn(client, waiting?.id ?? '');
    expect((await readConnector(client)).pending).toEqual([]);
  }, 60_000);

  test('switching it off closes the door, and the grants stay listed and revocable', async () => {
    const status = await switchConnector(client, false);
    expect(status).toMatchObject({ enabled: false, switchedOn: false });
    expect(status.grants).toHaveLength(1);
    await expect(fetch(`${ORIGIN}/oauth/register`, { method: 'POST' })).rejects.toBeDefined();
  });
});
