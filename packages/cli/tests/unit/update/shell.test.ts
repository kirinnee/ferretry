import { expect, test } from 'bun:test';
import updatesManifest from '../../../../plugins/updates/manifest.ts';
import { decodeJson } from '../../../../core/kernel/host/state/format.ts';
import { UPDATES_REPORT } from '@ferretry/plugin-updates/contract';
import { runFy } from '../../../src/lib/run.ts';
import { buildVerbTable, resolveVerb } from '../../../src/lib/verbs.ts';
import { NixProfileSwitch } from '../../../src/lib/update/profile-switch.ts';
import { DaemonUpdater } from '../../../src/lib/update/updater.ts';
import { entry, fakeWorld, inventoryOf, registryOf } from '../fakes.ts';
import { CapturedOutput, FakePrompt, SteppingClock } from './support.ts';
import {
  FakeFacts,
  FakeHost,
  FakeLatest,
  FakeLifecycle,
  FakePackages,
  FakeReports,
  FakeStandalone,
} from './fixtures.ts';

test.each([false, true])(
  'V-0250 fy update resolves and completes the shell transaction with Updates off (--run=%s)',
  async run => {
    const registry = registryOf(
      entry(updatesManifest, 'updates-hash', async () => {
        throw new Error('plugin must stay off');
      }),
    );
    const f = fakeWorld({ registry, inventory: inventoryOf({ id: 'updates', on: false, contract: 'updates-hash' }) });
    expect(resolveVerb(buildVerbTable(registry), ['update', '--run']).kind).toBe('verb');
    const path = '/fake/bin/fyd';
    const host = new FakeHost(path, '1.2.3', true);
    const lifecycle = new FakeLifecycle(host, path);
    const facts = new FakeFacts('standalone');
    const packages = new FakePackages(host, path);
    const out = new CapturedOutput();
    const prompt = new FakePrompt('yes');
    const reports = new FakeReports();
    const options = {
      facts,
      packages,
      lifecycle,
      out,
      prompt,
      product: 'ferretry',
      clientName: 'fy',
      daemonName: 'fyd',
      homeDirectory: '/fake',
      interactive: () => false,
    };
    let flags: unknown;
    const world = {
      ...f.world,
      update: async (
        received: Parameters<DaemonUpdater['update']>[0],
        view: { view: () => Promise<undefined | import('@ferretry/plugin-updates/contract').DaemonUpdateView> },
      ) => {
        flags = received;
        await new DaemonUpdater({
          ...options,
          latest: new FakeLatest(),
          standalone: new FakeStandalone(host, path),
          updateView: view,
          switcher: new NixProfileSwitch(options),
          reports,
          clock: new SteppingClock(),
        }).update(received);
        return out.exitCode ?? 0;
      },
    };
    expect(
      await runFy(['update', ...(run ? ['--run'] : []), '--yes', '--to', '1.3.0', '--report', '/report.json'], world),
    ).toBe(0);
    expect(flags).toMatchObject({ yes: true, to: '1.3.0', report: '/report.json' });
    expect(host.running).toBe('1.3.0');
    expect(f.transport.sent).toEqual([]);
    const decoded = decodeJson(
      UPDATES_REPORT,
      'state/updates/update/report.json',
      reports.written.get('/report.json') ?? '',
    );
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value.outcome).toBe('succeeded');
  },
);

test('V-0250 manual update remains a shell verb when Updates is absent from the registry', async () => {
  const f = fakeWorld();
  let called = false;
  expect(
    await runFy(['update', '--yes'], {
      ...f.world,
      update: async () => {
        called = true;
        return 0;
      },
    }),
  ).toBe(0);
  expect(called).toBe(true);
  expect(f.connects).toEqual([]);
});
