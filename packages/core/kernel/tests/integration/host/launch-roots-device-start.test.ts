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

const world = async () => {
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
    plugins: [real('ferrets'), real('projects'), harnessPlugin(new FakeHarness()), runnerPlugin(runner)],
    gate: new StandInAdmission(standing),
    fakes: { gate: new FakeGate(), vault: new FakeVault(), asks: new FakeAsks() },
  });
  // The registry as a registration wrote it (the registration itself walks the machine's folders; not this test's subject).
  const id = '00000000-0000-4000-8000-000000000001';
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
