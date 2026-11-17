import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FULL_DEVICE_GRANTS } from '@ferretry/core-gate/contract';
import {
  deviceStanding,
  FakeGate,
  ferretStanding,
  ownerStanding,
  StandInAdmission,
} from '@ferretry/core-gate/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import type { ApiRequest, CallStanding } from '@ferretry/kernel/contract';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { type TestHost, testHost } from '@ferretry/kernel/testing';
import { type FerretId, Harnesses, Runners } from '../../../../contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../../contract/testing/index.ts';
import ferrets from '../../../../daemon/index.ts';

/**
 * `GET /v1/ferrets/:ferretId/last-screen`, through the real daemon half: the STORED last screen is the one place a dead
 * pane's text is read back, and it is gated: a ferret that may not touch the target and a device that holds no
 * `terminal.use` are refused before the file is opened, and a ferret with no stored screen is a 409 with a code, never an
 * empty 200. CI only (integration tier). Fixture values only.
 */

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

const callerHeader = 'x-test-caller';
const NO_TERMINAL = { ...FULL_DEVICE_GRANTS, terminal: { use: false, configure: false } };
const standingFor = (request: ApiRequest): CallStanding => {
  const raw = request.headers.get(callerHeader) ?? '';
  if (raw.startsWith('ferret:')) return ferretStanding(raw.slice(7) as FerretId);
  if (raw === 'device:full') return deviceStanding('phone', FULL_DEVICE_GRANTS);
  if (raw === 'device:no-terminal') return deviceStanding('phone', NO_TERMINAL);
  return ownerStanding();
};
const callAs = (caller: string) => ({ headers: { [callerHeader]: caller } });

const boot = async (): Promise<TestHost> =>
  await testHost({
    everyDirectory: true,
    plugins: [ferrets, harnessPlugin(new FakeHarness()), runnerPlugin(new FakeRunner())],
    gate: new StandInAdmission(standingFor),
    fakes: { gate: new FakeGate(), vault: new FakeVault(), asks: new FakeAsks() },
  });

const started = async (h: TestHost): Promise<string> => {
  const made = await h.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': randomUUID() },
    body: { folder: '/work/a', prompt: 'Lead the work.' },
  });
  expect(made.status).toBeLessThan(300);
  await h.settle();
  return made.json<{ id: string }>().id;
};

describe('the stored last screen route', () => {
  test('a ferret with no stored screen is a 409 with a code, and a ferret nobody holds is a 404', async () => {
    const h = await boot();
    const id = await started(h);
    const none = await h.request('GET', `/v1/ferrets/${id}/last-screen`);
    expect(none.status).toBe(409);
    expect(none.json<{ code?: string }>().code).toBe('stored_snapshot_unavailable');
    expect((await h.request('GET', '/v1/ferrets/missing/last-screen')).status).toBe(404);
  });

  test('a device that holds no terminal use is refused, and a ferret that may not touch the target is refused', async () => {
    const h = await boot();
    const id = await started(h);
    expect((await h.request('GET', `/v1/ferrets/${id}/last-screen`, callAs('device:no-terminal'))).status).toBe(403);
    expect((await h.request('GET', `/v1/ferrets/${id}/last-screen`, callAs('ferret:someone-else'))).status).toBe(403);
    // A device that holds it gets past the gate (and reaches the ferret's own 409: nothing stored yet).
    expect((await h.request('GET', `/v1/ferrets/${id}/last-screen`, callAs('device:full'))).status).toBe(409);
  });
});
