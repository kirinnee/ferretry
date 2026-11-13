import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import type { Admission, ChildEnvironment, ChildEnvironmentOpener } from '../../../contract/bound.ts';
import { AdmissionPort, ChildEnvironmentPort } from '../../../contract/bound.ts';
import { defineHook } from '../../../contract/define.ts';
import { headerValue, jsonResponse } from '../../../contract/http.ts';
import type { SpawnPort } from '../../../contract/ports.ts';
import { bunSpawn, resolveEnv } from '../../../host/adapters/process.ts';
import { bootHost, type RunningHost } from '../../../host/host.ts';
import { realAdapters } from '../../../host/wiring.ts';
import { definePlugin, implementDaemon, route } from '../../../manifest/index.ts';
import { request } from '../../unit/host/fixtures.ts';

const homes: string[] = [];
const hosts: RunningHost[] = [];
afterEach(async () => {
  for (const host of hosts.splice(0)) await host.stop();
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});
async function freshHome(): Promise<string> {
  const parent = await mkdtemp(`${tmpdir()}/fy-bound-`);
  homes.push(parent);
  return `${parent}/home`;
}

/** The shape of Gate's `bearers` hook (packages/core/gate/contract): a security-path provide, taken only by Ferrets. */
interface BearerDirectory {
  ferretFor(digest: string): string | undefined;
}
const Bearers = defineHook('bearers', {
  mode: 'provide',
  key: z.enum(['ferret']),
  value: z.custom<BearerDirectory>(),
  takers: ['ferrets'],
});

const open = { minimum: 'authenticated', caller: 'any', audit: { skip: 'test' }, guard: { none: 'test' } } as const;

function gate() {
  const manifest = definePlugin({
    id: 'gate',
    title: 'Gate',
    version: '5.0.0',
    api: 5,
    core: true,
    kinds: [],
    provides: { admission: AdmissionPort },
    hooks: { offers: [{ hook: Bearers }] },
  });
  return implementDaemon(manifest, {
    build: ctx => {
      // Looked up per call, never during build: Ferrets is built after Gate (taking a hook is a start-order edge).
      const admission: Admission = {
        admit: input => {
          const directory = ctx.hooks.provider(Bearers, 'ferret');
          const bearer = headerValue(input.request, 'authorization')?.replace(/^Bearer /, '') ?? '';
          const ferret = directory === 'unavailable' ? undefined : directory.ferretFor(`digest:${bearer}`);
          return ferret === undefined
            ? {
                outcome: 'refused',
                response: { status: 401, headers: new Map(), body: '{"error":"no","code":"unauthorized"}' },
              }
            : { outcome: 'admitted', standing: { ferret } as never, actor: 'ferret' };
        },
        admitMember: () => ({ outcome: 'refused', response: { status: 403, headers: new Map(), body: '{}' } }),
        readmit: () => true,
        inventory: (_request, entries) => entries,
      };
      return { provides: { admission } };
    },
  });
}

function ferrets(tokens: Readonly<Record<string, string>>) {
  const manifest = definePlugin({
    id: 'ferrets',
    title: 'Ferrets',
    version: '5.0.0',
    api: 5,
    core: true,
    kinds: [],
    hooks: { takes: [{ hook: Bearers, key: 'ferret' }] },
    actions: { routes: [route('GET /v1/me', open)] },
  });
  return implementDaemon(manifest, {
    build: () => ({
      hooks: { 'bearers:ferret': { ferretFor: (digest: string) => tokens[digest] } },
      routes: { 'GET /v1/me': async call => jsonResponse({ ferret: (call as unknown as { ferret: string }).ferret }) },
    }),
  });
}

describe('decision 8: Gate checks ferret bearers through Ferrets (bearers:ferret)', () => {
  test('admission resolves the ferret through the provider at call time; an unknown bearer is refused', async () => {
    const home = await freshHome();
    const outcome = await bootHost({
      home,
      version: '5.0.0',
      implementations: [gate(), ferrets({ 'digest:fys_one': 'F1' })],
      adapters: realAdapters(home, () => {}, { binary: 'fy' }),
    });
    if (outcome.kind !== 'running') throw new Error(outcome.sentence);
    hosts.push(outcome.host);
    expect(outcome.host.trace.indexOf('build:gate')).toBeLessThan(outcome.host.trace.indexOf('build:ferrets'));
    const known = { ...request('GET', '/v1/me'), headers: new Map([['authorization', 'Bearer fys_one']]) };
    expect(JSON.parse((await outcome.host.dispatch(known)).body)).toEqual({ ferret: 'F1' });
    const stranger = { ...request('GET', '/v1/me'), headers: new Map([['authorization', 'Bearer fys_two']]) };
    expect((await outcome.host.dispatch(stranger)).status).toBe(401);
  });

  test('a plugin other than Ferrets taking bearers is refused at boot; the rest boots', async () => {
    const home = await freshHome();
    const rogue = implementDaemon(
      definePlugin({
        id: 'board',
        title: 'Board',
        version: '5.0.0',
        api: 5,
        core: false,
        kinds: [],
        hooks: { takes: [{ hook: Bearers, key: 'ferret' }] },
      }),
      { build: () => ({ hooks: { 'bearers:ferret': { ferretFor: () => 'F-anything' } } }) },
    );
    const outcome = await bootHost({
      home,
      version: '5.0.0',
      implementations: [gate(), ferrets({}), rogue],
      adapters: realAdapters(home, () => {}, { binary: 'fy' }),
    });
    if (outcome.kind !== 'running') throw new Error(outcome.sentence);
    hosts.push(outcome.host);
    expect(outcome.host.plugins.get('board')?.status).toBe('refused');
    const anyone = { ...request('GET', '/v1/me'), headers: new Map([['authorization', 'Bearer x']]) };
    expect((await outcome.host.dispatch(anyone)).status).toBe(401);
  });
});

describe('decision 9: a ChildEnvironment is opened by the kernel at exec time', () => {
  const values = new WeakMap<object, Readonly<Record<string, string>>>();
  const handle = (env: Readonly<Record<string, string>>): ChildEnvironment => {
    const opaque = Object.freeze({ names: Object.keys(env) }) as unknown as ChildEnvironment;
    values.set(opaque, env);
    return opaque;
  };
  const opener: ChildEnvironmentOpener = { open: env => values.get(env), searchPathOf: () => undefined };

  test('the child gets the values; the caller only ever holds names', async () => {
    const env = handle({ FY_TEST_SECRET: 'opened-in-the-child' });
    expect(JSON.stringify(env)).toBe('{"names":["FY_TEST_SECRET"]}');
    const spawn: SpawnPort = bunSpawn({ PATH: process.env.PATH ?? '/usr/bin:/bin' }, () => opener);
    const result = await spawn.run('sh', ['-c', 'printf %s "$FY_TEST_SECRET"'], { env });
    expect(result.stdout).toBe('opened-in-the-child');
  });

  test('a handle with no opener bound, or one the opener does not know, refuses the start', () => {
    const env = handle({ X: 'y' });
    expect(() => resolveEnv(env, undefined)).toThrow('did not open');
    expect(() => resolveEnv({ names: ['X'] } as unknown as ChildEnvironment, opener)).toThrow('did not open');
    expect(resolveEnv({ PLAIN: 'value' }, undefined)).toEqual({ PLAIN: 'value' });
  });

  test('the host binds the opener only from Vault, and a plugin spawn uses it', async () => {
    const home = await freshHome();
    const vault = implementDaemon(
      definePlugin({
        id: 'vault',
        title: 'Vault',
        version: '5.0.0',
        api: 5,
        core: true,
        kinds: [],
        provides: { childEnvironments: ChildEnvironmentPort },
      }),
      { build: () => ({ provides: { childEnvironments: opener } }) },
    );
    let seen = '';
    const runner = implementDaemon(
      definePlugin({
        id: 'terminals',
        title: 'Terminals',
        version: '5.0.0',
        api: 5,
        core: false,
        kinds: [],
        permissions: { spawn: ['sh'] },
        actions: { routes: [route('GET /v1/run', { ...open, minimum: 'none' })] },
      }),
      {
        build: ctx => ({
          routes: {
            'GET /v1/run': async () => {
              const result = await ctx.kernel.spawn.run('sh', ['-c', 'printf %s "$FY_TEST_SECRET"'], {
                env: handle({ FY_TEST_SECRET: 'from-vault' }),
              });
              seen = result.stdout;
              return jsonResponse({ ok: true });
            },
          },
        }),
      },
    );
    const outcome = await bootHost({
      home,
      version: '5.0.0',
      implementations: [vault, runner],
      adapters: realAdapters(home, () => {}, { binary: 'fy', childEnv: { PATH: process.env.PATH ?? '' } }),
    });
    if (outcome.kind !== 'running') throw new Error(outcome.sentence);
    hosts.push(outcome.host);
    await outcome.host.dispatch(request('GET', '/v1/run'));
    expect(seen).toBe('from-vault');
  });
});
