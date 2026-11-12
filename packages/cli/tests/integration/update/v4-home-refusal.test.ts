/**
 * Ferretry 5's `fy daemon install`, `restart` and `update` (the update machine's restart and install) on a Ferretry 4
 * home that was never carried over: each refuses with the daemon's own sentence (prompt + the way back to 4.291.10),
 * writes no unit and no plist, starts no service manager command, and leaves the home byte-for-byte as it was.
 * The service manager is a pair of fake `systemctl`/`launchctl` scripts on PATH that record every call.
 */
import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { buildDaemonController } from '../../../src/adapters/daemon/control.ts';
import { buildUpdateMachine } from '../../../src/adapters/update/machine.ts';
import type { DaemonControlReads } from '../../../src/lib/daemon/controller.ts';
import { capturedIo } from '../../unit/fakes.ts';
import { snapshotTree, writeV4Home } from '../support/v4-home.ts';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(async dir => await rm(dir, { recursive: true, force: true })));
});

const PROMPT = 'docs/migration/v4-to-v5-prompt.md';
const reads: DaemonControlReads = {
  resetInventory: { count: async () => await Promise.resolve(undefined) },
  turns: { midTurn: async () => await Promise.resolve(0) },
};

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'fy-v4-refusal-'));
  dirs.push(root);
  const bin = join(root, 'bin');
  const calls = join(root, 'service-manager-calls');
  await mkdir(bin, { recursive: true });
  for (const name of ['systemctl', 'launchctl']) {
    await writeFile(join(bin, name), `#!/bin/sh\necho "${name} $@" >> '${calls}'\n`, { mode: 0o755 });
    await chmod(join(bin, name), 0o755);
  }
  await writeFile(join(bin, 'fyd'), '#!/bin/sh\necho 5.0.0\n', { mode: 0o755 });
  await chmod(join(bin, 'fyd'), 0o755);
  const home = join(root, '.ferretry');
  writeV4Home(home);
  const environment = {
    XDG_RUNTIME_DIR: join(root, 'runtime'),
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_STATE_HOME: join(root, 'xdg-state'),
    PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
  };
  const units = (): boolean =>
    existsSync(join(root, 'config/systemd/user/fyd.service')) ||
    existsSync(join(root, 'Library/LaunchAgents/com.ferretry.fyd.plist'));
  const noServiceManagerCall = async (): Promise<void> => {
    should(await readFile(calls, 'utf8').catch(() => '')).equal('');
  };
  return { root, bin, home, environment, units, noServiceManagerCall };
}

describe('Ferretry 5 on a Ferretry 4 home that was not carried over', () => {
  for (const platform of ['linux', 'darwin']) {
    it(`should refuse install and restart on ${platform}: the carry-over sentence, no unit, no plist, home untouched`, async () => {
      const h = await setup();
      const before = snapshotTree(h.home);
      const { controller } = buildDaemonController(
        {
          environment: h.environment,
          io: capturedIo(),
          home: h.home,
          userHome: h.root,
          product: 'ferretry',
          clientName: 'fy',
          daemonName: 'fyd',
          selfPath: join(h.bin, 'fy'),
          launch: async () => await Promise.resolve({ started: false, why: 'a test starts no daemon' }),
          platform,
        },
        reads,
      );
      for (const verb of [
        async () => await controller.install(),
        async () => await controller.restart({ midTurnSaid: true }),
      ]) {
        const refusal = await verb().then(
          () => '',
          (error: unknown) => (error instanceof Error ? error.message : String(error)),
        );
        should(refusal)
          .containEql(PROMPT)
          .and.containEql('reinstall 4.291.10 or later')
          .and.containEql('this folder is unchanged');
        should(refusal).not.containEql('creates it on its first start');
      }
      should(h.units()).be.false();
      await h.noServiceManagerCall();
      should(snapshotTree(h.home)).eql(before);
    });

    it(`should refuse the update machine's restart and install on ${platform} the same way`, async () => {
      const h = await setup();
      const before = snapshotTree(h.home);
      const machine = buildUpdateMachine(
        {
          environment: h.environment,
          io: capturedIo(),
          home: h.home,
          userHome: h.root,
          product: 'ferretry',
          clientName: 'fy',
          daemonName: 'fyd',
          binaries: ['fy', 'fyd'],
          selfPath: join(h.bin, 'fy'),
          platform,
        },
        { view: async () => await Promise.resolve(undefined) },
      );
      await should(machine.deps.lifecycle.restart()).rejectedWith(/reinstall 4\.291\.10 or later/);
      await should(machine.deps.lifecycle.installAt(join(h.bin, 'fyd'))).rejectedWith(/reinstall 4\.291\.10 or later/);
      should(h.units()).be.false();
      await h.noServiceManagerCall();
      should(snapshotTree(h.home)).eql(before);
    });
  }
});
