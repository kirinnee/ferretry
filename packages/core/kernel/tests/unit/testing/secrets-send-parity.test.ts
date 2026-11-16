/**
 * NN2 D2 #19: the testing host's `kernel.secrets.send` stays in step with the real host's. The same rule
 * (`host/secrets.ts` over `host/adapters/outbound-secret.ts`) decides both; the real host is booted for real (its own
 * config service reading a confirmed `${secret:NAME}` reference from disk, a core Vault stand-in bound as the kernel's
 * `secretResolver`, the plugin's own `restrictFetch`), and only the network is the test's on both sides.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { SecretResolverPort } from '../../../contract/bound.ts';
import { defineConfig } from '../../../contract/define.ts';
import type { KernelPorts } from '../../../contract/ports.ts';
import type { OutboundSecretRequest } from '../../../contract/secrets.ts';
import { createConfigFiles } from '../../../host/config/service.ts';
import { bootHost } from '../../../host/host.ts';
import type { LogRecord } from '../../../host/log.ts';
import { createNodeHostFs } from '../../../host/state/index.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { fixedClock } from '../../../testing/clock.ts';
import { testHost } from '../../../testing/index.ts';
import { silentLog } from '../host/fixtures.ts';

const parents: string[] = [];
afterEach(async () => {
  for (const parent of parents.splice(0)) await rm(parent, { recursive: true, force: true });
});

const VALUE = 'sk-parity-planted-value-91aa';
const VAULT: Readonly<Record<string, string>> = { JEV_KEY: VALUE, NOT_IN_CONFIG: 'v' };
const KeyFile = defineConfig({
  file: 'jevish/keys.yaml',
  schema: z.strictObject({ key: z.string().optional() }),
  axis: 'configure',
  loosens: () => [],
});
const KEY_TEXT = 'key: ${secret:JEV_KEY}\n';

interface Seen {
  jevish?: KernelPorts;
  stranger?: KernelPorts;
}

const halves = (seen: Seen) => [
  implementDaemon(
    definePlugin({
      id: 'jevish',
      title: 'Jevish',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      permissions: { network: ['api.jev.test', '*.wild.test', '*'], secrets: ['JEV_KEY', 'NOT_IN_CONFIG'] },
      data: { config: [KeyFile] },
    }),
    {
      build: ({ kernel }) => {
        seen.jevish = kernel;
        return {};
      },
    },
  ),
  implementDaemon(
    definePlugin({
      id: 'stranger',
      title: 'Stranger',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      permissions: { network: ['api.jev.test'] },
    }),
    {
      build: ({ kernel }) => {
        seen.stranger = kernel;
        return {};
      },
    },
  ),
];

/** A core Vault stand-in for the real boot: it provides the kernel-only resolver and nothing else. */
const vaultStandIn = implementDaemon(
  definePlugin({
    id: 'vault',
    title: 'Vault',
    version: '5.0.0',
    api: 5,
    core: true,
    kinds: [],
    provides: { secretResolver: SecretResolverPort },
  }),
  { build: () => ({ provides: { secretResolver: { resolve: async (name: string) => VAULT[name] } } }) },
);

/** What the network fake saw and answered, the same on both hosts. */
function network() {
  const sent: { url: string; method?: string; headers: Record<string, string>; redirect?: string }[] = [];
  const fetch = async (url: URL | string, init?: RequestInit): Promise<Response> => {
    const href = String(url);
    sent.push({
      url: href,
      ...(init?.method === undefined ? {} : { method: init.method }),
      headers: { ...(init?.headers as Record<string, string>) },
      ...(init?.redirect === undefined ? {} : { redirect: init.redirect }),
    });
    if (href.endsWith('/echo')) return Response.json({ seen: VALUE });
    if (href.endsWith('/moved'))
      return new Response(null, { status: 302, headers: { location: 'https://evil.test/' } });
    if (href.endsWith('/busy')) return new Response('busy', { status: 503, headers: { 'retry-after': '3' } });
    return Response.json({ answers: { triage: 'ok' } });
  };
  return { sent, fetch };
}

const POST: OutboundSecretRequest = {
  method: 'POST',
  url: 'https://api.jev.test/v1/check',
  headers: { accept: 'application/json' },
  body: '{}',
  timeoutMs: 5_000,
  maxResponseBytes: 4_096,
};

async function cases(seen: Seen) {
  const own = (seen.jevish as KernelPorts).secrets;
  const stranger = (seen.stranger as KernelPorts).secrets;
  return [
    ['sent', await own.send('JEV_KEY', POST)],
    ['sent with a bare x-api-key', await own.send('JEV_KEY', POST, { header: 'x-api-key' })],
    ['undeclared', await own.send('OTHER', POST)],
    ['not configured', await own.send('NOT_IN_CONFIG', POST)],
    ['another plugin names the same secret', await stranger.send('JEV_KEY', POST)],
    ['http off this machine', await own.send('JEV_KEY', { ...POST, url: 'http://api.jev.test/v1/check' })],
    ['a wildcard host', await own.send('JEV_KEY', { ...POST, url: 'https://a.wild.test/v1/check' })],
    ['an undeclared host', await own.send('JEV_KEY', { ...POST, url: 'https://elsewhere.test/' })],
    ['its own authorization', await own.send('JEV_KEY', { ...POST, headers: { authorization: 'mine' } })],
    ['a redirect', await own.send('JEV_KEY', { ...POST, url: 'https://api.jev.test/moved' })],
    ['an echo', await own.send('JEV_KEY', { ...POST, url: 'https://api.jev.test/echo' })],
    ['a busy provider', await own.send('JEV_KEY', { ...POST, url: 'https://api.jev.test/busy' })],
  ] as const;
}

const placedLines = (records: readonly { readonly message: string; readonly fields?: unknown }[]) =>
  records.filter(record => record.message === 'a secret was placed on a request').map(record => record.fields);

async function onTestingHost() {
  const seen: Seen = {};
  const net = network();
  const host = await testHost({
    plugins: halves(seen),
    config: { 'jevish/keys.yaml': { key: '${secret:JEV_KEY}' } },
    vault: VAULT,
    fetch: net.fetch,
  });
  try {
    return { outcomes: await cases(seen), sent: net.sent, logged: placedLines(host.logs) };
  } finally {
    await host.stop();
  }
}

async function onRealHost() {
  const parent = await realpath(await mkdtemp(`${tmpdir()}/fy-secrets-send-parity-`));
  parents.push(parent);
  const home = `${parent}/home`;
  await mkdir(`${home}/config/jevish`, { recursive: true });
  await writeFile(
    `${home}/home.json`,
    JSON.stringify({ format: 1, createdBy: 'fyd 5.0.0', createdAt: '2026-11-08T09:00:00Z' }),
  );
  await writeFile(`${home}/config/jevish/keys.yaml`, KEY_TEXT);
  // The owner confirms the reference they wrote (an unaccepted file naming a secret is held), as a real home would.
  const seed = createConfigFiles({
    home,
    defs: [{ plugin: 'jevish', def: KeyFile }],
    fs: createNodeHostFs(),
    clock: fixedClock(),
    log: silentLog,
    binary: 'fy',
  });
  await seed.reload();
  for (const edit of seed.held()) expect(await seed.confirm(edit.id)).toBe(true);
  const records: LogRecord[] = [];
  const net = network();
  const seen: Seen = {};
  const outcome = await bootHost({
    home,
    version: '5.0.0',
    adapters: {
      ...realAdapters(home, record => void records.push(record), { binary: 'fy' }),
      fetch: { request: async (url, init) => await net.fetch(url, init) },
      clock: fixedClock(),
      homeLock: async () => ({ release: async () => {} }),
    },
    implementations: [vaultStandIn, ...halves(seen)],
  });
  if (outcome.kind !== 'running') throw new Error(outcome.sentence);
  try {
    return { outcomes: await cases(seen), sent: net.sent, logged: placedLines(records) };
  } finally {
    await outcome.host.stop();
  }
}

test('NN2 D2 #19 secrets.send parity: the real host and the testing host answer, send and log every case alike', async () => {
  const testing = await onTestingHost();
  const real = await onRealHost();
  expect(testing).toEqual(real);
  // and what both answer is the rule, so parity is not two hosts agreeing on a wrong answer
  const byCase = Object.fromEntries(real.outcomes);
  expect(byCase.sent).toEqual({ kind: 'completion', status: 200, payload: { answers: { triage: 'ok' } } });
  expect(byCase.undeclared).toEqual({ kind: 'refused', refused: 'not_declared' });
  expect(byCase['not configured']).toEqual({ kind: 'refused', refused: 'not_configured' });
  expect(byCase['another plugin names the same secret']).toEqual({ kind: 'refused', refused: 'not_declared' });
  for (const name of ['http off this machine', 'a wildcard host', 'an undeclared host'] as const)
    expect(byCase[name]).toEqual({ kind: 'refused', refused: 'destination' });
  expect(byCase['its own authorization']).toEqual({ kind: 'refused', refused: 'placement' });
  expect(byCase['a redirect']).toEqual({ kind: 'status', status: 302 });
  expect(byCase['an echo']).toEqual({ kind: 'unreadable' });
  expect(byCase['a busy provider']).toEqual({ kind: 'status', status: 503, retryAfterSeconds: 3 });
  expect(real.sent.map(sent => [new URL(sent.url).pathname, sent.redirect, Object.keys(sent.headers).sort()])).toEqual([
    ['/v1/check', 'manual', ['accept', 'authorization']],
    ['/v1/check', 'manual', ['accept', 'x-api-key']],
    ['/moved', 'manual', ['accept', 'authorization']],
    ['/echo', 'manual', ['accept', 'authorization']],
    ['/busy', 'manual', ['accept', 'authorization']],
  ]);
  expect(real.sent[0]?.headers.authorization).toBe(`Bearer ${VALUE}`);
  expect(real.logged).toHaveLength(5);
  expect(JSON.stringify([real.outcomes, real.logged])).not.toContain(VALUE);
});
