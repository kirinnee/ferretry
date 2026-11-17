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
import { type FerretId, FerretLiveReadSchema, Harnesses, Runners } from '../../../../contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../../contract/testing/index.ts';
import ferrets from '../../../../daemon/index.ts';

/**
 * `GET /v1/ferrets/:ferretId/live`, through the real daemon half: a ferret started by the ordinary start route has a
 * state document, and the route serves the turns and the context that document stands on NOW — the previous turn's
 * analytics row is not consulted. A reading the document does not state is `null`, never zero. CI only (integration
 * tier). Fixture values only.
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

describe('the ferret’s live turns and context', () => {
  test('serves what the state document says now, and null for what it does not state', async () => {
    const h = await boot();
    const id = await started(h);
    const files = h.state('ferrets').files;
    const path = `${id}/state.json`;
    const document = JSON.parse(files.get(path) as string) as Record<string, unknown>;

    // Mid-turn: a turn count, a context percent and a window are in the document.
    files.set(
      path,
      JSON.stringify({ ...document, turn: 7, contextPercent: 62, contextWindow: 200_000, contextTokens: 124_000 }),
    );
    const live = await h.request('GET', `/v1/ferrets/${id}/live`);
    expect(live.status).toBe(200);
    expect(FerretLiveReadSchema.parse(live.json())).toEqual({
      turns: 7,
      contextPercent: 62,
      contextWindow: 200_000,
      contextTokens: 124_000,
    });

    // Nothing stated about the context: null, never 0.
    const { contextPercent: _percent, contextWindow: _window, contextTokens: _tokens, ...bare } = document;
    files.set(path, JSON.stringify({ ...bare, turn: 0 }));
    expect((await h.request('GET', `/v1/ferrets/${id}/live`)).json()).toEqual({
      turns: 0,
      contextPercent: null,
      contextWindow: null,
      contextTokens: null,
    });

    // A document that does not parse states nothing.
    files.set(path, '{ not json');
    expect((await h.request('GET', `/v1/ferrets/${id}/live`)).json()).toEqual({
      turns: null,
      contextPercent: null,
      contextWindow: null,
      contextTokens: null,
    });
  });

  test('a governed device narrowed off fleet use is refused; one holding it is served', async () => {
    const h = await boot();
    const id = await started(h);
    const refused = await h.request('GET', `/v1/ferrets/${id}/live`, callAs('device:narrowed'));
    expect(refused.status).toBe(403);
    expect(refused.body).not.toContain('turns');
    const served = await h.request('GET', `/v1/ferrets/${id}/live`, callAs('device:full'));
    expect(served.status).toBe(200);
    expect(FerretLiveReadSchema.safeParse(served.json()).success).toBe(true);
  });

  test('an agent caller reads a ferret (v4 reach: the sibling ferret reads fence no agent)', async () => {
    const h = await boot();
    const id = await started(h);
    const served = await h.request('GET', `/v1/ferrets/${id}/live`, callAs('ferret:someone-else'));
    expect(served.status).toBe(200);
    expect(FerretLiveReadSchema.safeParse(served.json()).success).toBe(true);
  });

  test('a ferret nobody holds is a 404, as the ferret read is', async () => {
    const h = await boot();
    expect((await h.request('GET', '/v1/ferrets/missing/live')).status).toBe(404);
  });
});
