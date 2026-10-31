import { describe, it } from 'bun:test';
import type { LoopbackFirewallMarker, LoopbackFirewallState } from '@ferretry/protocol';
import should from 'should';
import {
  firewallRefusal,
  judgeLoopbackFirewall,
  LoopbackFirewallWatch,
  loopbackFirewallRemedy,
  readLoopbackFirewall,
} from '../../../../src/lib/index.ts';

const NOW = Date.parse('2026-10-31T01:10:00.000Z');
const FRESH = '2026-10-31T01:08:00.000Z';

const marker = (
  entries: LoopbackFirewallMarker['entries'],
  extra: Partial<Pick<LoopbackFirewallMarker, 'verifiedAt' | 'perUser'>> = {},
  base = 20000,
): LoopbackFirewallMarker => ({
  version: 1,
  appliedAt: '2026-10-31T01:02:03.000Z',
  base,
  entries,
  ...extra,
});
const ENTRY = [{ uid: 1001, ports: [20004, 20005, 20006] as [number, number, number] }];
const mine = marker(ENTRY, { verifiedAt: FRESH, perUser: { '1001': 'ok' } });

describe('loopback firewall state', () => {
  it('should say applied when the marker lists this uid with the ports this daemon will use and a recent check agrees', () => {
    // Act
    const state = judgeLoopbackFirewall('per-user', 1001, mine, NOW);

    // Assert
    should(state?.state).equal('applied');
    should(state?.appliedAt).equal('2026-10-31T01:02:03.000Z');
  });

  it('should derive from the marker base, so a moved base moves the ports it expects', () => {
    // Arrange
    const extra = { verifiedAt: FRESH };

    // Act + Assert
    should(
      judgeLoopbackFirewall('per-user', 1001, marker([{ uid: 1001, ports: [21004, 21005, 21006] }], extra, 21000), NOW)
        ?.state,
    ).equal('applied');
    should(judgeLoopbackFirewall('per-user', 1001, marker(ENTRY, extra, 21000), NOW)?.state).equal('stale');
  });

  it('should say stale when the marker does not list this uid or lists other ports for it', () => {
    // Act + Assert
    should(judgeLoopbackFirewall('per-user', 1001, marker([{ uid: 1002, ports: [20008, 20009, 20010] }]), NOW)).eql({
      state: 'stale',
      detail: loopbackFirewallRemedy('stale', 'user 1001'),
    });
    should(
      judgeLoopbackFirewall('per-user', 1001, marker([{ uid: 1001, ports: [20004, 20005, 20099] }]), NOW)?.state,
    ).equal('stale');
  });

  it('should say missing, with the explicit entry line, when explicit ports have no marker', () => {
    // Act
    const state = judgeLoopbackFirewall({ cdp: 30001, relay: 30002, vnc: 30003 }, 1001, undefined, NOW);

    // Assert
    should(state).eql({
      state: 'missing',
      detail: loopbackFirewallRemedy('missing', 'user 1001 30001 30002 30003'),
    });
  });

  it('should say missing when the last check did not find this uid’s rule', () => {
    // Act
    const state = judgeLoopbackFirewall(
      'per-user',
      1001,
      marker(ENTRY, { verifiedAt: FRESH, perUser: { '1001': 'missing' } }),
      NOW,
    );

    // Assert
    should(state).eql({ state: 'missing', detail: loopbackFirewallRemedy('missing', 'user 1001') });
  });

  it('should say failed when the last check let a probe into this uid’s ports, naming the remedy', () => {
    // Act
    const state = judgeLoopbackFirewall(
      'per-user',
      1001,
      marker(ENTRY, { verifiedAt: FRESH, perUser: { '1001': 'failed' } }),
      NOW,
    );

    // Assert
    should(state?.state).equal('failed');
    should(state?.detail).containEql('another user on this host could connect');
    should(state?.detail).containEql('sudo journalctl -u ferretry-loopback-firewall-verify');
  });

  it('should judge only its own uid, so another user failing does not make this one failed', () => {
    // Act + Assert
    should(
      judgeLoopbackFirewall(
        'per-user',
        1001,
        marker(ENTRY, { verifiedAt: FRESH, perUser: { '1001': 'ok', '1002': 'failed' } }),
        NOW,
      )?.state,
    ).equal('applied');
  });

  it('should say unverified when no check ever ran or the last one is older than 15 minutes', () => {
    // Act
    const never = judgeLoopbackFirewall('per-user', 1001, marker(ENTRY), NOW);
    const old = judgeLoopbackFirewall('per-user', 1001, marker(ENTRY, { verifiedAt: '2026-10-31T00:54:59.000Z' }), NOW);
    const edge = judgeLoopbackFirewall(
      'per-user',
      1001,
      marker(ENTRY, { verifiedAt: '2026-10-31T00:55:00.000Z' }),
      NOW,
    );

    // Assert
    should(never?.state).equal('unverified');
    should(never?.detail).equal(
      'the 5-minute firewall check is not running: ask the host admin to run `sudo systemctl enable --now ferretry-loopback-firewall-verify.timer`',
    );
    should(old?.state).equal('unverified');
    should(edge?.state).equal('applied');
  });

  it('should rank failed over missing over stale over unverified', () => {
    // Arrange
    const stalePorts = [{ uid: 1001, ports: [20004, 20005, 20099] as [number, number, number] }];
    const old = '2026-10-31T00:00:00.000Z';

    // Act + Assert
    should(
      judgeLoopbackFirewall(
        'per-user',
        1001,
        marker(stalePorts, { verifiedAt: old, perUser: { '1001': 'failed' } }),
        NOW,
      )?.state,
    ).equal('failed');
    should(
      judgeLoopbackFirewall(
        'per-user',
        1001,
        marker(stalePorts, { verifiedAt: old, perUser: { '1001': 'missing' } }),
        NOW,
      )?.state,
    ).equal('missing');
    should(judgeLoopbackFirewall('per-user', 1001, marker(stalePorts, { verifiedAt: old }), NOW)?.state).equal('stale');
    should(judgeLoopbackFirewall('per-user', 1001, marker(ENTRY, { verifiedAt: old }), NOW)?.state).equal('unverified');
  });

  it('should say nothing for random ports, ports that cannot be derived, or a uid the firewall refuses', () => {
    // Act + Assert
    should(judgeLoopbackFirewall('random', 1001, undefined, NOW)).equal(undefined);
    should(judgeLoopbackFirewall('per-user', 500, undefined, NOW)).equal(undefined);
    should(judgeLoopbackFirewall({ cdp: 30001, relay: 30002, vnc: 30003 }, 500, undefined, NOW)).equal(undefined);
  });

  it('should word the remedy with the exact conf line and the restart command', () => {
    // Act + Assert
    should(loopbackFirewallRemedy('missing', 'user 1001 20004 20005 20006')).equal(
      'the loopback firewall is missing: ask the host admin to add `user 1001 20004 20005 20006` to /etc/ferretry/loopback-firewall.conf and run `sudo systemctl restart ferretry-loopback-firewall`',
    );
  });

  it('should read the setting and marker at each call, and treat a failing reader as no marker', async () => {
    // Act
    const applied = await readLoopbackFirewall(
      async () => 'per-user',
      1001,
      { read: async () => mine },
      () => NOW,
    );
    const missing = await readLoopbackFirewall(
      async () => 'per-user',
      1001,
      {
        read: async () => {
          throw new Error('unreadable');
        },
      },
      () => NOW,
    );

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
    should(
      await readLoopbackFirewall(
        async () => 'random',
        1001,
        reader,
        () => NOW,
      ),
    ).equal(undefined);
    should(
      await readLoopbackFirewall(
        async () => {
          throw new Error('unreadable');
        },
        1001,
        reader,
        () => NOW,
      ),
    ).equal(undefined);
    should(read).equal(0);
  });
});

describe('firewall refusal', () => {
  const failed: LoopbackFirewallState = { state: 'failed', detail: 'the loopback firewall failed its check: ask' };

  it('should refuse a start only under the refuse policy while the own uid is failed, in one sentence with the way out', () => {
    // Act + Assert
    should(firewallRefusal(failed, 'refuse')).equal(
      'the browser was not started because the loopback firewall failed its check: ask; or set browserFirewallFailure to warn in machine.yaml',
    );
  });

  it('should let a start go ahead under warn, for any other state, and with no reading', () => {
    // Act + Assert
    should(firewallRefusal(failed, 'warn')).equal(undefined);
    for (const state of ['applied', 'missing', 'stale', 'unverified'] as const) {
      should(firewallRefusal({ state, detail: 'x' }, 'refuse')).equal(undefined);
    }
    should(firewallRefusal(undefined, 'refuse')).equal(undefined);
  });
});

describe('loopback firewall watch', () => {
  const reading = (state: LoopbackFirewallState['state'] | undefined): LoopbackFirewallState | undefined =>
    state === undefined ? undefined : { state, detail: `it is ${state}` };

  function watchOf(...states: Array<LoopbackFirewallState['state'] | undefined | 'throws'>) {
    const told: string[] = [];
    const queue = [...states];
    const watch = new LoopbackFirewallWatch(
      async () => {
        const next = queue.shift();
        if (next === 'throws') throw new Error('unreadable');
        return reading(next);
      },
      message => told.push(message),
    );
    return { watch, told };
  }

  it('should say a state once and stay quiet while it does not change', async () => {
    // Arrange
    const { watch, told } = watchOf('missing', 'missing', 'missing');

    // Act
    for (let tick = 0; tick < 3; tick += 1) await watch.check();

    // Assert
    should(told).eql(['it is missing']);
  });

  it('should say each change, and the recovery', async () => {
    // Arrange
    const { watch, told } = watchOf('applied', 'unverified', 'failed', 'applied');

    // Act
    for (let tick = 0; tick < 4; tick += 1) await watch.check();

    // Assert
    should(told).eql(['it is unverified', 'it is failed', 'it is applied']);
  });

  it('should stay silent for a first reading of applied or no reading at all', async () => {
    // Arrange
    const { watch, told } = watchOf('applied', undefined, 'throws');

    // Act
    const results = [await watch.check(), await watch.check(), await watch.check()];

    // Assert
    should(told).eql([]);
    should(results[0]?.state).equal('applied');
    should(results[1]).equal(undefined);
    should(results[2]).equal(undefined);
  });

  it('should say a state again after the setting went random in between', async () => {
    // Arrange
    const { watch, told } = watchOf('stale', undefined, 'stale');

    // Act
    for (let tick = 0; tick < 3; tick += 1) await watch.check();

    // Assert
    should(told).eql(['it is stale', 'it is stale']);
  });
});
