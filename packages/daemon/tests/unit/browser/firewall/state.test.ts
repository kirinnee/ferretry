import { describe, it } from 'bun:test';
import type { LoopbackFirewallMarker } from '@ferretry/protocol';
import should from 'should';
import { judgeLoopbackFirewall, loopbackFirewallRemedy, readLoopbackFirewall } from '../../../../src/lib/index.ts';

const marker = (entries: LoopbackFirewallMarker['entries'], base = 20000): LoopbackFirewallMarker => ({
  version: 1,
  appliedAt: '2026-10-31T01:02:03.000Z',
  base,
  entries,
});
const mine = marker([{ uid: 1001, ports: [20004, 20005, 20006] }]);

describe('loopback firewall state', () => {
  it('should say applied when the marker lists this uid with the ports this daemon will use', () => {
    // Act
    const state = judgeLoopbackFirewall('per-user', 1001, mine);

    // Assert
    should(state?.state).equal('applied');
    should(state?.appliedAt).equal('2026-10-31T01:02:03.000Z');
  });

  it('should derive from the marker base, so a moved base moves the ports it expects', () => {
    // Act + Assert
    should(
      judgeLoopbackFirewall('per-user', 1001, marker([{ uid: 1001, ports: [21004, 21005, 21006] }], 21000))?.state,
    ).equal('applied');
    should(
      judgeLoopbackFirewall('per-user', 1001, marker([{ uid: 1001, ports: [20004, 20005, 20006] }], 21000))?.state,
    ).equal('stale');
  });

  it('should say stale when the marker does not list this uid or lists other ports for it', () => {
    // Act + Assert
    should(judgeLoopbackFirewall('per-user', 1001, marker([{ uid: 1002, ports: [20008, 20009, 20010] }]))).eql({
      state: 'stale',
      detail: loopbackFirewallRemedy('stale', 'user 1001'),
    });
    should(judgeLoopbackFirewall('per-user', 1001, marker([{ uid: 1001, ports: [20004, 20005, 20099] }]))?.state).equal(
      'stale',
    );
  });

  it('should say missing, with the explicit entry line, when explicit ports have no marker', () => {
    // Act
    const state = judgeLoopbackFirewall({ cdp: 30001, relay: 30002, vnc: 30003 }, 1001, undefined);

    // Assert
    should(state).eql({
      state: 'missing',
      detail: loopbackFirewallRemedy('missing', 'user 1001 30001 30002 30003'),
    });
  });

  it('should say nothing for random ports, ports that cannot be derived, or a uid the firewall refuses', () => {
    // Act + Assert
    should(judgeLoopbackFirewall('random', 1001, undefined)).equal(undefined);
    should(judgeLoopbackFirewall('per-user', 500, undefined)).equal(undefined);
    should(judgeLoopbackFirewall({ cdp: 30001, relay: 30002, vnc: 30003 }, 500, undefined)).equal(undefined);
  });

  it('should word the remedy with the exact conf line and the restart command', () => {
    // Act + Assert
    should(loopbackFirewallRemedy('missing', 'user 1001 20004 20005 20006')).equal(
      'the loopback firewall is missing: ask the host admin to add `user 1001 20004 20005 20006` to /etc/ferretry/loopback-firewall.conf and run `sudo systemctl restart ferretry-loopback-firewall`',
    );
  });

  it('should read the setting and marker at each call, and treat a failing reader as no marker', async () => {
    // Act
    const applied = await readLoopbackFirewall(async () => 'per-user', 1001, { read: async () => mine });
    const missing = await readLoopbackFirewall(async () => 'per-user', 1001, {
      read: async () => {
        throw new Error('unreadable');
      },
    });

    // Assert
    should(applied?.state).equal('applied');
    should(missing?.state).equal('missing');
  });

  it('should read nothing when the ports are random or the setting cannot be read', async () => {
    // Arrange
    let read = 0;
    const reader = {
      read: async () => {
        read += 1;
        return mine;
      },
    };

    // Act + Assert
    should(await readLoopbackFirewall(async () => 'random', 1001, reader)).equal(undefined);
    should(
      await readLoopbackFirewall(
        async () => {
          throw new Error('unreadable');
        },
        1001,
        reader,
      ),
    ).equal(undefined);
    should(read).equal(0);
  });
});
