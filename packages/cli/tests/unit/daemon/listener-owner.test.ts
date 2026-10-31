import { describe, it } from 'bun:test';
import should from 'should';
import { z } from 'zod';
import { SessionCredentialGateway } from '../../../src/adapters/agent-tools/session-credential-gateway.ts';
import {
  assertOwnLoopbackListener,
  type LoopbackListenerGuardPorts,
  procTcpTables,
} from '../../../src/adapters/daemon/loopback-listener-guard.ts';
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

function ports(tables: readonly string[] | undefined, uid: number | undefined = OWNER): LoopbackListenerGuardPorts {
  return { tables: async () => tables, uid: () => uid };
}

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

  it('should read whichever of the two tables the host has, and nothing when it has neither', async () => {
    const both = await procTcpTables(async path => (path.endsWith('6') ? 'v6' : 'v4'));
    const one = await procTcpTables(async path => {
      if (path.endsWith('6')) throw new Error('ENOENT');
      return 'v4';
    });
    const none = await procTcpTables(async () => {
      throw new Error('ENOENT');
    });
    should(both).deepEqual(['v4', 'v6']);
    should(one).deepEqual(['v4']);
    should(none).be.undefined();
  });
});

describe('sending a credential to a loopback daemon', () => {
  it('should throw rather than let a credential go to another user’s listener', async () => {
    await should(
      assertOwnLoopbackListener(
        'http://127.0.0.1:7432',
        'the daemon admin token',
        ports([table(row(LOOPBACK_V4, 7_432, STRANGER))]),
      ),
    ).be.rejectedWith(/held by another user \(uid 1002\)/u);
  });

  it('should let it go to the owner’s own daemon, or to nobody', async () => {
    await assertOwnLoopbackListener('http://127.0.0.1:7432', 'x', ports([table(row(LOOPBACK_V4, 7_432, OWNER))]));
    await assertOwnLoopbackListener('http://127.0.0.1:7432', 'x', ports([table()]));
  });

  it('should send as before on macOS, which has no /proc/net to read (a declared GAP, not a refusal)', async () => {
    // Arrange — exactly what a Mac answers: neither table exists.
    const mac: LoopbackListenerGuardPorts = {
      tables: () =>
        procTcpTables(async () => {
          throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
        }),
      uid: () => OWNER,
    };
    const sent: string[] = [];
    const gateway = new SessionCredentialGateway(
      async () => 'http://127.0.0.1:7432',
      async url => {
        sent.push(url);
        return Response.json({ summary: 'ok' });
      },
      undefined,
      mac,
    );

    // Act
    await assertOwnLoopbackListener('http://127.0.0.1:7432', 'the daemon admin token', mac);
    const answer = await gateway.request('/v1/agent/tools', z.object({ summary: z.string() }));

    // Assert
    should(answer).deepEqual({ summary: 'ok' });
    should(sent).deepEqual(['http://127.0.0.1:7432/v1/agent/tools']);
  });

  it('should not judge a platform with no uids at all', async () => {
    const squatted = [table(row(LOOPBACK_V4, 7_432, STRANGER))];
    await assertOwnLoopbackListener('http://127.0.0.1:7432', 'x', {
      tables: async () => squatted,
      uid: () => undefined,
    });
  });

  it('should never send an agent’s session credential to a squatted port', async () => {
    // Arrange
    const sent: string[] = [];
    const gateway = new SessionCredentialGateway(
      async () => 'http://127.0.0.1:7432',
      async url => {
        sent.push(url);
        return Response.json({ summary: 'ok' });
      },
      undefined,
      ports([table(row(LOOPBACK_V4, 7_432, STRANGER))]),
    );

    // Act
    const attempt = gateway.request('/v1/agent/tools', z.object({ summary: z.string() }), {
      method: 'POST',
      body: '{}',
      headers: { 'x-fy-session-capability': 'cap-1' },
    });

    // Assert
    await should(attempt).be.rejectedWith(/refusing to send the session credential/u);
    should(sent).deepEqual([]);
  });
});
