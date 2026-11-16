/**
 * NN2 / D2 #19 `kernel.secrets.send`: the KERNEL places a plugin's OWN secret on one request, so the plugin never holds
 * it (today's `OutboundProviderAuthorizer.send`, its destination / placement / echo rules copied). Each rule is broken
 * in turn by one test below; the planted-value scan at the end proves no outcome, log line or thrown message carries
 * the value.
 */
import { describe, expect, test } from 'bun:test';
import { milliseconds } from '@ferretry/std';
import { z } from 'zod';
import { defineConfig } from '../../../contract/define.ts';
import type { Log, LogFields } from '../../../contract/ports.ts';
import type { OutboundSecretRequest, SecretsPort } from '../../../contract/secrets.ts';
import { outboundSecretTransport } from '../../../host/adapters/outbound-secret.ts';
import { exactNetworkHosts, ownSecretsPort } from '../../../host/secrets.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { fixedClock } from '../../../testing/clock.ts';
import { testHost } from '../../../testing/index.ts';

const VALUE = 'sk-planted-jev-value-6f1c';
const KeyFile = defineConfig({
  file: 'jevish/keys.yaml',
  schema: z.strictObject({ key: z.string().optional(), spare: z.string().optional() }),
  axis: 'configure',
  loosens: () => [],
});

const manifest = definePlugin({
  id: 'jevish',
  title: 'Jevish',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: [],
  permissions: {
    network: ['api.jev.test', '*.wild.test', 'localhost', '*'],
    secrets: ['JEV_KEY', 'NOT_IN_CONFIG', 'BLANK_KEY', 'MISSING_KEY'],
  },
  data: { config: [KeyFile] },
});

const POST: OutboundSecretRequest = {
  method: 'POST',
  url: 'https://api.jev.test/v1/check',
  headers: { 'content-type': 'application/json' },
  body: '{"q":1}',
  timeoutMs: 5_000,
  maxResponseBytes: 1_024,
};

interface Sent {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function world(reply: (url: URL) => Response | Promise<Response> = () => json({ ok: true })) {
  let secrets: SecretsPort | undefined;
  const sent: Sent[] = [];
  const asked: string[] = [];
  const half = implementDaemon(manifest, {
    build: ({ kernel }) => {
      secrets = kernel.secrets;
      return {};
    },
  });
  const host = await testHost({
    plugins: [half],
    config: {
      'jevish/keys.yaml': { key: 'Bearer ${secret:JEV_KEY}', spare: '${secret:BLANK_KEY} ${secret:MISSING_KEY}' },
    },
    vault: new Proxy({ JEV_KEY: `  ${VALUE}\n`, BLANK_KEY: '   ', NOT_IN_CONFIG: 'x' } as Record<string, string>, {
      get: (target, name) => {
        asked.push(String(name));
        return target[String(name)];
      },
    }),
    fetch: async (url, init) => {
      sent.push({ url: url.href, init });
      return await reply(url);
    },
  });
  if (secrets === undefined) throw new Error('not built');
  return { host, secrets, sent, asked };
}

const headersOf = (sent: Sent): Record<string, string> => ({ ...(sent.init?.headers as Record<string, string>) });

describe('NN2 D2 #19 kernel.secrets.send: the kernel places the credential, the plugin never holds it', () => {
  test('declared, configured and known: the value goes on the request as authorization: Bearer, and only facts come back', async () => {
    const { host, secrets, sent } = await world(() => json({ answers: { triage: 'ok' } }));
    const outcome = await secrets.send('JEV_KEY', POST);
    expect(outcome).toEqual({ kind: 'completion', status: 200, payload: { answers: { triage: 'ok' } } });
    expect(sent).toHaveLength(1);
    expect(headersOf(sent[0] as Sent)).toEqual({
      'content-type': 'application/json',
      authorization: `Bearer ${VALUE}`,
    });
    expect(sent[0]?.init?.method).toBe('POST');
    expect(sent[0]?.init?.body).toBe('{"q":1}');
    await host.stop();
  });

  test('a placement names the header and the scheme; a bare value has none', async () => {
    const { host, secrets, sent } = await world();
    await secrets.send('JEV_KEY', POST, { header: 'x-api-key' });
    await secrets.send('JEV_KEY', POST, { header: 'x-token', scheme: 'Token' });
    expect(headersOf(sent[0] as Sent)['x-api-key']).toBe(VALUE);
    expect(headersOf(sent[1] as Sent)['x-token']).toBe(`Token ${VALUE}`);
    expect(headersOf(sent[0] as Sent).authorization).toBeUndefined();
    await host.stop();
  });

  test('rule 1: an undeclared name (or one that is not a whole name) is not_declared and nothing is asked or sent', async () => {
    const { host, secrets, sent, asked } = await world();
    expect(await secrets.send('UNDECLARED', POST)).toEqual({ kind: 'refused', refused: 'not_declared' });
    expect(await secrets.send('jev_key', POST)).toEqual({ kind: 'refused', refused: 'not_declared' });
    expect(sent).toEqual([]);
    expect(asked).toEqual([]);
    await host.stop();
  });

  test('rule 2: a declared name its own config in effect does not name is not_configured, before the Vault', async () => {
    const { host, secrets, sent, asked } = await world();
    expect(await secrets.send('NOT_IN_CONFIG', POST)).toEqual({ kind: 'refused', refused: 'not_configured' });
    expect(sent).toEqual([]);
    expect(asked).toEqual([]);
    await host.stop();
  });

  test('rule 3: a name the Vault does not know, or holds only as whitespace, is unknown and nothing is sent', async () => {
    const { host, secrets, sent } = await world();
    expect(await secrets.send('MISSING_KEY', POST)).toEqual({ kind: 'refused', refused: 'unknown' });
    expect(await secrets.send('BLANK_KEY', POST)).toEqual({ kind: 'refused', refused: 'unknown' });
    expect(sent).toEqual([]);
    await host.stop();
  });

  test('destination: only https (or http to this machine) to a host the manifest names EXACTLY, never userinfo', async () => {
    const { host, secrets, sent, asked } = await world();
    const to = (url: string) => secrets.send('JEV_KEY', { ...POST, url });
    const destination = { kind: 'refused', refused: 'destination' } as const;
    expect(await to('http://api.jev.test/v1/check')).toEqual(destination);
    expect(await to('https://elsewhere.test/v1/check')).toEqual(destination);
    // a wildcard entry, and a non-core '*', reach hosts for kernel.fetch but let no key out
    expect(await to('https://a.wild.test/v1/check')).toEqual(destination);
    expect(await to('https://api.jev.test:8443/v1/check')).toEqual(destination);
    expect(await to('https://user:pw@api.jev.test/v1/check')).toEqual(destination);
    expect(await to('not a url')).toEqual(destination);
    expect(sent).toEqual([]);
    expect(asked).toEqual([]);
    // plain http to this machine, exactly declared, is today's one exception
    expect((await to('http://localhost/v1/check')).kind).toBe('completion');
    expect(sent.map(s => s.url)).toEqual(['http://localhost/v1/check']);
    await host.stop();
  });

  test('placement: a request that carries the placement header itself, in any case, is refused', async () => {
    const { host, secrets, sent, asked } = await world();
    const placement = { kind: 'refused', refused: 'placement' } as const;
    expect(await secrets.send('JEV_KEY', { ...POST, headers: { Authorization: 'Bearer mine' } })).toEqual(placement);
    expect(
      await secrets.send('JEV_KEY', { ...POST, headers: { 'X-Api-Key': 'mine' } }, { header: 'x-api-key' }),
    ).toEqual(placement);
    expect(await secrets.send('JEV_KEY', POST, { header: '' })).toEqual(placement);
    expect(sent).toEqual([]);
    expect(asked).toEqual([]);
    await host.stop();
  });

  test('a caller Host header, in any case, is refused: nothing re-aims the connection', async () => {
    const { host, secrets, sent, asked } = await world();
    for (const name of ['Host', 'host', 'HOST'])
      expect(await secrets.send('JEV_KEY', { ...POST, headers: { [name]: 'evil.test' } })).toEqual({
        kind: 'refused',
        refused: 'destination',
      });
    expect(sent).toEqual([]);
    expect(asked).toEqual([]);
    await host.stop();
  });

  test('a redirect is answered, never followed: one request, sent with redirect manual', async () => {
    const { host, secrets, sent } = await world(
      () => new Response(null, { status: 307, headers: { location: 'https://evil.test/steal' } }),
    );
    expect(await secrets.send('JEV_KEY', POST)).toEqual({ kind: 'status', status: 307 });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.init?.redirect).toBe('manual');
    await host.stop();
  });

  test('a reply that echoes the value is unreadable', async () => {
    const { host, secrets } = await world(() => json({ debug: { headers: { authorization: `Bearer ${VALUE}` } } }));
    expect(await secrets.send('JEV_KEY', POST)).toEqual({ kind: 'unreadable' });
    await host.stop();
  });

  test('facts only: a status with retry-after, a reply that is not JSON, one too large, and no reply at all', async () => {
    const replies: (() => Response)[] = [
      () => new Response('slow down', { status: 429, headers: { 'retry-after': '12' } }),
      () => new Response('<html>', { status: 200 }),
      () => new Response('x'.repeat(4_096), { status: 200, headers: { 'content-length': '4096' } }),
      () => new Response(new Blob(['y'.repeat(4_096)]).stream(), { status: 200 }),
      () => {
        throw new TypeError(`connect failed for ${VALUE}`);
      },
    ];
    let index = 0;
    const { host, secrets } = await world(() => (replies[index++] as () => Response)());
    expect(await secrets.send('JEV_KEY', POST)).toEqual({ kind: 'status', status: 429, retryAfterSeconds: 12 });
    expect(await secrets.send('JEV_KEY', POST)).toEqual({ kind: 'unreadable' });
    expect(await secrets.send('JEV_KEY', POST)).toEqual({ kind: 'too_large' });
    expect(await secrets.send('JEV_KEY', POST)).toEqual({ kind: 'too_large' });
    expect(await secrets.send('JEV_KEY', POST)).toEqual({ kind: 'network' });
    await host.stop();
  });

  test('S162: the request is read ONCE, so a getter cannot show the check one host and the send another', async () => {
    const { host, secrets, sent } = await world();
    let reads = 0;
    const shifty = {
      ...POST,
      get url() {
        reads += 1;
        return reads === 1 ? 'https://api.jev.test/v1/check' : 'https://evil.test/steal';
      },
    };
    await secrets.send('JEV_KEY', shifty);
    expect(reads).toBe(1);
    expect(sent.map(s => new URL(s.url).host)).toEqual(['api.jev.test']);
    // a malformed request is refused, never half-sent
    expect(await secrets.send('JEV_KEY', { ...POST, timeoutMs: -1 })).toEqual({
      kind: 'refused',
      refused: 'destination',
    });
    expect(await secrets.send('JEV_KEY', { ...POST, extra: 1 } as OutboundSecretRequest)).toEqual({
      kind: 'refused',
      refused: 'destination',
    });
    await host.stop();
  });

  test('the log says the secret name and the host, never the value', async () => {
    const { host, secrets } = await world();
    await secrets.send('JEV_KEY', POST);
    const line = host.logs.find(entry => entry.message === 'a secret was placed on a request');
    expect(line?.fields).toEqual({ secret: 'JEV_KEY', host: 'api.jev.test', outcome: 'completion' });
    await host.stop();
  });
});

describe('the rule under both hosts (ownSecretsPort over outboundSecretTransport)', () => {
  const capture = (): Log & { readonly lines: { message: string; fields?: LogFields }[] } => {
    const lines: { message: string; fields?: LogFields }[] = [];
    const log = {
      lines,
      debug: (message: string, fields?: LogFields) => void lines.push({ message, ...(fields ? { fields } : {}) }),
      info: (message: string, fields?: LogFields) => void lines.push({ message, ...(fields ? { fields } : {}) }),
      warn: (message: string, fields?: LogFields) => void lines.push({ message, ...(fields ? { fields } : {}) }),
      error: (message: string, fields?: LogFields) => void lines.push({ message, ...(fields ? { fields } : {}) }),
      child: () => log,
    };
    return log;
  };

  test('a damaged Vault is vault_damaged for send (never unknown), and stays unknown for resolve', async () => {
    const port = ownSecretsPort(
      ['A_KEY'],
      () => new Set(['A_KEY']),
      () => ({
        resolve: async () => {
          throw new Error(`sealed ${VALUE}`);
        },
      }),
      {
        hosts: ['api.jev.test'],
        mayReach: () => true,
        transport: { send: async () => ({ kind: 'network' }) },
        log: capture(),
      },
    );
    expect(await port.send('A_KEY', POST)).toEqual({ kind: 'vault_damaged' });
    expect(await port.resolve('A_KEY')).toEqual({ refused: 'unknown' });
  });

  test('a host the fetch guard would refuse is a destination refusal, asked before the Vault', async () => {
    const asked: string[] = [];
    const port = ownSecretsPort(
      ['A_KEY'],
      () => new Set(['A_KEY']),
      () => ({
        resolve: async name => {
          asked.push(name);
          return VALUE;
        },
      }),
      {
        hosts: ['api.jev.test'],
        mayReach: () => false,
        transport: { send: async () => ({ kind: 'network' }) },
        log: capture(),
      },
    );
    expect(await port.send('A_KEY', POST)).toEqual({ kind: 'refused', refused: 'destination' });
    expect(asked).toEqual([]);
  });

  test('without sending wiring a send is refused, and exact hosts drop every pattern, item and resolver entry', async () => {
    const port = ownSecretsPort(
      ['A_KEY'],
      () => new Set(['A_KEY']),
      () => ({ resolve: async () => VALUE }),
    );
    expect(await port.send('A_KEY', POST)).toEqual({ kind: 'refused', refused: 'destination' });
    expect(
      exactNetworkHosts(['API.Jev.test', '*', '*.wild.test', { items: 'mcp' }, { resolver: 'relay' }, 'localhost']),
    ).toEqual(['api.jev.test', 'localhost']);
  });

  test('a transport that throws is network, and its message never leaves', async () => {
    const log = capture();
    const port = ownSecretsPort(
      ['A_KEY'],
      () => new Set(['A_KEY']),
      () => ({ resolve: async () => VALUE }),
      {
        hosts: ['api.jev.test'],
        mayReach: () => true,
        transport: {
          send: async () => {
            throw new Error(`boom ${VALUE}`);
          },
        },
        log,
      },
    );
    expect(await port.send('A_KEY', POST)).toEqual({ kind: 'network' });
    expect(JSON.stringify(log.lines)).not.toContain(VALUE);
  });

  test('the timeout aborts the request on the kernel clock and answers timeout', async () => {
    const clock = fixedClock();
    let signal: AbortSignal | undefined;
    const transport = outboundSecretTransport(
      {
        request: async (_url, init) =>
          await new Promise<Response>((_resolve, reject) => {
            signal = init?.signal ?? undefined;
            signal?.addEventListener('abort', () => reject(new Error(`aborted ${VALUE}`)));
          }),
      },
      clock,
    );
    const pending = transport.send({ ...POST, timeoutMs: 250 });
    await Bun.sleep(0);
    await clock.advance(milliseconds(250));
    expect(await pending).toEqual({ kind: 'timeout' });
    expect(signal?.aborted).toBe(true);
  });

  test('planted-value scan: no outcome, log line or thrown message of any case carries the value', async () => {
    const replies: (() => Response)[] = [
      () => json({ ok: true }),
      () => json({ echo: VALUE }),
      () => new Response(`denied ${VALUE}`, { status: 401 }),
      () => new Response(`not json ${VALUE}`, { status: 200 }),
      () => {
        throw new Error(`refused ${VALUE}`);
      },
    ];
    let index = 0;
    const { host, secrets } = await world(() => (replies[index++ % replies.length] as () => Response)());
    const outcomes: unknown[] = [];
    const thrown: string[] = [];
    const calls: (() => Promise<unknown>)[] = [
      ...replies.map(() => () => secrets.send('JEV_KEY', POST)),
      () => secrets.send('JEV_KEY', { ...POST, url: 'http://api.jev.test/' }),
      () => secrets.send('JEV_KEY', { ...POST, headers: { authorization: VALUE } }),
      () => secrets.send(VALUE, POST),
      () => secrets.send('NOT_IN_CONFIG', POST),
      () => secrets.send('MISSING_KEY', POST),
    ];
    for (const call of calls)
      try {
        outcomes.push(await call());
      } catch (error) {
        thrown.push(String(error instanceof Error ? error.message : error));
      }
    expect(thrown).toEqual([]);
    expect(JSON.stringify(outcomes)).not.toContain(VALUE);
    expect(JSON.stringify(host.logs)).not.toContain(VALUE);
    await host.stop();
  });
});
