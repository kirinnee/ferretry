import { afterEach, describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { cap, DEFAULT_GATE_CONFIG, DEFAULT_GATE_SECURITY, FULL_DEVICE_GRANTS } from '@ferretry/core-gate/contract';
import { ApiError } from '@ferretry/kernel/contract';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { device, fixedClock, owner, type TestHost, testHost } from '@ferretry/kernel/testing';
import {
  CONVERSATION_STATE,
  type ReferenceCatalogEntry,
  ReferenceCatalog,
  type ReferenceCatalogInput,
  type ReferenceCatalogProvider,
} from '../../../contract/index.ts';
import daemon from '../../../daemon/index.ts';
import { GovernedAdmission } from '../../support/governed-admission.ts';
import { memoryStatePort } from '../../support/state.ts';

/**
 * The reference menus through Gate's admission and its governance (the stand-in, given the governance a
 * `consultsGrants` route is handed; the real `GateAdmission` is asked about this route in Gate's own suite): a device the operator
 * has not granted filesystem, terminal or browser use is refused the lists those facts' own routes refuse it.
 * The providers are fakes that declare the demands the real ones will.
 */
const SECRET = 'sk-live-77aa';
const F1 = ferretId('f1');
const OWNER = { as: owner() } as const;
const PATH = '/v1/ferrets/f1/references';

const withGrants = (name: 'filesystem' | 'terminal' | 'browser') => ({
  ...FULL_DEVICE_GRANTS,
  [name]: { use: false, configure: false },
});

interface Setup {
  readonly host: TestHost;
  readonly gate: GovernedAdmission;
  readonly seen: ReferenceCatalogInput[];
  readonly started: string[];
}

const hosts: TestHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
});

async function setup(
  options: { policy?: typeof DEFAULT_GATE_CONFIG; provide?: Record<string, ReferenceCatalogProvider> } = {},
): Promise<Setup> {
  const gate = new GovernedAdmission();
  if (options.policy !== undefined) gate.policy = options.policy;
  const seen: ReferenceCatalogInput[] = [];
  const started: string[] = [];
  const entry = (token: string, label = token): ReferenceCatalogEntry => ({ token, label });
  const provider = (demand: ReferenceCatalogProvider['demand'], token: string): ReferenceCatalogProvider => ({
    ...(demand === undefined ? {} : { demand }),
    entries: async input => {
      seen.push(input);
      started.push(token);
      return [entry(token, `${token} ${SECRET}`)];
    },
  });
  const providers: Record<string, ReferenceCatalogProvider> = options.provide ?? {
    '@': provider(cap('filesystem', 'use'), 'src/'),
    '%terminal': provider(cap('terminal', 'use'), 'dev'),
    '%browser': provider(cap('browser', 'use'), 'docs'),
    '&': provider(undefined, 'F12'),
  };
  const fixture = definePlugin({
    id: 'reference-fixture',
    title: 'Reference fixture',
    version: '1.0.0',
    api: 5,
    core: false,
    kinds: [],
    hooks: {
      takes: Object.keys(providers).map(key => ({ hook: ReferenceCatalog, key: key as never })),
    },
  });
  const fixtureHalf = implementDaemon(fixture, {
    build: () => ({
      hooks: Object.fromEntries(Object.entries(providers).map(([key, value]) => [`reference.catalog:${key}`, value])),
    }),
  });
  const ferrets = new FakeFerrets();
  ferrets.add({ id: F1 });
  const conversation = {
    ...daemon,
    build: (ctx: Parameters<NonNullable<typeof daemon.build>>[0]) => {
      const build = daemon.build;
      if (build === undefined) throw new Error('the conversation daemon half has no build');
      return build({ ...ctx, kernel: { ...ctx.kernel, state: memoryStatePort(CONVERSATION_STATE) } });
    },
  } as typeof daemon;
  const host = await testHost({
    plugins: [conversation, fixtureHalf],
    fakes: { ferrets, asks: new FakeAsks() },
    clock: fixedClock('2026-11-07T09:00:00Z'),
    secrets: [SECRET],
    gate,
  });
  hosts.push(host);
  return { host, gate, seen, started };
}

const ask = (s: Setup, prefix: string, as: 'owner' | 'phone', query: Record<string, string> = {}) =>
  s.host.request('GET', PATH, {
    query: { prefix, ...query },
    ...(as === 'owner' ? OWNER : { as: device('phone') }),
  });

describe('GET /v1/ferrets/:ferretId/references keeps the grants of the facts it lists', () => {
  test('a governed device WITHOUT filesystem use is refused 403 on @, and the provider never ran', async () => {
    const s = await setup();
    s.gate.enrol('phone', withGrants('filesystem'));
    const response = await ask(s, '@', 'phone');
    expect(response.status).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('grant_device_not_granted');
    expect(response.body).not.toContain('src/');
    expect(s.started).toEqual([]);
  });

  test('a governed device WITHOUT terminal use is refused 403 on %terminal', async () => {
    const s = await setup();
    s.gate.enrol('phone', withGrants('terminal'));
    const response = await ask(s, '%terminal', 'phone');
    expect(response.status).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('grant_device_not_granted');
    expect(s.started).toEqual([]);
  });

  test('a governed device WITHOUT browser use is refused 403 on %browser', async () => {
    const s = await setup();
    s.gate.enrol('phone', withGrants('browser'));
    const response = await ask(s, '%browser', 'phone');
    expect(response.status).toBe(403);
    expect(response.json<{ code: string }>().code).toBe('grant_device_not_granted');
    expect(s.started).toEqual([]);
  });

  test('the daemon-wide operator document refuses too (not-granted), the same sentence the direct route gives', async () => {
    const off = { ...FULL_DEVICE_GRANTS, filesystem: { use: false, configure: false } };
    const s = await setup({ policy: { ...DEFAULT_GATE_CONFIG, grants: off } });
    s.gate.enrol('phone', FULL_DEVICE_GRANTS);
    const response = await ask(s, '@', 'phone');
    expect(response.status).toBe(403);
    const body = response.json<{ code: string; error: string }>();
    expect(body.code).toBe('grant_not_granted');
    expect(body.error).toContain('project filesystem');
  });

  test('the owner at the machine (ungoverned) and a granted device are served the entries', async () => {
    const s = await setup();
    s.gate.enrol('phone', FULL_DEVICE_GRANTS);
    for (const [prefix, token] of [
      ['@', 'src/'],
      ['%terminal', 'dev'],
      ['%browser', 'docs'],
    ] as const) {
      const byOwner = await ask(s, prefix, 'owner');
      expect(byOwner.status).toBe(200);
      expect(byOwner.json<{ entries: { token: string }[] }>().entries[0]?.token).toBe(token);
    }
    const granted = await ask(s, '@', 'phone');
    expect(granted.status).toBe(200);
  });

  test('a step-up the machine asks for is answered with the step-up body, not entries', async () => {
    const s = await setup({
      policy: { ...DEFAULT_GATE_CONFIG, security: { ...DEFAULT_GATE_SECURITY, stepUpOnActions: true } },
    });
    s.gate.enrol('phone', FULL_DEVICE_GRANTS);
    const response = await ask(s, '%terminal', 'phone');
    expect(response.status).toBe(403);
    expect(response.json()).toMatchObject({
      code: 'grant_step_up_required',
      demand: { capability: 'terminal', axis: 'use' },
    });
    expect(s.started).toEqual([]);
  });

  test('a provider with no demand (cards) is served to a governed device, and is passed the caller standing', async () => {
    const s = await setup();
    s.gate.enrol('phone', withGrants('filesystem'));
    const response = await ask(s, '&', 'phone');
    expect(response.status).toBe(200);
    expect(s.seen[0]?.caller.governance?.governed).toBe(true);
    expect(s.seen[0]?.caller.actor).toBe('device:phone');
  });

  test('an absent provider is an empty list, not an error; a ferret not on this daemon is 404', async () => {
    const s = await setup();
    const none = await ask(s, '!', 'owner');
    expect(none.status).toBe(200);
    expect(none.json()).toMatchObject({ provided: false, entries: [] });
    const missing = await s.host.request('GET', '/v1/ferrets/f9/references', { query: { prefix: '&' }, ...OWNER });
    expect(missing.status).toBe(404);
    // A governed device without the grant learns nothing about which ferrets exist: the refusal comes first.
    s.gate.enrol('phone', withGrants('filesystem'));
    const hidden = await s.host.request('GET', '/v1/ferrets/f9/references', {
      query: { prefix: '@' },
      as: device('phone'),
    });
    expect(hidden.status).toBe(403);
  });

  test('@ refuses .., an absolute path and NUL; every prefix refuses a q past 4,096', async () => {
    const s = await setup();
    for (const q of ['../etc', 'a/../../b', '/etc', '\\windows', 'C:/x', 'a\0b']) {
      const response = await ask(s, '@', 'owner', { q });
      expect(response.status).toBe(400);
    }
    expect((await ask(s, '@', 'owner', { q: 'src/deep' })).status).toBe(200);
    expect((await ask(s, '&', 'owner', { q: 'x'.repeat(4_097) })).status).toBe(400);
    expect((await ask(s, '&', 'owner', { q: 'x'.repeat(4_096) })).status).toBe(200);
    expect(s.seen.every(input => input.query === undefined || !input.query.includes('..'))).toBe(true);
  });

  test('a failing or non-array provider is a shaped 502 naming only its prefix; a 403 it raises passes through', async () => {
    const s = await setup({
      provide: {
        '&': {
          entries: async () => {
            throw new Error(`board offline at /home/x with ${SECRET}`);
          },
        },
        '!': { entries: async () => ({ not: 'an array' }) as never },
        '/': {
          entries: async () => {
            throw new ApiError(403, 'not yours', 'forbidden');
          },
        },
      },
    });
    for (const prefix of ['&', '!']) {
      const response = await ask(s, prefix, 'owner');
      expect(response.status).toBe(502);
      const body = response.json<{ code: string; error: string }>();
      expect(body.code).toBe('reference_catalog_failed');
      expect(body.error).toBe(`the ${prefix} catalog could not be read`);
      expect(response.body).not.toContain(SECRET);
    }
    expect((await ask(s, '/', 'owner')).status).toBe(403);
  });

  test('a provider label holding a known secret is masked in the served body', async () => {
    const s = await setup();
    const response = await ask(s, '&', 'owner');
    expect(response.status).toBe(200);
    expect(response.body).not.toContain(SECRET);
    expect(response.json<{ entries: { label: string }[] }>().entries[0]?.label).toBe(
      `F12 ${'*'.repeat(SECRET.length)}`,
    );
  });

  test('a file list is bounded at 2,000 and the other menus at 200', async () => {
    const many = (count: number): ReferenceCatalogProvider => ({
      entries: async () => Array.from({ length: count }, (_, i) => ({ token: `t${i}`, label: `t${i}` })),
    });
    const s = await setup({ provide: { '@': many(2_500), '&': many(500) } });
    const files = await ask(s, '@', 'owner');
    expect(files.json<{ entries: unknown[] }>().entries).toHaveLength(2_000);
    const cards = await ask(s, '&', 'owner');
    expect(cards.json<{ entries: unknown[] }>().entries).toHaveLength(200);
  });
});
