/**
 * A converted home's `direct.port` is IN EFFECT on the first boot (the unit daemon-port-config exists for this case).
 *
 * `fyd` binds the port the configuration service has IN EFFECT, and a `direct` block nobody accepted is a held loosening,
 * so the converter's accepted-config step must record the `connections.yaml` it wrote — exactly as it records every other
 * config file — or a migrated home would bind 7457 (the original bug). Here a v4 home whose `daemon.json` binds 7603 is
 * converted by the real Settings, Daemon settings and accepted-config steps on one writer, in the converter's order, and
 * the REAL `fyd --print-config` is asked which port it would bind. A v4 home that was holding an unconfirmed edit keeps
 * the owner's "not yet" (the accepted-config tests), so its `connections.yaml` is held like any other file.
 *
 * The 5.0 code is imported by path, like the other tests of this package that need a 5.0 reader (this package is not a
 * workspace member).
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { acceptedName } from '@ferretry/kernel/contract';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dryConfigsOf } from '../../src/convert.ts';
import { acceptedConfigStep } from '../../src/steps/accepted-config.ts';
import { daemonSettingsStep } from '../../src/steps/daemon-settings.ts';
import { settingsStep } from '../../src/steps/settings.ts';
import { fixture } from './ferret-fixture.ts';

const repo = join(import.meta.dir, '../../../..');
const FYD = join(repo, 'packages/core/kernel/host/fyd.ts');

let f: Awaited<ReturnType<typeof fixture>>;
beforeEach(async () => {
  f = await fixture();
});
afterEach(async () => {
  await f.clean();
});

/** What `fyd --print-config` says the daemon would bind for this home: reads, binds and creates nothing. */
async function portRow(home: string): Promise<string | undefined> {
  const child = Bun.spawn({
    cmd: [process.execPath, FYD, '--print-config'],
    cwd: repo,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: f.to, FY_HOME: home },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return out.split('\n').find(line => line.startsWith('port')) ?? err;
}

/** The converter's steps, in its order, on ONE writer. */
async function convert(): Promise<void> {
  const steps = [settingsStep, daemonSettingsStep];
  const ctx = { ...f.ctx(), dryConfigs: dryConfigsOf(f.from, f.to, undefined, steps) };
  for (const step of steps) expect((await step.run(ctx)).status).toBe('converted');
  expect((await acceptedConfigStep.run(ctx)).status).toBe('converted');
}

test('a v4 home that bound 7603 starts on 7603: the converter records connections.yaml as accepted, so fyd binds it', async () => {
  await f.put('config/daemon.json', { carriers: [{ kind: 'bind', host: '127.0.0.1', port: 7603 }] });
  await f.put('state/config-accepted.json', {});
  await convert();
  const record = JSON.parse(
    await readFile(join(f.to, 'state/kernel/accepted-config', `${acceptedName('connections.yaml')}.json`), 'utf8'),
  ) as {
    plugin: string;
    text: string;
  };
  expect(record.plugin).toBe('connections');
  expect(record.text).toContain('7603');
  expect(await portRow(f.to)).toMatch(/^port\s+7603\s+home config \(config\/connections\.yaml direct\.port\)/);
});

test('the legacy host/port spelling of daemon.json lands the same way', async () => {
  await f.put('config/daemon.json', { host: '127.0.0.1', port: 7455 });
  await f.put('state/config-accepted.json', {});
  await convert();
  expect(await portRow(f.to)).toMatch(/^port\s+7455\s+home config/);
});
