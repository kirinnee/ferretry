import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { FakeAsks } from '../../../../asks/contract/testing/index.ts';
import { Harnesses, Runners } from '../../../../ferrets/contract/index.ts';
import { FakeHarness, FakeRunner } from '../../../../ferrets/contract/testing/index.ts';
import { FakeGate, ownerStanding, StandInAdmission } from '../../../../gate/contract/testing/index.ts';
import { FakeVault } from '../../../../vault/contract/testing/index.ts';
import { definePlugin, implementDaemon } from '../../../manifest/index.ts';
import { daemonImplementations } from '../../../src/generated/plugins.ts';
import { ferret } from '../../../testing/admission.ts';
import { type TestHost, testHost } from '../../../testing/index.ts';

/**
 * `fy mcp serve` reaches every agent tool through the kernel's tool door (`POST /v1/agent/tools`, `callTool`). This is the
 * door as a real daemon composes it: the REAL Ferrets half (which owns `instructions`), called as a ferret. It asserts
 * the shape serve maps onto MCP content: a `ToolResult` whose `text` is already a sentence for a model and which survives
 * the JSON the door answers in. The kernel's own config tools and the route itself are covered by
 * `tests/unit/host/agent-config-door.test.ts` and `agent-tools-route.test.ts` (the test host serves neither). Fixture values only.
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

async function boot(): Promise<{ readonly host: TestHost; readonly id: string }> {
  const host = await testHost({
    everyDirectory: true,
    plugins: [real('ferrets'), harnessPlugin(new FakeHarness()), runnerPlugin(new FakeRunner())],
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: { gate: new FakeGate(), vault: new FakeVault(), asks: new FakeAsks() },
  });
  const started = await host.request('POST', '/v1/ferrets', {
    headers: { 'x-fy-request-id': randomUUID() },
    body: { folder: '/work/lead', prompt: 'Lead the work.' },
  });
  expect(started.status).toBeLessThan(300);
  await host.settle();
  return { host, id: started.json<{ id: string }>().id };
}

describe('the tool door as serve reaches it', () => {
  test('instructions answers a ferret a sentence of text, not an error, and the result survives JSON', async () => {
    const { host, id } = await boot();
    const answer = await host.tool('instructions', {}, { as: ferret(id) });
    expect(answer.isError).not.toBe(true);
    expect(answer.text.length).toBeGreaterThan(0);
    expect(JSON.parse(JSON.stringify(answer))).toEqual(answer);
  });
});
