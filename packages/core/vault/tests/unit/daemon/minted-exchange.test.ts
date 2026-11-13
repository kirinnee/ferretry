import { afterEach, describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeGate } from '@ferretry/core-gate/contract/testing';
import { definePlugin, implementDaemon, type Permissions } from '@ferretry/kernel/manifest';
import { type TestHost, testHost } from '@ferretry/kernel/testing';
import { type MintedExchangeOutcome, type SecretName, VaultFile, VaultPort } from '../../../contract/index.ts';
import vault from '../../../daemon/index.ts';

/**
 * A plugin may have the Vault place a secret on a request only when THAT plugin wrote the secret's current value (the
 * Vault's own mint ledger), and it never receives the value: what comes back is the server's reply with the credential
 * masked out of it. A name that merely matches the manifest's minted pattern is not enough.
 */
const FAKE_TOKEN = 'FAKE-MCP-TOKEN-0123456789';
const ACCESS = 'MCP_WORK_0123456789ABCDEF_ACCESS' as SecretName;
const MINTING: Permissions = {
  network: ['mcp.example.test'],
  spawn: [],
  secrets: [],
  mintedSecrets: ['MCP_(?:[A-Z0-9_]+_)?[0-9A-F]{16}_ACCESS'],
};
const URL_OK = 'https://mcp.example.test/rpc';
const hosts: TestHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
});

const tenant = (id: string, permissions: Permissions) =>
  implementDaemon(
    definePlugin({
      id,
      title: id,
      version: '1.0.0',
      api: 5,
      core: false,
      kinds: [],
      needs: { vault: VaultPort },
      permissions,
    }),
    { build: () => ({}) },
  );

type Reply = (bearer: string, url: URL) => Response;

async function world(echo: boolean | Reply = false) {
  const seen: { host: string; headers: Record<string, string>; redirect: string | undefined }[] = [];
  const host = await testHost({
    plugins: [vault, tenant('mcp', MINTING), tenant('other', MINTING)],
    fakes: { asks: new FakeAsks(), gate: new FakeGate() },
    fetch: (url, init) => {
      seen.push({
        host: url.host,
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        redirect: init?.redirect,
      });
      const header = new Headers(init?.headers).get('authorization') ?? '';
      if (typeof echo === 'function') return echo(header, url);
      return echo
        ? new Response(`{"echo":"${header}"}`, { headers: { 'x-echo': header, 'content-type': 'application/json' } })
        : new Response('{"ok":true}');
    },
  });
  hosts.push(host);
  await host.runJob('inputs-restore');
  return {
    core: host.provided(VaultPort),
    of: (id: string) => host.provided(VaultPort, id),
    seen,
    state: host.state('vault'),
  };
}

const exchange = (url = URL_OK) => ({
  method: 'POST' as const,
  url,
  headers: { accept: 'application/json' },
  body: '{}',
});
const text = async (outcome: MintedExchangeOutcome): Promise<string> => {
  if (outcome.kind !== 'response') throw new Error(`no response: ${outcome.kind}`);
  if (outcome.body.kind === 'text') return outcome.body.text;
  if (outcome.body.kind === 'dropped') return `DROPPED: ${outcome.body.why}`;
  let all = '';
  for (const reader = outcome.body.events.getReader(); ; ) {
    const read = await reader.read();
    if (read.done) return all;
    all += read.value;
  }
};
/** Everything a plugin could read off an outcome, as one string. */
const everything = async (outcome: MintedExchangeOutcome): Promise<string> =>
  outcome.kind === 'response'
    ? JSON.stringify({ ...outcome, body: undefined }) + (await text(outcome))
    : JSON.stringify(outcome);

describe('a plugin places only a secret it minted, and never holds it', () => {
  test('a secret the plugin put itself is placed on the request as a bearer, and the reply carries no value', async () => {
    const { of, seen } = await world(true);
    const api = of('mcp');
    await api.put(ACCESS, FAKE_TOKEN);

    const outcome = await api.fetchMinted?.(ACCESS, exchange());
    if (outcome === undefined) throw new Error('the Vault offers no minted exchange');

    expect(seen[0]?.headers.authorization).toBe(`Bearer ${FAKE_TOKEN}`);
    expect(seen[0]?.redirect).toBe('manual');
    const body = await text(outcome);
    expect(body).not.toContain(FAKE_TOKEN);
    expect(body).toContain('[redacted]');
    // the echo header is not on the allowlist, so it is not passed on at all
    if (outcome.kind === 'response') expect(outcome.headers['x-echo']).toBeUndefined();
  });

  test('a value the OWNER put under a name the minted pattern matches is refused, and nothing is sent', async () => {
    const { core, of, seen } = await world();
    await core.put(ACCESS, FAKE_TOKEN);

    expect(await of('mcp').fetchMinted?.(ACCESS, exchange())).toEqual({ kind: 'refused' });
    expect(seen).toEqual([]);
  });

  test('a value the owner REPLACES after the plugin minted it is no longer the plugin’s', async () => {
    const { core, of, seen } = await world();
    await of('mcp').put(ACCESS, FAKE_TOKEN);
    await core.put(ACCESS, 'FAKE-OWNER-VALUE');

    expect(await of('mcp').fetchMinted?.(ACCESS, exchange())).toEqual({ kind: 'refused' });
    expect(seen).toEqual([]);
  });

  test('another plugin that mints the same pattern cannot place what MCP minted', async () => {
    const { of, seen } = await world();
    await of('mcp').put(ACCESS, FAKE_TOKEN);

    expect(await of('other').fetchMinted?.(ACCESS, exchange())).toEqual({ kind: 'refused' });
    expect(seen).toEqual([]);
  });

  test('a destination the plugin’s own manifest does not allow is refused, with the minted secret', async () => {
    const { of, seen } = await world();
    await of('mcp').put(ACCESS, FAKE_TOKEN);

    expect(await of('mcp').fetchMinted?.(ACCESS, exchange('https://elsewhere.example.test/rpc'))).toEqual({
      kind: 'refused',
    });
    expect(seen).toEqual([]);
  });

  test('a request that already carries the credential header is refused', async () => {
    const { of, seen } = await world();
    await of('mcp').put(ACCESS, FAKE_TOKEN);

    const asked = { ...exchange(), headers: { Authorization: 'Bearer mine' } };
    expect(await of('mcp').fetchMinted?.(ACCESS, asked)).toEqual({ kind: 'refused' });
    expect(seen).toEqual([]);
  });

  test('the plugin’s port still has no way to read a value: only names go in, only a masked reply comes out', async () => {
    const { of } = await world(true);
    const api = of('mcp');
    await api.put(ACCESS, FAKE_TOKEN);
    const outcome = (await api.fetchMinted?.(ACCESS, exchange())) as MintedExchangeOutcome;
    expect(await everything(outcome)).not.toContain(FAKE_TOKEN);
    expect(Object.keys(api).filter(key => /^(get|read|reveal|values)/iu.test(key))).toEqual([]);
  });

  test('a caller-set Host header is refused, and nothing is sent', async () => {
    const { of, seen } = await world();
    await of('mcp').put(ACCESS, FAKE_TOKEN);

    for (const host of ['Host', 'host'])
      expect(
        await of('mcp').fetchMinted?.(ACCESS, { ...exchange(), headers: { [host]: 'other.example.test' } }),
      ).toEqual({ kind: 'refused' });
    expect(seen).toEqual([]);
  });
});

describe('the value authorized is the value sent (one immutable entry)', () => {
  const REPLACEMENT = 'FAKE-OWNER-REPLACEMENT-9876';

  test('an owner overwrite that lands BETWEEN the authorization steps never sends the replacement', async () => {
    const { core, of, seen, state } = await world();
    await of('mcp').put(ACCESS, FAKE_TOKEN);
    const minted = state.rawBytes(VaultFile);
    await core.put(ACCESS, REPLACEMENT);
    const replaced = state.rawBytes(VaultFile);
    if (minted === undefined || replaced === undefined) throw new Error('the vault file is not there');
    // back to the plugin's own entry, and the owner's write is armed to land the moment the mint ledger is read
    state.bytes.set('vault.json', minted);
    const read = state.files.get.bind(state.files);
    let landed = 0;
    state.files.get = (key: string) => {
      if (key === 'mints.json' && landed === 0) {
        landed += 1;
        state.bytes.set('vault.json', replaced);
      }
      return read(key);
    };

    const outcome = await of('mcp').fetchMinted?.(ACCESS, exchange());

    expect(landed).toBe(1);
    expect(seen.map(call => call.headers.authorization)).not.toContain(`Bearer ${REPLACEMENT}`);
    // what was authorized is what was sent: the plugin's own value, or nothing at all
    expect(seen.every(call => call.headers.authorization === `Bearer ${FAKE_TOKEN}`)).toBe(true);
    expect(outcome?.kind === 'response' || outcome?.kind === 'refused').toBe(true);
  });

  test('another plugin that mints in the same instant ends the old authorization', async () => {
    const { of, seen, state } = await world();
    await of('mcp').put(ACCESS, FAKE_TOKEN);
    const read = state.files.get.bind(state.files);
    let armed = true;
    state.files.get = (key: string) => {
      const value = read(key);
      if (key === 'mints.json' && armed) {
        armed = false;
        // the ledger now names a newer write of the same name by somebody else
        return value?.replace(/"write":"[^"]+"/u, '"write":"another-write"');
      }
      return value;
    };

    expect(await of('mcp').fetchMinted?.(ACCESS, exchange())).toEqual({ kind: 'refused' });
    expect(seen).toEqual([]);
  });
});

describe('the reply is built inside the Vault and carries the value in no spelling', () => {
  const TOKEN = 'FAKE/MCP+TOKEN"0123456789';
  const DEMO = 'FAKE-DEMO-0123456789ABC';
  const json = (value: unknown): Response =>
    new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
  /** A JSON body written out by hand, so an escape in it stays an escape on the wire. */
  const wire = (body: string): Response => new Response(body, { headers: { 'content-type': 'application/json' } });
  const sent = (bearer: string) => bearer.replace(/^Bearer /u, '');
  const mix = (token: string) =>
    [...token]
      .map((char, index) =>
        index % 2 === 0 && char !== '"' ? char : `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
      )
      .join('');
  const b64 = (token: string, lead: number) => Buffer.from(`${'x'.repeat(lead)}${token}tail`).toString('base64');

  const forms: Record<string, (token: string) => string> = {
    literal: token => token,
    'JSON-escaped (quotes and \\/)': token => JSON.stringify(token).slice(1, -1).replaceAll('/', '\\/'),
    'all \\uXXXX': token => [...token].map(char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`).join(''),
    'mixed escapes': mix,
    'URL-encoded': token => encodeURIComponent(token),
    'form-encoded': token => encodeURIComponent(token).replaceAll('%20', '+'),
    'base64 (aligned)': token => b64(token, 0),
    'base64 (one byte in)': token => b64(token, 1),
    'base64 (two bytes in)': token => b64(token, 2),
    base64url: token => b64(token, 1).replaceAll('+', '-').replaceAll('/', '_'),
    hex: token => Buffer.from(token).toString('hex'),
    HEX: token => Buffer.from(token).toString('hex').toUpperCase(),
  };

  for (const [name, spell] of Object.entries(forms))
    test(`body, spelled ${name}`, async () => {
      const { of } = await world(bearer => wire(`{"echo":"${spell(sent(bearer))}","ok":true}`));
      await of('mcp').put(ACCESS, TOKEN);

      const outcome = await of('mcp').fetchMinted?.(ACCESS, exchange());
      if (outcome === undefined) throw new Error('no exchange');
      const body = await text(outcome);

      const raw = spell(TOKEN);
      expect(body).not.toContain(raw.slice(4, 22));
      expect(body).not.toContain(TOKEN);
      expect(body).toContain('[redacted]');
    });

  test('a JSON key and a nested string are masked after the parse, whatever mix of escapes spelled them', async () => {
    const { of } = await world(bearer => wire(`{"${mix(sent(bearer))}":{"deep":["x ${mix(sent(bearer))} y"]}}`));
    await of('mcp').put(ACCESS, TOKEN);
    const body = await text((await of('mcp').fetchMinted?.(ACCESS, exchange())) as MintedExchangeOutcome);
    expect(body).not.toContain(TOKEN);
    expect(body).toContain('[redacted]');
  });

  test('a value split across the reply’s chunks is still masked', async () => {
    const { of } = await world(bearer => {
      const echo = `{"a":"${sent(bearer)}"}`;
      const cut = Math.floor(echo.length / 2);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(echo.slice(0, cut)));
            controller.enqueue(new TextEncoder().encode(echo.slice(cut)));
            controller.close();
          },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    });
    await of('mcp').put(ACCESS, DEMO);
    const body = await text((await of('mcp').fetchMinted?.(ACCESS, exchange())) as MintedExchangeOutcome);
    expect(body).toBe('{"a":"[redacted]"}');
  });

  test('an event stream arrives as whole masked events, whatever its chunks', async () => {
    const { of } = await world(bearer => {
      const echo = `event: message\ndata: {"t":"${mix(sent(bearer))}"}\n\n`;
      const cut = Math.floor(echo.length / 3);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(echo.slice(0, cut)));
            controller.enqueue(new TextEncoder().encode(echo.slice(cut)));
            controller.close();
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    });
    await of('mcp').put(ACCESS, TOKEN);
    const outcome = await of('mcp').fetchMinted?.(ACCESS, exchange());
    if (outcome?.kind !== 'response' || outcome.body.kind !== 'events') throw new Error('not an event stream');
    const events = await text(outcome);
    expect(events).toBe('event: message\ndata: {"t":"[redacted]"}\n\n');
  });

  test('statusText and headers carry no value, and only a short list of headers is passed at all', async () => {
    const { of } = await world(
      bearer =>
        new Response('{}', {
          statusText: `Nope ${sent(bearer)}`,
          headers: {
            'content-type': 'application/json',
            'www-authenticate': `Bearer realm="${sent(bearer)}"`,
            'x-token-echo': sent(bearer),
            [sent(bearer)
              .toLowerCase()
              .replaceAll(/[^a-z0-9-]/gu, '')]: 'v',
          },
        }),
    );
    await of('mcp').put(ACCESS, DEMO);
    const outcome = await of('mcp').fetchMinted?.(ACCESS, exchange());
    if (outcome?.kind !== 'response') throw new Error('no response');
    expect(outcome.statusText).toBe('Nope [redacted]');
    expect(outcome.headers['www-authenticate']).toBe('Bearer realm="[redacted]"');
    expect(Object.keys(outcome.headers).sort()).toEqual(['content-type', 'www-authenticate']);
    expect(await everything(outcome)).not.toContain(DEMO);
  });

  test('masks against the value AS SENT even if the owner replaces the secret while the reply is in flight', async () => {
    let replace: () => Promise<void> = async () => undefined;
    const { core, of } = await world(bearer => {
      void replace();
      return wire(`{"echo":"${mix(sent(bearer))}"}`);
    });
    await of('mcp').put(ACCESS, TOKEN);
    replace = async () => await core.put(ACCESS, 'FAKE-OWNER-NEW-VALUE-123');
    const body = await text((await of('mcp').fetchMinted?.(ACCESS, exchange())) as MintedExchangeOutcome);
    expect(body).not.toContain(TOKEN);
    expect(body).toContain('[redacted]');
  });

  test('FAILS CLOSED: a compressed, binary, undecodable, non-text or oversized body is dropped with a reason', async () => {
    const cases: [string, Response][] = [
      [
        'compressed',
        new Response('x', { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }),
      ],
      ['binary', new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'application/octet-stream' } })],
      [
        'bad utf-8',
        new Response(new Uint8Array([0xff, 0xfe, 0xfd]), { headers: { 'content-type': 'application/json' } }),
      ],
      ['other charset', new Response('x', { headers: { 'content-type': 'text/plain; charset=utf-16' } })],
      ['no type', new Response(new Uint8Array([65]), { headers: {} })],
    ];
    for (const [label, reply] of cases) {
      const { of } = await world(() => reply);
      await of('mcp').put(ACCESS, DEMO);
      const outcome = await of('mcp').fetchMinted?.(ACCESS, exchange());
      if (outcome?.kind !== 'response') throw new Error(`${label}: no response`);
      expect(outcome.body.kind).toBe('dropped');
      expect(await text(outcome)).toContain('Vault');
      await hosts.splice(0)[0]?.stop();
    }
    const { of } = await world(() => json({ big: 'x'.repeat(2000) }));
    await of('mcp').put(ACCESS, DEMO);
    const big = await of('mcp').fetchMinted?.(ACCESS, { ...exchange(), maxBodyBytes: 100 });
    expect(big?.kind === 'response' && big.body.kind).toBe('dropped');
  });
});
