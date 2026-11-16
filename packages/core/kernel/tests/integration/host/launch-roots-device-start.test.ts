import { expect, test } from 'bun:test';
import { FakeAsks } from '../../../../asks/contract/testing/index.ts';
import { Harnesses, Runners } from '../../../../ferrets/contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../../ferrets/contract/testing/index.ts';
import { deviceStanding, FakeGate, ownerStanding, StandInAdmission } from '../../../../gate/contract/testing/index.ts';
import { FakeVault } from '../../../../vault/contract/testing/index.ts';
import type { ApiRequest, CallStanding, CapabilityDemand } from '../../../contract/index.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { daemonImplementations } from '../../../src/generated/plugins.ts';
import { testHost } from '../../../testing/index.ts';

/**
 * R-0332 / B2 through the daemon: the REAL Ferrets and the REAL Projects halves, as the generated registry builds them.
 * A paired device holds `fleet` but NOT `terminal`: a start inside a registered project is an ordinary act (201); a start
 * outside every project is terminal access and is refused with the `terminal.use` demand. Fixture values only.
 */

const real = (id: string) => {
  const found = daemonImplementations.find(implementation => implementation.manifest.id === id);
  if (found === undefined) throw new Error(`the generated registry has no ${id} half`);
  return found;
};
const harnessPlugin = (harness: FakeHarness) =>
  implementDaemon(
    definePlugin({
      id: 'claude-code',
      title: 'Claude Code (fake)',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: Harnesses, key: 'claude-code' }] },
    }),
    { build: () => ({ hooks: { 'harnesses:claude-code': harness } }) },
  );
const runnerPlugin = (runner: FakeRunner) =>
  implementDaemon(
    definePlugin({
      id: 'terminals',
      title: 'Terminals (fake)',
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      hooks: { takes: [{ hook: Runners, key: 'tmux' }] },
    }),
    { build: () => ({ hooks: { 'runners:tmux': runner } }) },
  );
const asked = (demands: readonly CapabilityDemand[]): string[] =>
  demands.map(demand => `${demand.capability}.${demand.axis}`);

const world = async (plant = true) => {
  const demands: CapabilityDemand[] = [];
  const runner = new FakeRunner();
  const standing = (request: ApiRequest): CallStanding =>
    request.path.startsWith('/v1/ferrets')
      ? {
          ...deviceStanding('phone'),
          governance: {
            governed: true,
            decide: demand => {
              demands.push(demand);
              return String(demand.capability) === 'fleet'
                ? { allowed: true, refusal: 'granted' }
                : { allowed: false, refusal: 'not-granted' };
            },
          },
        }
      : ownerStanding();
  const host = await testHost({
    everyDirectory: true,
    plugins: [real('ferrets'), real('projects'), harnessPlugin(new FakeHarness()), runnerPlugin(runner)],
    gate: new StandInAdmission(standing),
    fakes: { gate: new FakeGate(), vault: new FakeVault(), asks: new FakeAsks() },
  });
  // The registry as a registration wrote it (the registration itself walks the machine's folders; not this test's subject).
  const id = '00000000-0000-4000-8000-000000000001';
  if (plant)
    host.state('projects').files.set(
      'projects.json',
      JSON.stringify({
        format: 1,
        projects: [
          { id, name: 'alpha', path: '/work/alpha', source: 'existing-folder', createdAt: '2026-11-11T00:00:00.000Z' },
        ],
      }),
    );
  return { host, runner, demands, id };
};

test('R-0332 a device starts a ferret inside a registered project (201) and is refused outside every project (terminal.use)', async () => {
  const { host, runner, demands } = await world();
  const inside = await host.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': 'inside' },
    body: { folder: '/work/alpha/packages/x' },
  });
  expect(inside.status).toBe(201);
  expect(runner.starts).toBe(1);
  expect(asked(demands)).not.toContain('terminal.use');

  const outside = await host.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': 'outside' },
    body: { folder: '/work/elsewhere' },
  });
  expect(outside.status).toBe(403);
  expect(asked(demands)).toContain('terminal.use');
  expect(runner.starts).toBe(1);
});

test('R-0332 a project removed after registration is no longer a known root', async () => {
  const { host, demands, id } = await world();
  expect((await host.request('DELETE', `/v1/projects/${id}`)).status).toBe(200);
  const response = await host.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': 'removed' },
    body: { folder: '/work/alpha' },
  });
  expect(response.status).toBe(403);
  expect(asked(demands)).toContain('terminal.use');
});

/**
 * Audit A fix 1 (B2 proof): the registry is filled THROUGH `POST /v1/projects` (the owner registers a folder), not by planting
 * `projects.json`; the device's classification then follows. The request id and the standing differ per route: the
 * registration is the owner's act (Gate's `filesystem.configure` is its own guard), the start is the device's.
 */
const registered = async () => {
  const { host, runner, demands } = await world(false);
  host.putRoot('imports', 'work/alpha/README.md', 'fixture');
  const response = await host.request('POST', '/v1/projects', {
    body: { kind: 'existing-folder', path: '/work/alpha' },
  });
  return { host, runner, demands, response };
};

test('R-0332 B2 a folder registered through POST /v1/projects becomes a known root for a device start', async () => {
  const { host, runner, demands, response } = await registered();
  expect([response.status, response.body]).toEqual([200, expect.any(String)]);
  const inside = await host.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': 'registered-inside' },
    body: { folder: '/work/alpha/src' },
  });
  expect(inside.status).toBe(201);
  expect(runner.starts).toBe(1);
  expect(asked(demands)).not.toContain('terminal.use');
  const outside = await host.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': 'registered-outside' },
    body: { folder: '/work/alpha-sibling' },
  });
  expect(outside.status).toBe(403);
  expect(asked(demands)).toContain('terminal.use');
});

/**
 * A RELAYED caller that holds the admin token is remote, not local (docs/grants.md): Gate stamps `presentation.local: false`
 * and governs it, whatever the token. `core/gate/tests/unit/daemon/launch-roots-caller.test.ts` runs the real
 * `GateAdmission` for that standing; here the same standing reaches Ferrets and the classification follows: a start in a
 * registered project is ordinary, outside it is `terminal.use`, which the relayed caller does not hold.
 */
test('R-0332 B2 a relayed loopback caller is remote: governed like a device, never the local fast path', async () => {
  const demands: CapabilityDemand[] = [];
  const runner = new FakeRunner();
  const relayed = (request: ApiRequest): CallStanding => {
    const owner = ownerStanding();
    return request.path.startsWith('/v1/ferrets')
      ? {
          ...owner,
          presentation: { ...owner.presentation, local: false } as CallStanding['presentation'],
          governance: {
            governed: true,
            decide: demand => {
              demands.push(demand);
              return String(demand.capability) === 'fleet'
                ? { allowed: true, refusal: 'granted' }
                : { allowed: false, refusal: 'not-granted' };
            },
          },
        }
      : owner;
  };
  const host = await testHost({
    everyDirectory: true,
    plugins: [real('ferrets'), real('projects'), harnessPlugin(new FakeHarness()), runnerPlugin(runner)],
    gate: new StandInAdmission(relayed),
    fakes: { gate: new FakeGate(), vault: new FakeVault(), asks: new FakeAsks() },
  });
  host.putRoot('imports', 'work/alpha/README.md', 'fixture');
  expect(
    (await host.request('POST', '/v1/projects', { body: { kind: 'existing-folder', path: '/work/alpha' } })).status,
  ).toBe(200);
  const inside = await host.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': 'relayed-inside' },
    body: { folder: '/work/alpha' },
  });
  expect(inside.status).toBe(201);
  expect(asked(demands)).not.toContain('terminal.use');
  const outside = await host.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': 'relayed-outside' },
    body: { folder: '/work/elsewhere' },
  });
  expect(outside.status).toBe(403);
  expect(asked(demands)).toContain('terminal.use');
  expect(runner.starts).toBe(1);
});
