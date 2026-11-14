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
        : new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } });
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
    'literal (quotes escaped, as JSON requires)': token => token.replaceAll('"', '\\"'),
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
    expect(outcome.statusText).toBe('[redacted]');
    expect(outcome.headers['www-authenticate']).toBe('[redacted]');
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
      ['other charset', new Response('x', { headers: { 'content-type': 'application/json; charset=utf-16' } })],
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

describe('decode, check, drop: what the reply says is parsed in the Vault and a string that reads as the value goes whole', () => {
  const TOKEN = 'FAKE/MCP+TOKEN"0123456789';
  const MARK = '[redacted]';
  const sent = (bearer: string) => bearer.replace(/^Bearer /u, '');
  const jsonReply = (body: string, type = 'application/json'): Response =>
    new Response(body, { headers: { 'content-type': type } });
  const hexOf = (text: string) => Buffer.from(text).toString('hex');
  /** Alternating upper and lower case. */
  const mixedHex = (text: string) =>
    [...hexOf(text)].map((char, index) => (index % 2 === 0 ? char.toUpperCase() : char)).join('');
  /** Folded the way a mail client folds base64: a line break (or a space) every eight characters. */
  const folded = (text: string, glue: string) => (text.match(/.{1,8}/gu) ?? []).join(glue);
  const b64 = (token: string) => Buffer.from(`id=${token};`).toString('base64');
  const entity = (token: string, kind: 'hex' | 'dec' | 'named' | 'mixed') =>
    [...token]
      .map((char, index) => {
        const code = char.charCodeAt(0);
        const named: Record<string, string> = { '/': '&sol;', '+': '&plus;', '"': '&quot;', '-': '&hyphen;' };
        if (kind === 'hex') return `&#x${code.toString(16)};`;
        if (kind === 'dec') return `&#${code};`;
        if (kind === 'named') return named[char] ?? char;
        return index % 3 === 0 ? `&#X${code.toString(16).toUpperCase()};` : (named[char] ?? char);
      })
      .join('');

  /** `token` with only some bytes percent-escaped, in a mix of hex-digit cases. */
  const partialPercent = (token: string) =>
    token
      .replaceAll('/', '%2f')
      .replaceAll('+', '%2B')
      .replaceAll('"', '%22')
      .replaceAll('-', '%2d')
      .replace('0123', '%30%31%32%33');
  /** `%xX`: one digit of each escape upper, the other lower. */
  const crossCase = (token: string) =>
    [...token]
      .map((char, index) =>
        index % 2 === 0
          ? `%${char
              .charCodeAt(0)
              .toString(16)
              .padStart(2, '0')
              .replace(/.$/u, d => d.toUpperCase())}`
          : char,
      )
      .join('');

  const spellings: Record<string, (token: string) => string> = {
    'partial percent-encoding': partialPercent,
    'mixed-case %xX': crossCase,
    'mixed-case hex': mixedHex,
    'whitespace-folded base64 (newlines)': token => folded(b64(token), '\n'),
    'whitespace-folded base64 (spaces)': token => folded(b64(token), ' '),
    'whitespace-folded base64url': token => folded(b64(token).replaceAll('+', '-').replaceAll('/', '_'), '\n'),
    'HTML entities (hex)': token => entity(token, 'hex'),
    'HTML entities (decimal)': token => entity(token, 'dec'),
    'HTML entities (named)': token => entity(token, 'named'),
    'HTML entities (mixed, upper X)': token => entity(token, 'mixed'),
    'double-encoded': token => encodeURIComponent(encodeURIComponent(token)),
    'base64 of a percent-encoding': token => Buffer.from(encodeURIComponent(token)).toString('base64'),
  };

  for (const [name, spell] of Object.entries(spellings))
    test(`a string that holds the value ${name} is replaced whole, in a value, a key and a nested array`, async () => {
      const { of } = await world(bearer =>
        jsonReply(
          JSON.stringify({
            [`k ${spell(sent(bearer))}`]: { deep: [`before ${spell(sent(bearer))} after`] },
            keep: 'an ordinary string',
            count: 3,
          }),
        ),
      );
      await of('mcp').put(ACCESS, TOKEN);

      const outcome = await of('mcp').fetchMinted?.(ACCESS, exchange());
      if (outcome === undefined) throw new Error('no exchange');
      const body = await text(outcome);

      expect(body).toBe(JSON.stringify({ [MARK]: { deep: [MARK] }, keep: 'an ordinary string', count: 3 }));
    });

  test('statusText and every kept header are checked the same way, and only the allowlist is kept', async () => {
    const { of } = await world(
      bearer =>
        new Response('{}', {
          statusText: `Nope ${partialPercent(sent(bearer))}`,
          headers: {
            'content-type': 'application/json',
            'www-authenticate': `Bearer realm="${entity(sent(bearer), 'dec')}"`,
            'mcp-session-id': folded(b64(sent(bearer)), ' '),
            'retry-after': '7',
            'x-token-echo': sent(bearer),
          },
        }),
    );
    await of('mcp').put(ACCESS, TOKEN);
    const outcome = await of('mcp').fetchMinted?.(ACCESS, exchange());
    if (outcome?.kind !== 'response') throw new Error('no response');
    expect(outcome.statusText).toBe(MARK);
    expect(outcome.headers).toEqual({
      'content-type': 'application/json',
      'www-authenticate': MARK,
      'mcp-session-id': MARK,
      'retry-after': '7',
    });
  });

  test('an event stream: data is parsed as JSON and checked; event and id are checked; a comment and an unknown field are dropped', async () => {
    const { of } = await world(bearer => {
      const echo = crossCase(sent(bearer));
      return jsonReply(
        `: ${sent(bearer)}\nevent: ${echo}\nid: 7\nx-extra: ${sent(bearer)}\nretry: 1500\ndata: {"t":"${echo}","n":1}\n\nevent: message\ndata: not json ${entity(sent(bearer), 'hex')}\n\n`,
        'text/event-stream',
      );
    });
    await of('mcp').put(ACCESS, TOKEN);
    const outcome = await of('mcp').fetchMinted?.(ACCESS, exchange());
    expect(await text(outcome as MintedExchangeOutcome)).toBe(
      `event: ${MARK}\nid: 7\nretry: 1500\ndata: {"t":"${MARK}","n":1}\n\nevent: message\ndata: ${MARK}\n\n`,
    );
  });

  test('a string that only looks a little like the value, and ordinary text, pass untouched', async () => {
    const { of } = await world(() =>
      jsonReply(
        JSON.stringify({
          a: 'FAKE/MCP+TOKEN',
          b: 'Zm9vYmFy',
          c: '20260101',
          d: 'a%20b &amp; c',
          e: 'application/json',
        }),
      ),
    );
    await of('mcp').put(ACCESS, TOKEN);
    const body = await text((await of('mcp').fetchMinted?.(ACCESS, exchange())) as MintedExchangeOutcome);
    expect(JSON.parse(body)).toEqual({
      a: 'FAKE/MCP+TOKEN',
      b: 'Zm9vYmFy',
      c: '20260101',
      d: 'a%20b &amp; c',
      e: 'application/json',
    });
  });

  test('GAP (declared): a value split across TWO JSON strings is not found, because no one string holds it', async () => {
    const { of } = await world(bearer => {
      const value = sent(bearer);
      return jsonReply(JSON.stringify({ first: value.slice(0, 12), second: value.slice(12) }));
    });
    await of('mcp').put(ACCESS, TOKEN);
    const body = await text((await of('mcp').fetchMinted?.(ACCESS, exchange())) as MintedExchangeOutcome);
    expect(JSON.parse(body)).toEqual({ first: TOKEN.slice(0, 12), second: TOKEN.slice(12) });
  });

  const nonJson: [string, string, string][] = [
    ['HTML', 'text/html; charset=utf-8', '<p>token: FAKE&#x2F;MCP</p>'],
    ['XML', 'application/xml', '<t>FAKE/MCP+TOKEN"0123456789</t>'],
    ['plain text', 'text/plain', 'FAKE/MCP+TOKEN"0123456789'],
    ['NDJSON', 'application/x-ndjson', '{"a":"FAKE/MCP+TOKEN\\"0123456789"}\n'],
    ['binary', 'application/octet-stream', 'FAKE/MCP+TOKEN"0123456789'],
  ];
  for (const [label, type, body] of nonJson)
    test(`${label} is dropped with a sentence, never returned`, async () => {
      const { of } = await world(() => jsonReply(body, type));
      await of('mcp').put(ACCESS, TOKEN);
      const outcome = await of('mcp').fetchMinted?.(ACCESS, exchange());
      if (outcome?.kind !== 'response') throw new Error('no response');
      expect(outcome.body).toEqual({
        kind: 'dropped',
        why: 'The server’s answer is not JSON, so the Vault could not check it for the sign-in and kept it.',
      });
    });

  test('FAILS CLOSED past the decoder round cap: a chain too deep to finish is dropped (body) or replaced (metadata), never returned as checked', async () => {
    const layered = (token: string) => {
      let value = `id=${token};`;
      for (let layer = 0; layer < 9; layer += 1) value = Buffer.from(value).toString('base64');
      return value;
    };
    const { of } = await world(
      bearer =>
        new Response(JSON.stringify({ echo: layered(sent(bearer)) }), {
          statusText: `Nope ${layered(sent(bearer))}`,
          headers: { 'content-type': 'application/json', 'mcp-session-id': layered(sent(bearer)) },
        }),
    );
    await of('mcp').put(ACCESS, TOKEN);
    const outcome = await of('mcp').fetchMinted?.(ACCESS, exchange());
    if (outcome?.kind !== 'response') throw new Error('no response');
    expect(outcome.body).toEqual({
      kind: 'dropped',
      why: 'The server’s answer was too deep or too long to check for the sign-in, so the Vault kept it.',
    });
    expect(outcome.statusText).toBe(MARK);
    expect(outcome.headers['mcp-session-id']).toBe(MARK);
  });

  test('a body with a JSON type that is not JSON is dropped with its own sentence', async () => {
    const { of } = await world(() => jsonReply('{"a": FAKE/MCP+TOKEN"0123456789'));
    await of('mcp').put(ACCESS, TOKEN);
    const outcome = await of('mcp').fetchMinted?.(ACCESS, exchange());
    expect(await text(outcome as MintedExchangeOutcome)).toContain('not valid JSON');
  });

  test('FAILS CLOSED past a bound: a body nested too deep, or with too many values, is dropped', async () => {
    const deep = `${'['.repeat(200)}"x"${']'.repeat(200)}`;
    const wide = JSON.stringify({ items: Array.from({ length: 210_000 }, () => 1) });
    for (const body of [deep, wide]) {
      const { of } = await world(() => jsonReply(body));
      await of('mcp').put(ACCESS, TOKEN);
      const outcome = await of('mcp').fetchMinted?.(ACCESS, { ...exchange(), maxBodyBytes: 4 * 1024 * 1024 });
      if (outcome?.kind !== 'response') throw new Error('no response');
      expect(outcome.body).toEqual({
        kind: 'dropped',
        why: 'The server’s answer was too deep or too long to check for the sign-in, so the Vault kept it.',
      });
      await hosts.splice(0)[0]?.stop();
    }
  });

  test('FAILS CLOSED past a bound: a body larger than the read limit is dropped, not clipped', async () => {
    const { of } = await world(() => jsonReply(JSON.stringify({ big: 'x'.repeat(5000) })));
    await of('mcp').put(ACCESS, TOKEN);
    const outcome = await of('mcp').fetchMinted?.(ACCESS, { ...exchange(), maxBodyBytes: 100 });
    if (outcome?.kind !== 'response') throw new Error('no response');
    expect(outcome.body.kind).toBe('dropped');
  });

  test('the check is made against the value AS SENT: an owner replacing the secret in flight changes nothing', async () => {
    let replace: () => Promise<void> = async () => undefined;
    const { core, of } = await world(bearer => {
      void replace();
      return jsonReply(JSON.stringify({ echo: partialPercent(sent(bearer)) }));
    });
    await of('mcp').put(ACCESS, TOKEN);
    replace = async () => await core.put(ACCESS, 'FAKE-OWNER-NEW-VALUE-123');
    const body = await text((await of('mcp').fetchMinted?.(ACCESS, exchange())) as MintedExchangeOutcome);
    expect(body).toBe(JSON.stringify({ echo: MARK }));
  });
});
