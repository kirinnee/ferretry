import { describe, it } from 'bun:test';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import should from 'should';
import { UnlocksFile } from '../../../../contract/index.ts';
import { StateUnlockLedger } from '../../../../daemon/adapters/step-up/state-unlock-ledger.ts';

/**
 * Each device's last unlock, in Access's state, so a restart does not ask again inside the period: a device id and
 * an instant, owner-only, bound to the daemon identity that wrote it.
 */

const deviceOne = `fy_device_id_${'a'.repeat(22)}`;
const deviceTwo = `fy_device_id_${'b'.repeat(22)}`;
const DAEMON = 'fy_daemon_this-machine';
const AT = Date.parse('2026-10-21T08:00:00.000Z');

function fixture(daemonId = DAEMON, folder = new MemoryStateFolder()) {
  const state = folder.port([UnlocksFile]);
  return { folder, state, ledger: new StateUnlockLedger(state, daemonId) };
}

describe('StateUnlockLedger', () => {
  it('should read as no unlocks when nothing was ever written', async () => {
    // Arrange
    const { ledger } = fixture();

    // Act / Assert
    should([...(await ledger.read())]).deepEqual([]);
  });

  it('G76 should read back what it wrote, owner-only, holding nothing but device ids and instants', async () => {
    // Arrange
    const { ledger, folder } = fixture();

    // Act
    await ledger.write(
      new Map([
        [deviceOne, AT],
        [deviceTwo, AT + 1_000],
      ]),
    );
    const again = fixture(DAEMON, folder).ledger;

    // Assert
    should([...(await again.read())]).deepEqual([
      [deviceOne, AT],
      [deviceTwo, AT + 1_000],
    ]);
    should(UnlocksFile.mode).equal(0o600);
    should(JSON.parse(folder.raw(UnlocksFile) ?? 'null')).deepEqual({
      format: 1,
      daemonId: DAEMON,
      unlocks: [
        { deviceId: deviceOne, unlockedAt: '2026-10-21T08:00:00.000Z' },
        { deviceId: deviceTwo, unlockedAt: '2026-10-21T08:00:01.000Z' },
      ],
    });
  });

  it('should read a ledger another daemon identity wrote as holding nothing', async () => {
    // Arrange
    const { ledger, folder } = fixture();
    await ledger.write(new Map([[deviceOne, AT]]));

    // Act
    const elsewhere = fixture('fy_daemon_another-machine', folder).ledger;

    // Assert
    should([...(await elsewhere.read())]).deepEqual([]);
  });

  it('should refuse a document that is not JSON, or not unlocks, as damage', async () => {
    // Arrange
    const broken = fixture();
    broken.folder.plant(UnlocksFile, '{not json');
    const wrong = fixture();
    wrong.folder.plant(UnlocksFile, JSON.stringify({ format: 1, daemonId: DAEMON, unlocks: [{ deviceId: 'x' }] }));

    // Act / Assert
    await should(broken.ledger.read()).be.rejectedWith({
      name: 'UnlockLedgerDamaged',
      message: 'the unlock ledger does not describe unlocks',
    });
    await should(wrong.ledger.read()).be.rejectedWith({
      name: 'UnlockLedgerDamaged',
      message: 'the unlock ledger does not describe unlocks',
    });
  });
});
