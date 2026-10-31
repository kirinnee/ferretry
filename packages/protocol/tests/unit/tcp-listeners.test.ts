import { describe, it } from 'bun:test';
import should from 'should';
import { loopbackListenersOn, parseTcpListeners, PROC_TCP_TABLES } from '../../src/lib/index.ts';

const HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';

/** One `/proc/net/tcp` row: `address` is the kernel's host-order hex, `port` a number. */
function row(address: string, port: number, uid: number, inode = 1, state = '0A'): string {
  const hexPort = port.toString(16).toUpperCase().padStart(4, '0');
  return `   0: ${address}:${hexPort} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  ${String(uid)}        0 ${String(inode)} 1 0000000000000000 100 0 0 10 0`;
}

const table = (...rows: readonly string[]): string => [HEADER, ...rows].join('\n');

const LOOPBACK_V4 = '0100007F'; // 127.0.0.1
const WILDCARD_V4 = '00000000';
const LAN_V4 = '0500000A'; // 10.0.0.5
const LOOPBACK_V6 = '00000000000000000000000001000000'; // ::1
const MAPPED_LOOPBACK_V6 = '0000000000000000FFFF00000100007F'; // ::ffff:127.0.0.1
const MAPPED_WILDCARD_V6 = '0000000000000000FFFF000000000000'; // ::ffff:0.0.0.0
const LAN_V6 = '000080FE000000000000000001000000'; // fe80::1

const OWNER = 1_001;
const STRANGER = 1_002;

describe('the kernel’s listening sockets', () => {
  it('should read listening sockets, their port, owner, inode and whether loopback reaches them', () => {
    // Arrange
    const text = table(
      row(LOOPBACK_V4, 7_432, OWNER, 51_234),
      row(WILDCARD_V4, 22, 0, 17),
      row(LAN_V4, 8_080, STRANGER, 99),
      row(LOOPBACK_V4, 40_000, STRANGER, 5, '01'), // an established connection, not a listener
    );

    // Act
    const actual = parseTcpListeners(text);

    // Assert
    should(actual).deepEqual([
      { port: 7_432, reachableFromLoopback: true, uid: OWNER, inode: 51_234 },
      { port: 22, reachableFromLoopback: true, uid: 0, inode: 17 },
      { port: 8_080, reachableFromLoopback: false, uid: STRANGER, inode: 99 },
    ]);
  });

  it('should judge v6 loopback, mapped v4 loopback and wildcard, and the v6 wildcard as reachable', () => {
    // Arrange
    const text = table(
      row(LOOPBACK_V6, 1, OWNER),
      row(MAPPED_LOOPBACK_V6, 2, OWNER),
      row('0'.repeat(32), 3, OWNER),
      row(MAPPED_WILDCARD_V6, 4, OWNER),
      row(LAN_V6, 5, OWNER),
    );

    // Act
    const actual = parseTcpListeners(text).map(listener => listener.reachableFromLoopback);

    // Assert
    should(actual).deepEqual([true, true, true, true, false]);
  });

  it('should skip a line that is not the table’s shape rather than guess', () => {
    // Arrange
    const noInode = `   0: ${LOOPBACK_V4}:1CF0 00000000:0000 0A 00000000:00000000 00:00000000 00000000  ${String(OWNER)}`;
    const badAddress = row('XYZ', 7_432, OWNER);

    // Act
    const actual = parseTcpListeners(`${HEADER}\n   0: garbage\n${noInode}\n${badAddress}\n\n`);

    // Assert
    should(actual).deepEqual([]);
  });

  it('should list only the listeners a loopback connection to the port could reach, across tables', () => {
    // Arrange
    const tables = [
      table(row(LOOPBACK_V4, 7_432, OWNER, 10), row(LAN_V4, 7_432, STRANGER, 11), row(LOOPBACK_V4, 7_433, OWNER, 12)),
      table(row('0'.repeat(32), 7_432, STRANGER, 13)),
    ];

    // Act
    const actual = loopbackListenersOn(7_432, tables).map(listener => listener.inode);

    // Assert
    should(actual).deepEqual([10, 13]);
  });

  it('should name the two tables Linux publishes', () => {
    // Arrange / Act / Assert
    should(PROC_TCP_TABLES).deepEqual(['/proc/net/tcp', '/proc/net/tcp6']);
  });
});
