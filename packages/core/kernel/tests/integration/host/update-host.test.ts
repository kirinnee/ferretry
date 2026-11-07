/** XX: the launch is the one detached command, its report and log in the plugin's own state folder. */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { updateHostFor } from '../../../host/adapters/update-host.ts';

const homes: string[] = [];
afterAll(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
});

describe('XX updateHostFor launch', () => {
  test('<client beside argv0> update --run --to <target> --report <declared report>, FY_HOME set', async () => {
    const home = await mkdtemp(`${tmpdir()}/fy-update-`);
    homes.push(home);
    const calls: { argv: readonly string[]; environment: Record<string, string | undefined>; logFile: string }[] = [];
    const port = updateHostFor({
      home,
      binary: 'fy',
      release: '5.0.0',
      process: {
        argv0: '/home/owner/.local/bin/fyd',
        execPath: '/opt/ferretry/fyd',
        main: '/$bunfs/root/fyd',
        workingDirectory: '/',
        platform: 'linux',
      },
      environment: { PATH: '/usr/bin' },
      spawn: (argv, options) => calls.push({ argv, environment: { ...options.environment }, logFile: options.logFile }),
    })('updates', { report: 'update/report.json', log: 'update.log' });
    expect(await port.launchUpdate('v5.1.0')).toEqual({ kind: 'started' });
    expect(calls[0]?.argv).toEqual([
      '/home/owner/.local/bin/fy',
      'update',
      '--run',
      '--to',
      'v5.1.0',
      '--report',
      `${home}/state/updates/update/report.json`,
    ]);
    expect(calls[0]?.environment).toEqual({ PATH: '/usr/bin', FY_HOME: home });
    expect(calls[0]?.logFile).toBe(`${home}/state/updates/update.log`);
    expect(((await stat(`${home}/state/updates`)).mode & 0o777) <= 0o700).toBe(true);
  });
});
