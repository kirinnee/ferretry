import { afterAll, describe, it } from 'bun:test';
import { stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import should from 'should';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import { StateUnlockLedger } from '../../../src/adapters/step-up/index.ts';
import { createFoundationPaths, resolveStateHome } from '../../../src/lib/index.ts';
import { cleanupTempDirectories, tempDirectory } from '../support/repository.ts';

/**
 * Each device's last unlock, on disk, so a restart does not ask again inside the period: a device id and
 * an instant, owner-only, bound to the daemon identity that wrote it.
 */

afterAll(async () => {
  await cleanupTempDirectories();
});

const deviceOne = `fy_device_id_${'a'.repeat(22)}`;
const deviceTwo = `fy_device_id_${'b'.repeat(22)}`;
const DAEMON = 'fy_daemon_this-machine';
const AT = Date.parse('2026-10-21T08:00:00.000Z');

async function fixture(label: string, daemonId = DAEMON) {
  const home = await tempDirectory(label);
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  const files = new StateFileSystem(paths);
  await files.ensureDirectory(paths.state, 0o700);
  return {
    paths,
    files,
    path: join(paths.state, 'unlocks.json'),
    ledger: new StateUnlockLedger(paths, files, daemonId),
  };
}

describe('StateUnlockLedger', () => {
  it('should read as no unlocks when nothing was ever written', async () => {
    // Arrange
    const { ledger } = await fixture('unlocks-absent');

    // Act / Assert
    should([...(await ledger.read())]).deepEqual([]);
  });

  it('should read back what it wrote, owner-only, holding nothing but device ids and instants', async () => {
    // Arrange
    const { ledger, path, paths, files } = await fixture('unlocks-round-trip');

    // Act
    await ledger.write(
      new Map([
        [deviceOne, AT],
        [deviceTwo, AT + 1_000],
      ]),
    );
    const again = new StateUnlockLedger(paths, files, DAEMON);

    // Assert
    should([...(await again.read())]).deepEqual([
      [deviceOne, AT],
      [deviceTwo, AT + 1_000],
    ]);
    should((await stat(path)).mode & 0o777).equal(0o600);
    should(JSON.parse(await Bun.file(path).text())).deepEqual({
      schemaVersion: 1,
      daemonId: DAEMON,
      unlocks: [
        { deviceId: deviceOne, unlockedAt: '2026-10-21T08:00:00.000Z' },
        { deviceId: deviceTwo, unlockedAt: '2026-10-21T08:00:01.000Z' },
      ],
    });
  });

  it('should read a ledger another daemon identity wrote as holding nothing', async () => {
    // Arrange
    const { ledger, paths, files } = await fixture('unlocks-other-daemon');
    await ledger.write(new Map([[deviceOne, AT]]));

    // Act
    const elsewhere = new StateUnlockLedger(paths, files, 'fy_daemon_another-machine');

    // Assert
    should([...(await elsewhere.read())]).deepEqual([]);
  });

  it('should refuse a document that is not JSON, or not unlocks, as damage', async () => {
    // Arrange
    const broken = await fixture('unlocks-not-json');
    await writeFile(broken.path, '{not json');
    const wrong = await fixture('unlocks-wrong-shape');
    await writeFile(wrong.path, JSON.stringify({ schemaVersion: 1, daemonId: DAEMON, unlocks: [{ deviceId: 'x' }] }));

    // Act / Assert
    await should(broken.ledger.read()).be.rejectedWith({
      name: 'UnlockLedgerDamaged',
      message: 'the unlock ledger is not valid JSON',
    });
    await should(wrong.ledger.read()).be.rejectedWith({
      name: 'UnlockLedgerDamaged',
      message: 'the unlock ledger does not describe unlocks',
    });
  });
});
