import { describe, it } from 'bun:test';
import should from 'should';
import { z } from 'zod';
import { SessionCredentialGateway } from '../../../src/adapters/agent-tools/session-credential-gateway.ts';
import {
  assertOwnLoopbackListener,
  type LoopbackListenerGuardPorts,
  procTcpTables,
} from '../../../src/adapters/daemon/loopback-listener-guard.ts';

const HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';

/** One `/proc/net/tcp` row: `address` is the kernel's host-order hex, `port` a number. */
function row(address: string, port: number, uid: number, state = '0A'): string {
  const hexPort = port.toString(16).toUpperCase().padStart(4, '0');
  return `   0: ${address}:${hexPort} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000  ${String(uid)}        0 1 1 0000000000000000 100 0 0 10 0`;
}

const table = (...rows: readonly string[]): string => [HEADER, ...rows].join('\n');

const LOOPBACK_V4 = '0100007F'; // 127.0.0.1

const OWNER = 1_001;
const STRANGER = 1_002;

function ports(tables: readonly string[] | undefined, uid: number | undefined = OWNER): LoopbackListenerGuardPorts {
  return { tables: async () => tables, uid: () => uid };
}

describe('the kernel’s socket tables', () => {
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

  it('should read this host’s own tables, and let a credential go to a port nobody holds', async () => {
    // The system ports, unstubbed: on Linux both tables exist, elsewhere neither does — either way the read
    // answers, and a port no listener can hold (0) is never refused.
    const tables = await procTcpTables();
    should(tables === undefined || tables.length > 0).be.true();
    await assertOwnLoopbackListener('http://127.0.0.1:0', 'nothing');
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
