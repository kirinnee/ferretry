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
import { type FerretId, FerretSummarySchema, Harnesses, Runners } from '../../../../contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../../contract/testing/index.ts';
import ferrets from '../../../../daemon/index.ts';

/**
 * `GET /v1/ferrets/:ferretId`, through the real daemon half: a ferret the harness reports running a model carries it as
 * `observedModel` — also an UNPINNED ferret, which was launched on no model at all — and one the harness has said
 * nothing about carries none. The list never opens documents. CI only (integration tier). Fixture values only.
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

/** Who calls: `x-test-caller` names a ferret (`ferret:<id>`) or a paired device (`device:full` / `device:narrowed`). */
const callerHeader = 'x-test-caller';
const NARROWED = { ...FULL_DEVICE_GRANTS, fleet: { use: false, configure: false } };
const standingFor = (request: ApiRequest): CallStanding => {
  const raw = request.headers.get(callerHeader) ?? '';
  if (raw.startsWith('ferret:')) return ferretStanding(raw.slice(7) as FerretId);
  if (raw === 'device:full') return deviceStanding('phone', FULL_DEVICE_GRANTS);
  if (raw === 'device:narrowed') return deviceStanding('phone', NARROWED);
  return ownerStanding();
};

const boot = async (): Promise<TestHost> =>
  await testHost({
    everyDirectory: true,
    plugins: [
      ferrets,
      harnessPlugin(new FakeHarness()),
      runnerPlugin(Object.assign(new FakeRunner(), { requireFerret: true })),
    ],
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

describe('the model the harness reports running, on the ferret read', () => {
  test('is served once the state document holds it, for a ferret launched on no model', async () => {
    const h = await boot();
    const id = await started(h);
    const files = h.state('ferrets').files;
    const path = `${id}/state.json`;
    const document = JSON.parse(files.get(path) as string) as Record<string, unknown>;

    const before = FerretSummarySchema.parse((await h.request('GET', `/v1/ferrets/${id}`)).json());
    expect(before.model, 'launched on no model').toBeUndefined();
    expect(before.observedModel, 'nothing reported yet').toBeUndefined();

    files.set(path, JSON.stringify({ ...document, observedModel: ' claude-opus-5-5 ' }));
    const after = FerretSummarySchema.parse((await h.request('GET', `/v1/ferrets/${id}`)).json());
    expect(after.observedModel).toBe('claude-opus-5-5');
    expect(after.model, 'the launch model stays what was asked for').toBeUndefined();

    const listed = (await h.request('GET', '/v1/ferrets')).json<{ id: string; observedModel?: string }[]>();
    expect(listed.find(summary => summary.id === id)?.observedModel, 'the list opens no documents').toBeUndefined();
  });

  test('a state document that does not parse reports nothing', async () => {
    const h = await boot();
    const id = await started(h);
    h.state('ferrets').files.set(`${id}/state.json`, '{ not json');
    const read = await h.request('GET', `/v1/ferrets/${id}`);
    expect(read.status).toBe(200);
    expect(FerretSummarySchema.parse(read.json()).observedModel).toBeUndefined();
  });
});
