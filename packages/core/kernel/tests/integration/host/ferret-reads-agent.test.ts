import { randomUUID } from 'node:crypto';
import { expect, test } from 'bun:test';
import { Harnesses, Runners, type FerretId } from '../../../../ferrets/contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../../ferrets/contract/testing/index.ts';
import { FULL_DEVICE_GRANTS, type CapabilityGrants } from '../../../../gate/contract/index.ts';
import {
  deviceStanding,
  FakeGate,
  ferretStanding,
  ownerStanding,
  StandInAdmission,
} from '../../../../gate/contract/testing/index.ts';
import { FakeAsks } from '../../../../asks/contract/testing/index.ts';
import { FakeVault } from '../../../../vault/contract/testing/index.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { daemonImplementations } from '../../../src/generated/plugins.ts';
import { testHost } from '../../../testing/index.ts';

/**
 * c58-sec1, the Ferrets half: the REAL Ferrets half (the generated registry builds it, so the route table is the shipped
 * manifest's) behind the stand-in admission (the kernel cannot import Gate's daemon, `context-imports`; Gate's own suite,
 * `core/gate/tests/unit/daemon/ferret-reads-fleet-use.test.ts`, runs the REAL `GateAdmission` over the same shipped
 * descriptors).
 *
 * Two facts are pinned. (1) DEVICE: every ferret read asks `fleet.use`, so a device narrowed off it is refused (403) on
 * each and a device holding it, or the owner at the machine, is answered. (2) AGENT: a ferret's own credential is never
 * grant-governed, and 4.x gave it the FULL record, archive, pin board and restart status of an UNRELATED ferret (no filter,
 * no projection: `packages/daemon/src/lib/runtime/mounts/sessions.ts:115-193`, `session-archive.ts:46-60`, `pins.ts:69-105`,
 * `session-restart.ts:50-56` on origin/main) — so this stays exactly that, and the day somebody fences it the owner decides
 * (docs/grants.md, "Reading a ferret's record is `fleet.use`"). Fixture values only.
 */

const real = (id: string) => {
  const found = daemonImplementations.find(implementation => implementation.manifest.id === id);
  if (found === undefined) throw new Error(`the generated registry has no ${id} half`);
  return found;
};

const CALLER = 'x-test-caller';
const DEVICE = 'x-test-device';
const NO_FLEET_USE = { ...FULL_DEVICE_GRANTS, fleet: { use: false, configure: false } } as CapabilityGrants;

const world = async () => {
  const host = await testHost({
    everyDirectory: true,
    plugins: [
      real('ferrets'),
      // A helper's start is admitted by Packs (helper limits), so its real half runs too.
      real('packs'),
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
        { build: () => ({ hooks: { 'harnesses:claude-code': new FakeHarness() } }) },
      ),
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
        { build: () => ({ hooks: { 'runners:tmux': new FakeRunner() } }) },
      ),
    ],
    gate: new StandInAdmission(request => {
      const caller = request.headers.get(CALLER);
      if (caller !== undefined) return ferretStanding(caller as FerretId);
      const device = request.headers.get(DEVICE);
      if (device === 'narrowed') return deviceStanding('narrowed', NO_FLEET_USE);
      if (device === 'holder') return deviceStanding('holder', FULL_DEVICE_GRANTS);
      return ownerStanding();
    }),
    fakes: { gate: new FakeGate(), vault: new FakeVault(), asks: new FakeAsks() },
  });
  const begin = async (folder: string, parent?: string): Promise<string> => {
    const started = await host.request('POST', '/v1/ferrets', {
      headers: { 'x-fy-request-id': randomUUID() },
      body: { folder, ...(parent === undefined ? {} : { parent }) },
    });
    expect([started.status, started.body]).toEqual([201, expect.any(String)]);
    return started.json<{ id: string }>().id;
  };
  const lead = await begin('/work/lead-project');
  const helper = await begin('/work/lead-project', lead);
  const stranger = await begin('/work/another-project');
  return { host, lead, helper, stranger };
};

const reads = (w: { readonly stranger: string }): readonly (readonly [string, string])[] => [
  ['the list', '/v1/ferrets'],
  ['one ferret', `/v1/ferrets/${w.stranger}`],
  ['a start recovery read', '/v1/ferrets/by-request/never-sent?payload=0'],
  ['the archive', '/v1/archived-sessions'],
  ['a pin board', `/v1/ferrets/${w.stranger}/pins`],
  ['the restart status', '/v1/restarts'],
  ['a handover receipt', `/v1/ferrets/${w.stranger}/handover`],
  ['the relaunch settings', `/v1/ferrets/${w.stranger}/relaunch-settings`],
];

test('c58-sec1 a device narrowed off fleet.use is refused on every ferret read; one holding it, and the owner at the machine, are not', async () => {
  const w = await world();
  for (const [what, path] of reads(w)) {
    const narrowed = await w.host.request('GET', path, { headers: { [DEVICE]: 'narrowed' } });
    expect([what, narrowed.status]).toEqual([what, 403]);
    expect(narrowed.body).toContain('grant_device_not_granted');
    const holder = await w.host.request('GET', path, { headers: { [DEVICE]: 'holder' } });
    expect([what, holder.status === 403]).toEqual([what, false]);
    const owner = await w.host.request('GET', path);
    expect([what, owner.status === 403]).toEqual([what, false]);
  }
});

test('c58-sec1 the narrowed device is refused before the record is read: nothing of the ferret is in the answer', async () => {
  const w = await world();
  const refused = await w.host.request('GET', `/v1/ferrets/${w.stranger}`, { headers: { [DEVICE]: 'narrowed' } });
  expect(refused.status).toBe(403);
  expect(refused.body).not.toContain('/work/another-project');
  expect(refused.body).not.toContain(w.stranger);
  const allowed = await w.host.request('GET', `/v1/ferrets/${w.stranger}`, { headers: { [DEVICE]: 'holder' } });
  expect(allowed.status).toBe(200);
  expect(allowed.json<{ folder: string }>().folder).toBe('/work/another-project');
});

test('c58-sec1 an agent still reads the FULL record of an unrelated ferret, as 4.x gave it (grants never govern a ferret)', async () => {
  const w = await world();
  const asLead = { headers: { [CALLER]: w.lead } };
  const one = await w.host.request('GET', `/v1/ferrets/${w.stranger}`, asLead);
  expect(one.status).toBe(200);
  expect(one.json<{ id: string; folder: string; harness: string }>()).toMatchObject({
    id: w.stranger,
    folder: '/work/another-project',
    harness: 'claude-code',
  });
  const list = await w.host.request('GET', '/v1/ferrets', asLead);
  expect(list.status).toBe(200);
  const rows = list.json<{ id: string; folder: string }[]>();
  expect(rows.map(row => row.id).sort()).toEqual([w.lead, w.helper, w.stranger].sort());
  expect(rows.find(row => row.id === w.stranger)?.folder).toBe('/work/another-project');
  for (const path of ['/v1/archived-sessions', `/v1/ferrets/${w.stranger}/pins`, '/v1/restarts'])
    expect([path, (await w.host.request('GET', path, asLead)).status]).toEqual([path, 200]);
});

test('c58-sec1 a sub-ferret reads its lead, and a lead reads another project’s lead, in full', async () => {
  const w = await world();
  const asHelper = await w.host.request('GET', `/v1/ferrets/${w.lead}`, { headers: { [CALLER]: w.helper } });
  expect(asHelper.status).toBe(200);
  expect(asHelper.json<{ id: string; folder: string }>()).toMatchObject({ id: w.lead, folder: '/work/lead-project' });
  const asLead = await w.host.request('GET', `/v1/ferrets/${w.stranger}`, { headers: { [CALLER]: w.lead } });
  expect(asLead.status).toBe(200);
  expect(asLead.json<{ id: string }>().id).toBe(w.stranger);
});
