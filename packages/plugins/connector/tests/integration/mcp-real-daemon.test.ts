import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFile, stat } from 'node:fs/promises';
import { chmod, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { type RealDaemon, bootRealDaemon } from '../support/daemon.ts';
import { DEAD_CONNECTION_TEXT } from '../../daemon/lib/oauth/model.ts';

/**
 * THE MCP ENDPOINT ON A REAL DAEMON (U4): the production `fyd` (every real plugin, Agenda on), the real `fy` as the owner and as
 * two seeded ferrets, and the official MCP SDK client at the connector's own address — dynamic client registration, the
 * owner's approval at the machine, the token, `initialize`, every one of the eleven tools through the daemon's REAL routes
 * and Gate as the connector principal, the per-grant budget, then a revoke and the 401 that says how to reconnect.
 * Fake values only, loopback only, ports 7482 (own listener) and 7483 (the callback address).
 */
const PORT = 7482;
const ORIGIN = `http://127.0.0.1:${String(PORT)}`;
const CALLBACK = 'http://127.0.0.1:7483/cb';
const CONFIG = `enabled: true\npublicUrl: ${ORIGIN}\nport: ${String(PORT)}\nextraRedirectUris:\n  - ${CALLBACK}\n`;

// Every credential-shaped value below is assembled from pieces so no real-looking token sits in the source.
const part = (...pieces: string[]): string => pieces.join('');
const SESSION_TOKEN = part('fys', '_', 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfG');
const DEVICE_TOKEN = part('fyd', '_', 'ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210ZyXwVuT');
const DIGEST = part('9f86d081884c7d659a2feaa0c55ad015', 'a3bf4f1b2b0b822cd15d6c15b0f00a08');
const VAULT_VALUE = part('correct-horse-', 'battery-staple-', 'e2e');

let daemon: RealDaemon;
let project: string;
beforeAll(async () => {
  project = await mkdtemp(join(tmpdir(), 'fy-mcp-project-'));
  await chmod(project, 0o700);
  daemon = await bootRealDaemon(
    {},
    { workOn: true, ferrets: [{ id: 'e2e-lead' }, { id: 'e2e-helper', parent: 'e2e-lead' }] },
  );
}, 240_000);
afterAll(async () => {
  await daemon?.dispose();
});

/** The SDK's OAuth seam, in memory: what a real MCP client keeps between its sign-in's two halves. */
class Provider implements OAuthClientProvider {
  authorization: URL | undefined;
  private info: OAuthClientInformationMixed | undefined;
  private saved: OAuthTokens | undefined;
  private verifier = '';
  readonly redirectUrl = CALLBACK;
  readonly clientMetadata: OAuthClientMetadata = {
    client_name: 'E2E MCP client',
    redirect_uris: [CALLBACK],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    scope: 'fleet:read fleet:write',
  };
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.info = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorization = url;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
}

const mcpUrl = new URL(`${ORIGIN}/mcp`);
const transportFor = (provider: Provider) => new StreamableHTTPClientTransport(mcpUrl, { authProvider: provider });
const asText = (result: unknown): string =>
  ((result as { content?: { text: string }[] }).content ?? []).map(part => part.text).join('\n');

const provider = new Provider();
let client: Client;
const call = async (name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> => {
  const result = await client.callTool({ name, arguments: args });
  return { text: asText(result), isError: result.isError === true };
};

describe('an MCP client signs in and uses the tools on a real daemon', () => {
  test('the owner confirms the connector at the machine, and it listens at its own address', async () => {
    const put = await daemon.call('PUT', '/v1/config/file', { path: 'connector.yaml', text: CONFIG });
    expect(put.status, put.text).toBe(200);
    for (let wait = 0; wait < 50; wait++) {
      if ((await fetch(`${ORIGIN}/oauth/authorize/wait`).catch(() => undefined))?.status === 400) break;
      await Bun.sleep(100);
    }
    expect(((await daemon.fy(['connector', '--json'])).json as { enabled: boolean }).enabled).toBe(true);
  });

  test('DCR → authorize → the match code → the owner approves at the machine → token → initialize', async () => {
    // First contact has no token: the SDK registers itself, builds the authorization URL and stops at the owner.
    const first = new Client({ name: 'e2e', version: '1' });
    const transport = transportFor(provider);
    await expect(first.connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);
    const authorization = provider.authorization;
    expect(authorization?.origin).toBe(ORIGIN);
    const redirected = await fetch(authorization as URL, { redirect: 'manual' });
    expect(redirected.status).toBe(302);
    const waitUrl = redirected.headers.get('location') ?? '';
    const html = await (await fetch(waitUrl)).text();
    const code = /<strong class="code">([A-Z0-9]{3}-[A-Z0-9]{3})<\/strong>/u.exec(html)?.[1] ?? '';
    expect(code).not.toBe('');
    const approved = await daemon.fy(['connector', 'approve', code]);
    expect(approved.code, approved.err).toBe(0);
    const callback = new URL((await fetch(waitUrl, { redirect: 'manual' })).headers.get('location') ?? '');
    await transport.finishAuth(callback.searchParams.get('code') ?? '');
    expect(provider.tokens()?.access_token).toStartWith('fyc_at_');

    client = new Client({ name: 'e2e', version: '1' });
    await client.connect(transportFor(provider));
    expect(client.getServerVersion()?.name).toBe('ferretry');
  }, 60_000);

  test('tools/list offers all eleven to a fleet:write grant', async () => {
    const names = (await client.listTools()).tools.map(tool => tool.name).sort();
    expect(names).toEqual(
      [
        'answer_attention',
        'get_attention',
        'get_ferret',
        'get_ferret_output',
        'list_attention',
        'list_ferrets',
        'restart_ferret',
        'send_to_ferret',
        'snooze_attention',
        'spawn_ferret',
        'stop_ferret',
      ].sort(),
    );
  });

  test('list_ferrets, get_ferret and get_ferret_output read the real fleet', async () => {
    const listed = await call('list_ferrets');
    expect(listed.text).toContain('3 ferrets running');
    expect(listed.text).toContain('E2e-lead');
    const one = await call('get_ferret', { ferret: 'e2e-lead' });
    expect(one.isError, one.text).toBe(false);
    expect(one.text).toContain('E2e-lead');
    const out = await call('get_ferret_output', { ferret: 'e2e-lead' });
    // A seeded ferret has no transcript: the daemon's own sentence reaches Claude, as a refusal, unchanged.
    expect(out).toEqual({ text: 'session e2e-lead has no transcript this daemon can prove is its own', isError: true });
  });

  test('the agenda: a seeded ask is read whole, its secrets masked, then snoozed and answered', async () => {
    // A real vault value, and an ask a real ferret raised that carries it, a session token, a device token and a digest.
    expect((await daemon.call('POST', '/v1/secrets', { name: 'E2E_VAULT_VALUE', value: VAULT_VALUE })).status).toBe(
      200,
    );
    const added = await daemon.fyAs('e2e-lead', [
      'agenda',
      'add',
      'Which region should the relay use?',
      '--title',
      'Region choice',
      '--premise',
      `The relay ships Friday; token ${SESSION_TOKEN} was printed by mistake`,
      '--context',
      `device ${DEVICE_TOKEN}; digest ${DIGEST}; value ${VAULT_VALUE}`,
      '--option',
      'eu-west',
      '--option',
      'us-east',
      '--ferret',
      'e2e-lead',
      '--json',
    ]);
    expect(added.code, added.err).toBe(0);
    const note = await daemon.fyAs('e2e-lead', [
      'agenda',
      'add',
      'Read the notes',
      '--title',
      'Release notes',
      '--todo',
      '--new',
      'a second, unrelated item',
      '--premise',
      'Friday release',
      '--context',
      'Read them once',
      '--ferret',
      'e2e-lead',
      '--json',
    ]);
    expect(note.code, note.err).toBe(0);

    const list = await call('list_attention');
    expect(list.text).toContain('Region choice');
    const idOf = (title: string) => new RegExp(`!(A\\d+) — from E2e-lead — ${title}`, 'u').exec(list.text)?.[1] ?? '';
    const region = idOf('Region choice');
    const notes = idOf('Release notes');
    expect(region).not.toBe('');
    const whole = await call('get_attention', { item: region });
    expect(whole.isError, whole.text).toBe(false);
    // The raw board DOES hold them (the owner's own read is the daemon's, unmasked), so the masking below is the connector's work.
    const raw = (await daemon.call('GET', '/v1/agenda/open')).text;
    for (const secret of [SESSION_TOKEN, DEVICE_TOKEN, DIGEST]) expect(raw).toContain(secret);
    // The e2e that matters: no credential shape, digest or Vault value reaches Claude, whichever door it leaves by.
    for (const secret of [SESSION_TOKEN, DEVICE_TOKEN, DIGEST, VAULT_VALUE]) {
      expect(whole.text, secret.slice(0, 6)).not.toContain(secret);
      expect(list.text).not.toContain(secret);
    }
    expect(whole.text).toContain('Region choice');

    const snoozed = await call('snooze_attention', { item: region, duration: '2h' });
    expect(snoozed.isError, snoozed.text).toBe(false);
    expect((await call('list_attention')).text).not.toContain('Region choice');
    const open = await daemon.call('GET', '/v1/agenda/open');
    const parked = JSON.parse(open.text) as { sessions: { items: { id: string; parked?: { reason: string } }[] }[] };
    const item = parked.sessions.flatMap(session => session.items).find(entry => entry.id === region);
    expect(item?.parked?.reason).toBe('snoozed');

    const answered = await call('answer_attention', { item: notes, answer: 'read it' });
    expect(answered.isError, answered.text).toBe(false);
    expect((await call('list_attention')).text).not.toContain('Release notes');
  }, 60_000);

  test('send_to_ferret, restart_ferret, stop_ferret and spawn_ferret go through the real routes, and the journal names the connector', async () => {
    const sent = await call('send_to_ferret', { ferret: 'e2e-lead', message: 'please look at the relay' });
    // A seeded ferret has no live agent: the daemon's own sentence reaches Claude as it is, as a failure, and is recorded.
    expect(sent).toEqual({ text: 'session e2e-lead has no live agent to type into; revive it first', isError: true });
    const restarted = await call('restart_ferret', { ferret: 'e2e-helper' });
    expect(restarted).toEqual({
      text: 'E2e-helper is busy, so I queued the restart for when it is idle.',
      isError: false,
    });
    const stopped = await call('stop_ferret', { ferret: 'e2e-helper' });
    expect(stopped.isError, stopped.text).toBe(false);
    expect(JSON.parse((await daemon.call('GET', '/v1/ferrets/e2e-helper')).text).state).toBe('stopped');
    expect(
      (await daemon.call('POST', '/v1/projects', { kind: 'existing-folder', path: project, name: 'e2e-project' }))
        .status,
    ).toBeLessThan(300);
    // The daemon will not write a credential under a state home others can write; this box's umask makes one.
    for (const dir of ['', 'state', 'state/ferrets']) await chmod(join(daemon.home, dir), 0o700);
    const spawned = await call('spawn_ferret', { task: 'check the relay', project: 'e2e-project' });
    // The start passed Gate (fleet.configure for the connector principal), the project fence and the start checks, and was
    // stopped only at the launch itself, by this daemon's test mode (it will not run a real agent): the daemon's own sentence.
    expect(spawned.isError).toBe(true);
    expect(spawned.text).toContain('test mode refused to launch a real claude/codex');

    // Whoever did it, the machine's own log names the connector — never this computer — against the grant.
    const audit = (await daemon.call('GET', '/v1/audit')).text;
    expect(audit).toContain('connector.tool');
    expect(audit).toContain('"kind":"connector"');
  }, 60_000);

  test("the operator's daemon-wide grants narrow the connector call by call: restart and spawn need fleet.configure, every tool needs fleet.use", async () => {
    const grants = async (text: string) => {
      const put = await daemon.call('PUT', '/v1/config/file', { path: 'gate.yaml', text });
      expect(put.status, put.text).toBe(200);
    };
    const configureOff = 'The machine owner has turned off remote fleet access (fleet.configure), which this needs.';
    try {
      await grants('grants:\n  fleet:\n    configure: false\n');
      expect(await call('restart_ferret', { ferret: 'e2e-lead' })).toEqual({ text: configureOff, isError: true });
      expect(await call('spawn_ferret', { task: 'x', project: 'e2e-project' })).toEqual({
        text: configureOff,
        isError: true,
      });
      // Reading and the fleet.use acts are untouched by a narrowed configure axis.
      expect((await call('list_ferrets')).isError).toBe(false);
      await grants('grants:\n  fleet:\n    use: false\n');
      const refused = 'The machine owner has turned off remote fleet access (fleet.use).';
      for (const name of ['list_ferrets', 'list_attention'] as const)
        expect(await call(name)).toEqual({ text: refused, isError: true });
    } finally {
      await grants('grants: {}\n');
    }
    expect((await call('list_ferrets')).isError).toBe(false);
  }, 60_000);

  test('the 31st agenda call in a minute is a 429 with Retry-After, and a stranger still gets only a 401', async () => {
    const token = provider.tokens()?.access_token ?? '';
    const act = async () =>
      await fetch(mcpUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'snooze_attention', arguments: { item: 'A9999', duration: '1h' } },
        }),
      });
    let limited: Response | undefined;
    for (let n = 0; n < 35 && limited === undefined; n += 1) {
      const answer = await act();
      if (answer.status === 429) limited = answer;
      else expect(answer.status).toBe(200);
    }
    expect(limited?.status).toBe(429);
    expect(Number(limited?.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(
      (await fetch(mcpUrl, { method: 'POST', headers: { authorization: `Bearer fyc_at_${'x'.repeat(43)}` } })).status,
    ).toBe(401);
  }, 60_000);

  test('nothing the daemon wrote holds a token, and the calls log is 0600 and names write tools only', async () => {
    const token = provider.tokens()?.access_token ?? '';
    const refresh = provider.tokens()?.refresh_token ?? '';
    const dir = join(daemon.home, 'state/connector');
    const calls = await readFile(join(dir, 'calls.jsonl'), 'utf8');
    expect((await stat(join(dir, 'calls.jsonl'))).mode & 0o777).toBe(0o600);
    const tools = new Set(
      calls
        .trim()
        .split('\n')
        .map(line => (JSON.parse(line) as { tool: string }).tool),
    );
    for (const read of ['list_ferrets', 'get_ferret', 'get_ferret_output', 'list_attention', 'get_attention'])
      expect(tools.has(read), read).toBe(false);
    for (const secret of [token, refresh, SESSION_TOKEN, DEVICE_TOKEN, DIGEST, VAULT_VALUE]) {
      expect(calls).not.toContain(secret);
      expect((await daemon.call('GET', '/v1/audit')).text).not.toContain(secret);
    }
  });

  test('the owner revokes the grant: the next call is a 401 that says how to reconnect', async () => {
    const grants = (await daemon.fy(['connector', '--json'])).json as { grants: { id: string }[] };
    const revoked = await daemon.fy(['connector', 'revoke', grants.grants[0]?.id ?? '']);
    expect(revoked.code, revoked.err).toBe(0);
    const answer = await fetch(mcpUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${provider.tokens()?.access_token ?? ''}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    expect(answer.status).toBe(401);
    expect(answer.headers.get('www-authenticate')).toContain('invalid_token');
    expect(((await answer.json()) as { error_description: string }).error_description).toBe(DEAD_CONNECTION_TEXT);
  });
});
