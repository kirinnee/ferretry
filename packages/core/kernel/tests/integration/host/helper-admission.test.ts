import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { FakeAsks } from '../../../../asks/contract/testing/index.ts';
import { FerretsPort, Harnesses, Runners } from '../../../../ferrets/contract/index.ts';
import { FakeHarness, FakeRunner, ferretId } from '../../../../ferrets/contract/testing/index.ts';
import { FakeGate, ownerStanding, StandInAdmission } from '../../../../gate/contract/testing/index.ts';
import { FakeVault } from '../../../../vault/contract/testing/index.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { daemonImplementations } from '../../../src/generated/plugins.ts';
import { type TestHost, testHost } from '../../../testing/index.ts';

/**
 * G12, RULING #43, through the daemon: the REAL Ferrets and the REAL Packs halves, as the generated registry builds
 * them (the composition root binds nothing special). A helper's admission is Packs' own answer on `start.decide`:
 * with Packs present a child starts, is stamped under its lead, and still is after a restart; a Warden resume of it
 * goes through the same answer; Packs' own limit (depth) refuses with its sentence. With Packs absent every child
 * start is refused 503 `helper_admission_unavailable`, before and after a restart, and nothing is launched.
 *
 * CI only (integration tier). Fixture values only.
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

/** A stand-in for Ferretry's Warden (its real id): the only consumer that may resume as `actor: 'warden'`, so a test takes the port as it. */
const wardenPlugin = implementDaemon(
  definePlugin({
    id: 'warden',
    title: 'Warden (fake)',
    version: '5.0.0',
    api: 5,
    core: false,
    kinds: [],
    needs: { ferrets: FerretsPort },
  }),
  { build: () => ({}) },
);

async function boot(packs: boolean, runner: FakeRunner): Promise<TestHost> {
  return await testHost({
    everyDirectory: true,
    plugins: [
      real('ferrets'),
      ...(packs ? [real('packs')] : []),
      harnessPlugin(new FakeHarness()),
      runnerPlugin(runner),
      wardenPlugin,
    ],
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: { gate: new FakeGate(), vault: new FakeVault(), asks: new FakeAsks() },
  });
}

const start = async (h: TestHost, body: Record<string, unknown>) =>
  await h.request('POST', '/v1/ferrets', { headers: { 'x-fy-request-id': randomUUID() }, body });

const idOf = (answer: Awaited<ReturnType<typeof start>>) => answer.json<{ id: string }>().id;

/**
 * The two fields of the ferret's session document this test reads, as they are on disk (Ferrets' own schema is its
 * daemon's, which another package does not import; its own test, `session-document-restart.test.ts`, parses it whole).
 */
const document = (h: TestHost, id: string) => {
  const raw = h.state('ferrets').files.get(`${id}/config.json`);
  return raw === undefined
    ? undefined
    : (JSON.parse(raw as string) as { readonly parent?: string; readonly provenance?: Record<string, unknown> });
};

const stop = async (h: TestHost, id: string) =>
  (await h.request('POST', `/v1/ferrets/${id}/stop`, { query: { how: 'now' }, body: {} })).status;

describe('G12 helper admission through the daemon: the real Packs answers start.decide', () => {
  test('G12 R-0332 with Packs present a child starts and is stamped under its lead, also after a restart, and a Warden resume of it relaunches', async () => {
    // Arrange: a lead started through the real start route.
    const runner = new FakeRunner();
    const first = await boot(true, runner);
    const lead = await start(first, { folder: '/work/lead', prompt: 'Lead the work.' });
    expect(lead.status).toBeLessThan(300);
    const leadId = idOf(lead);
    await first.settle();

    // Act: a child before the restart, then a restart and a second child.
    const before = await start(first, { folder: '/work/a', prompt: 'Help.', parent: leadId });
    await first.settle();
    const second = await first.restart();
    await second.settle();
    const after = await start(second, { folder: '/work/b', prompt: 'Help more.', parent: leadId });
    await second.settle();

    // Assert: both children were admitted by Packs and stamped by the strict ancestry under the lead.
    expect(before.status).toBeLessThan(300);
    expect(after.status).toBeLessThan(300);
    // Both are read from the restarted daemon: the one stamped before the restart kept its document.
    for (const child of [idOf(before), idOf(after)]) {
      const stamped = document(second, child);
      expect(stamped?.parent).toBe(leadId);
      expect(stamped?.provenance).toBeDefined();
    }

    // A Warden resume of the stopped child goes through the same start.decide, and Packs answers it.
    const childId = idOf(after);
    expect(await stop(second, childId)).toBeLessThan(300);
    await second.settle();
    const resumed = await second
      .provided(FerretsPort, 'warden')
      .resume(ferretId(childId), 'carry on', { automatic: true, actor: 'warden' });
    expect(resumed.ok).toBe(true);
  });

  test("G12 R-0332 with Packs present its own limit refuses a child too deep, with Packs' sentence", async () => {
    // Arrange: lead (depth 0) -> child (1) -> grandchild (2); the default limits nest helpers 2 deep.
    const runner = new FakeRunner();
    const h = await boot(true, runner);
    const lead = idOf(await start(h, { folder: '/work/lead', prompt: 'Lead.' }));
    const child = await start(h, { folder: '/work/c', prompt: 'Help.', parent: lead });
    expect(child.status).toBeLessThan(300);
    const grandchild = await start(h, { folder: '/work/g', prompt: 'Help.', parent: idOf(child) });
    expect(grandchild.status).toBeLessThan(300);
    const launched = runner.starts;

    // Act
    const tooDeep = await start(h, { folder: '/work/d', prompt: 'Help.', parent: idOf(grandchild) });

    // Assert: Packs' own no, served; nothing launched.
    expect(tooDeep.status).toBeGreaterThanOrEqual(400);
    expect(tooDeep.status).toBeLessThan(500);
    expect(JSON.stringify(tooDeep.json())).toContain('may not start its own');
    expect(runner.starts).toBe(launched);
  });

  test('G12 R-0332 with Packs absent every child start is refused 503, before and after a restart, and nothing launches', async () => {
    // Arrange: a lead starts (it needs no helper admission).
    const runner = new FakeRunner();
    const first = await boot(false, runner);
    const lead = await start(first, { folder: '/work/lead', prompt: 'Lead the work.' });
    expect(lead.status).toBeLessThan(300);
    const leadId = idOf(lead);
    await first.settle();
    const launched = runner.starts;

    // Act
    const before = await start(first, { folder: '/work/a', prompt: 'Help.', parent: leadId });
    const second = await first.restart();
    await second.settle();
    const after = await start(second, { folder: '/work/b', prompt: 'Help.', parent: leadId });

    // Assert
    for (const refused of [before, after]) {
      expect(refused.status).toBe(503);
      expect(refused.json<{ code: string }>().code).toBe('helper_admission_unavailable');
    }
    expect(runner.starts).toBe(launched);
    expect((await second.request('GET', '/v1/ferrets')).json<unknown[]>()).toHaveLength(1);
  });
});
