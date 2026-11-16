/**
 * A machine that answers the reconnect loop's read is back (R88), whichever session carried the read: the REAL router,
 * the real sealed session and kernel layer, and the real health model wired as `buildConnect` wires it. Only the network
 * and the timers are scripted.
 */
import { describe, expect, test } from 'bun:test';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { DaemonConnectionHealth } from '../../../app/lib/connection-health.ts';
import { IntroducerRegistry } from '../../../app/lib/introducers.ts';
import type { ScriptedHost } from '../../support/browser-network.ts';
import { rig } from '../../support/router-rig.ts';

const HOST = 'laptop.example.test';
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 30));

describe('a reconnect read the machine answered', () => {
  test('R88 over an already accepted session it ends an outage another session’s failed dial started', async () => {
    // Arrange — the loop's read goes through the held client, exactly as `buildConnect` wires it.
    const introducers = new IntroducerRegistry();
    const health = new DaemonConnectionHealth(
      { now: () => 0, schedule: () => () => undefined, random: () => 0, isOnline: () => true },
      daemonId => introducers.read(daemonId),
    );
    const hosts: Record<string, ScriptedHost> = { [HOST]: { kind: 'carries', carrier: 'direct' } };
    const r = await rig(hosts, [{ kind: 'direct', url: `https://${HOST}` }], 'auto', null, undefined, { health });
    try {
      const transport = await r.connect();
      if (transport === undefined) throw new Error('the session never opened');
      let status = 0;
      // The held client sends over the ONE request session the router already committed: no new dial, no new commit.
      introducers.attach(r.fx.daemonId, {
        call: async () => {
          const answer = await transport.request({ method: 'GET', path: '/v1/carriers' });
          status = answer.status;
          return answer.body;
        },
      } as unknown as PluginClient);
      await introducers.read(r.fx.daemonId);
      expect(status).toBe(200);
      expect(health.state(r.fx.daemonId).kind).toBe('connected');

      // A second session cannot open any more, though the first is healthy: the global outage starts.
      hosts[HOST] = { kind: 'dead' };
      await new Promise<void>(resolve => {
        r.router.dial(r.daemon)({ onBinary: () => undefined, onText: () => undefined, onClose: () => resolve() });
      });
      expect(health.state(r.fx.daemonId)).toMatchObject({ kind: 'reconnecting', attempt: 0 });
      const before = r.fx.requests.length;

      // Act — back online: retry at once.
      health.retryNow(r.fx.daemonId);
      await settle();

      // Assert — the read really reached the daemon over the held session, and its answer cleared the outage.
      expect(r.fx.requests.length).toBe(before + 1);
      expect(status).toBe(200);
      expect(health.state(r.fx.daemonId)).toEqual({ kind: 'connected' });
    } finally {
      r.fx.layer.close();
    }
  });

  test('R88 a read with no client held is no answer: the machine stays reconnecting', async () => {
    const introducers = new IntroducerRegistry();
    const health = new DaemonConnectionHealth(
      { now: () => 0, schedule: () => () => undefined, random: () => 0, isOnline: () => true },
      daemonId => introducers.read(daemonId),
    );
    health.outage('daemon-a', { failures: [], daemonAbsent: true, relaysNeverOpened: false });

    health.retryNow('daemon-a');
    await settle();

    expect(health.state('daemon-a')).toMatchObject({ kind: 'reconnecting', attempt: 1 });
  });
});
