import { expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeGate, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import { definePlugin, implementDaemon } from '@ferretry/kernel/manifest';
import { testHost } from '@ferretry/kernel/testing';
import {
  FerretFiles,
  type FerretRecord,
  FerretsPort,
  Harnesses,
  RuntimeControlError,
  Runners,
} from '../../../../contract/index.ts';
import { FakeHarness, FakeRunner, ferretId, T0 } from '../../../../contract/testing/index.ts';
import ferrets from '../../../../daemon/index.ts';

/**
 * The feature as the kernel composes it: real Ferrets, a harness plugin that offers no `runtimeSwitch`, and a consumer
 * that needs the Ferrets port (Runtimes is that consumer). What is proved here is what only the composition can show:
 * that the member is on the port every needer is handed, and that WHO MAY SWITCH WHOSE is Ferrets' own `mayTouch` rule,
 * applied by the real service before anything is read.
 */

const consumer = implementDaemon(
  definePlugin({
    id: 'runtimes',
    title: 'Runtimes (fake consumer)',
    version: '5.0.0',
    api: 5,
    core: false,
    kinds: [],
    needs: { ferrets: FerretsPort },
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

const record = (name: string): FerretRecord => ({
  format: 1,
  id: ferretId(name),
  name,
  role: 'lead',
  harness: 'claude-code',
  runner: 'tmux',
  folder: `/work/${name}`,
  state: 'stopped',
  createdAt: T0,
  stateAt: T0,
});

async function boot() {
  const first = await testHost({
    plugins: [ferrets, harnessPlugin, runnerPlugin, consumer],
    gate: new StandInAdmission(() => ownerStanding()),
    fakes: { gate: new FakeGate(), vault: new FakeVault(), asks: new FakeAsks() },
  });
  for (const name of ['f1', 'f2'])
    first.state('ferrets').plant(FerretFiles, JSON.stringify(record(name)), ferretId(name));
  return await first.restart();
}

test('the Ferrets port every needer is handed carries the runtime control', async () => {
  const host = await boot();
  const port = host.provided(FerretsPort, 'runtimes');
  expect(port.runtimeControl).toBeDefined();
  await host.stop();
});

test('a ferret that is neither the target nor its lead or helper is refused 403 forbidden, by the real rule, on both calls', async () => {
  const host = await boot();
  const control = host.provided(FerretsPort, 'runtimes').runtimeControl!;
  await expect(control.models(ferretId('f1'), 'f2')).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  await expect(control.control(ferretId('f1'), 'f2', { action: 'compact' }, 'request-1')).rejects.toMatchObject({
    status: 403,
    code: 'forbidden',
  });
  await host.stop();
});

test('a person reaches any ferret, and a harness that offers no runtimeSwitch is answered unsupported', async () => {
  const host = await boot();
  const control = host.provided(FerretsPort, 'runtimes').runtimeControl!;
  for (const caller of [undefined, ferretId('f2')]) {
    const refused = await control
      .control(caller, 'f2', { action: 'compact' }, 'request-1')
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(RuntimeControlError);
    expect((refused as RuntimeControlError).failure).toBe('unsupported');
  }
  await host.stop();
});

test('an unknown ferret is not_found, whoever asks', async () => {
  const host = await boot();
  const control = host.provided(FerretsPort, 'runtimes').runtimeControl!;
  const refused = await control.models(undefined, 'nobody').catch((error: unknown) => error);
  expect((refused as RuntimeControlError).failure).toBe('not_found');
  await host.stop();
});
