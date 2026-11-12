import { PERSON_ORIGIN } from '../../../../contract/index.ts';
import { expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeGate, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { testHost } from '@ferretry/kernel/testing';
import { FerretFiles, type FerretRecord, FerretsPort, Harnesses, Runners } from '../../../../contract/index.ts';
import { FakeHarness, FakeRunner, ferretId, T0 } from '../../../../contract/testing/index.ts';
import ferrets from '../../../../daemon/index.ts';

/**
 * The kernel builds the Ferrets port once per plugin that needs it, from that plugin's manifest id: what a consumer
 * says about WHO acts is checked against who it is. Real Ferrets, two plugins that need the port.
 */

const plugin = (id: string, take?: { readonly hook: typeof Harnesses | typeof Runners; readonly key: string }) =>
  implementDaemon(
    definePlugin({
      id,
      title: id,
      version: '5.0.0',
      api: 5,
      core: false,
      kinds: [],
      needs: { ferrets: FerretsPort },
      ...(take === undefined ? {} : { hooks: { takes: [take] } }),
    }),
    { build: () => ({}) },
  );
const harnessPlugin = implementDaemon(
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
);
const runnerPlugin = implementDaemon(
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
);

const stopped: FerretRecord = {
  format: 1,
  id: ferretId('f1'),
  name: 'f1',
  role: 'lead',
  harness: 'claude-code',
  runner: 'tmux',
  folder: '/work/f1',
  state: 'stopped',
  createdAt: T0,
  stateAt: T0,
};

async function boot() {
  const first = await testHost({
    plugins: [ferrets, harnessPlugin, runnerPlugin, plugin('warden'), plugin('board')],
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: { gate: new FakeGate(), vault: new FakeVault(), asks: new FakeAsks() },
  });
  first.state('ferrets').plant(FerretFiles, JSON.stringify(stopped), stopped.id);
  return await first.restart();
}

test('KCB-S a non-warden consumer naming the Warden through the Ferrets port is refused, and the Warden is not', async () => {
  const host = await boot();
  const board = host.provided(FerretsPort, 'board');
  const warden = host.provided(FerretsPort, 'warden');
  expect(board).not.toBe(warden);

  expect(
    await board.resume(stopped.id, undefined, { origin: PERSON_ORIGIN, automatic: true, actor: 'warden' }),
  ).toEqual({
    ok: false,
    error: { code: 'refused', reason: 'only the Warden is recorded as the Warden' },
  });
  expect(await board.move!(stopped.id, 'codex-two', { origin: PERSON_ORIGIN, movedBy: 'warden' })).toMatchObject({
    ok: false,
    error: { code: 'refused' },
  });
  expect(await board.start({ folder: '/work', by: 'warden' }, PERSON_ORIGIN)).toMatchObject({
    ok: false,
    error: { code: 'refused' },
  });
  await expect(board.systemCallsign!('warden')).rejects.toMatchObject({ status: 403 });

  expect(await warden.systemCallsign!('warden')).toMatch(/^warden-[0-9a-f]{6}$/u);
  await host.stop();
});
