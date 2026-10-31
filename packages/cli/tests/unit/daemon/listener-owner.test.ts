import { describe, it } from 'bun:test';
import should from 'should';
import {
  daemonUrlPort,
  foreignListenerRefusal,
  listenerOwnerVerdict,
  parseTcpListeners,
} from '../../../src/lib/daemon/listener-owner.ts';

const HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';

/** One `/proc/net/tcp` row: `address` is the kernel's host-order hex, `port` a number. */
function row(address: string, port: number, uid: number, state = '0A'): string {
  const hexPort = port.toString(16).toUpperCase().padStart(4, '0');
  return `   0: ${address}:${hexPort} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  ${String(uid)}        0 1 1 0000000000000000 100 0 0 10 0`;
}

const table = (...rows: readonly string[]): string => [HEADER, ...rows].join('\n');

const LOOPBACK_V4 = '0100007F'; // 127.0.0.1
const WILDCARD_V4 = '00000000';
const LAN_V4 = '0500000A'; // 10.0.0.5
const LOOPBACK_V6 = '00000000000000000000000001000000'; // ::1
const MAPPED_LOOPBACK_V6 = '0000000000000000FFFF00000100007F'; // ::ffff:127.0.0.1

const OWNER = 1_001;
const STRANGER = 1_002;

describe('whose program holds a loopback port', () => {
  it('should read listening sockets, their port, owner and whether loopback reaches them', () => {
    // Arrange
    const text = table(
      row(LOOPBACK_V4, 7_432, OWNER),
      row(WILDCARD_V4, 22, 0),
      row(LAN_V4, 8_080, STRANGER),
      row(LOOPBACK_V4, 40_000, STRANGER, '01'), // an established connection, not a listener
    );

    // Act
    const actual = parseTcpListeners(text);

    // Assert
    should(actual).deepEqual([
      { port: 7_432, reachableFromLoopback: true, uid: OWNER },
      { port: 22, reachableFromLoopback: true, uid: 0 },
      { port: 8_080, reachableFromLoopback: false, uid: STRANGER },
    ]);
  });

  it('should judge v6 loopback, mapped v4 loopback and the v6 wildcard as reachable', () => {
    const actual = parseTcpListeners(
      table(row(LOOPBACK_V6, 1, OWNER), row(MAPPED_LOOPBACK_V6, 2, OWNER), row('0'.repeat(32), 3, OWNER)),
    );
    should(actual.map(listener => listener.reachableFromLoopback)).deepEqual([true, true, true]);
  });

  it('should skip a line that is not the table’s shape rather than guess', () => {
    should(parseTcpListeners(`${HEADER}\n   0: garbage\n\n`)).deepEqual([]);
  });

  it('should refuse a port another user is listening on — the squatted-daemon case', () => {
    // Arrange: the owner's daemon recorded 7432 and is down; a stranger bound it.
    const tables = [table(row(LOOPBACK_V4, 7_432, STRANGER))];

    // Act
    const actual = listenerOwnerVerdict(7_432, OWNER, tables);

    // Assert
    should(actual).deepEqual({ kind: 'foreign', uids: [STRANGER] });
  });

  it('should refuse when a stranger’s wildcard listener shares the port with the owner’s', () => {
    const tables = [table(row(LOOPBACK_V4, 7_432, OWNER)), table(row('0'.repeat(32), 7_432, STRANGER))];
    should(listenerOwnerVerdict(7_432, OWNER, tables)).deepEqual({ kind: 'foreign', uids: [STRANGER] });
  });

  it('should allow the owner’s own listener, and root’s, and ignore listeners loopback cannot reach', () => {
    const tables = [table(row(LOOPBACK_V4, 7_432, OWNER), row(WILDCARD_V4, 7_433, 0), row(LAN_V4, 7_432, STRANGER))];
    should(listenerOwnerVerdict(7_432, OWNER, tables)).deepEqual({ kind: 'own' });
    should(listenerOwnerVerdict(7_433, OWNER, tables)).deepEqual({ kind: 'own' });
  });

  it('should call a free port absent and a host with no tables unknown', () => {
    should(listenerOwnerVerdict(7_432, OWNER, [table()])).deepEqual({ kind: 'absent' });
    should(listenerOwnerVerdict(7_432, OWNER, undefined)).deepEqual({ kind: 'unknown' });
  });

  it('should name the port of a daemon URL, defaulting by scheme', () => {
    should(daemonUrlPort('http://127.0.0.1:7432')).equal(7_432);
    should(daemonUrlPort('http://localhost')).equal(80);
    should(daemonUrlPort('https://localhost')).equal(443);
    should(daemonUrlPort('ws://localhost')).be.undefined();
    should(daemonUrlPort('not a url')).be.undefined();
  });

  it('should say what was not sent, to whom, and what to do', () => {
    const actual = foreignListenerRefusal('http://127.0.0.1:7432', 'the daemon admin token', {
      kind: 'foreign',
      uids: [STRANGER],
    });
    should(actual).match(/refusing to send the daemon admin token to http:\/\/127\.0\.0\.1:7432/u);
    should(actual).match(/another user \(uid 1002\)/u);
    should(foreignListenerRefusal('http://127.0.0.1:7432', 'x', { kind: 'own' })).be.undefined();
  });
});
