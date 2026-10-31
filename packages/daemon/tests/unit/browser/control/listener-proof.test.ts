import { describe, it } from 'bun:test';
import should from 'should';
import { listenerHeldRefusal, proveListener } from '../../../../src/lib/index.ts';

const HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';

/** One `/proc/net/tcp` row: `address` is the kernel's host-order hex, `port` a number. */
function row(address: string, port: number, uid: number, inode: number): string {
  const hexPort = port.toString(16).toUpperCase().padStart(4, '0');
  return `   0: ${address}:${hexPort} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  ${String(uid)}        0 ${String(inode)} 1 0000000000000000 100 0 0 10 0`;
}

const table = (...rows: readonly string[]): string => [HEADER, ...rows].join('\n');

const LOOPBACK_V4 = '0100007F'; // 127.0.0.1
const WILDCARD_V6 = '0'.repeat(32);
const LAN_V4 = '0500000A'; // 10.0.0.5

const OWNER = 1_001;
const STRANGER = 1_002;
const PORT = 41_234;
const CHROME_SOCKET = 7_001;

describe('proving the spawned program holds its port', () => {
  it('should prove a listener this user owns whose socket the spawned process holds', () => {
    // Arrange
    const evidence = {
      tables: [table(row(LOOPBACK_V4, PORT, OWNER, CHROME_SOCKET))],
      inodes: new Set([CHROME_SOCKET]),
    };

    // Act
    const actual = proveListener(PORT, OWNER, evidence);

    // Assert
    should(actual).deepEqual({ kind: 'proven' });
  });

  it('should name a stranger who took the port before the browser could — the freePort race', () => {
    // Arrange: the port was released for Chrome and a stranger bound it first.
    const evidence = { tables: [table(row(LOOPBACK_V4, PORT, STRANGER, 9))], inodes: new Set([CHROME_SOCKET]) };

    // Act
    const actual = proveListener(PORT, OWNER, evidence);

    // Assert
    should(actual).deepEqual({ kind: 'foreign', uid: STRANGER });
  });

  it('should refuse a stranger’s wildcard listener sharing the port, naming the stranger over the owner', () => {
    // Arrange: this user's other program shares the port too; the stranger is the one worth naming.
    const evidence = {
      tables: [
        table(row(LOOPBACK_V4, PORT, OWNER, CHROME_SOCKET), row(LOOPBACK_V4, PORT, OWNER, 8)),
        table(row(WILDCARD_V6, PORT, STRANGER, 9)),
      ],
      inodes: new Set([CHROME_SOCKET]),
    };

    // Act
    const actual = proveListener(PORT, OWNER, evidence);

    // Assert
    should(actual).deepEqual({ kind: 'foreign', uid: STRANGER });
  });

  it('should refuse this user’s own listener when the spawned process does not hold it', () => {
    // Arrange
    const evidence = { tables: [table(row(LOOPBACK_V4, PORT, OWNER, 8))], inodes: new Set([CHROME_SOCKET]) };

    // Act
    const actual = proveListener(PORT, OWNER, evidence);

    // Assert
    should(actual).deepEqual({ kind: 'foreign', uid: OWNER });
  });

  it('should not trust root: a root listener is still not this browser', () => {
    // Arrange
    const evidence = { tables: [table(row(LOOPBACK_V4, PORT, 0, CHROME_SOCKET))], inodes: new Set([CHROME_SOCKET]) };

    // Act
    const actual = proveListener(PORT, OWNER, evidence);

    // Assert
    should(actual).deepEqual({ kind: 'foreign', uid: 0 });
  });

  it('should call a port nothing reachable listens on absent, ignoring a listener loopback cannot reach', () => {
    // Arrange
    const evidence = { tables: [table(row(LAN_V4, PORT, STRANGER, 9))], inodes: new Set<number>() };

    // Act
    const actual = proveListener(PORT, OWNER, evidence);

    // Assert
    should(actual).deepEqual({ kind: 'absent' });
  });

  it('should prove nothing on a host with no tables, or for a process with no uid', () => {
    // Arrange
    const noTables = { tables: undefined, inodes: new Set([CHROME_SOCKET]) };
    const tables = { tables: [table(row(LOOPBACK_V4, PORT, OWNER, CHROME_SOCKET))], inodes: new Set([CHROME_SOCKET]) };

    // Act
    const macos = proveListener(PORT, OWNER, noTables);
    const uidless = proveListener(PORT, undefined, tables);

    // Assert
    should(macos).deepEqual({ kind: 'unknown' });
    should(uidless).deepEqual({ kind: 'unknown' });
  });

  it('should say the port, its holder and the remedy in one sentence', () => {
    // Arrange / Act
    const named = listenerHeldRefusal(20_004, STRANGER);
    const unnamed = listenerHeldRefusal(20_005);

    // Assert
    should(named).equal(
      'port 20004 is held by another program (uid 1002), not this browser — someone may be squatting it; pick another port base or free it',
    );
    should(unnamed).equal(
      'port 20005 is held by another program, not this browser — someone may be squatting it; pick another port base or free it',
    );
  });
});
