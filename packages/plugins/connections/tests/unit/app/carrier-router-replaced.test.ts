/**
 * V-B21 / C-80: a machine reinstalled or replaced AT THE SAME ADDRESS is not an outage to retry forever.
 *
 * The REAL router, the real sealed session and kernel layer, and the real health model wired as `buildConnect` wires
 * it; only the network and the timers are scripted. The proof is narrow on purpose: a DIRECT or TUNNEL leg that OPENED and
 * was answered `4404` ("this daemon does not answer for that fingerprint"). Every other failure keeps today's backoff, so
 * an asleep or restarting machine never reaches "Pair again".
 */
import { describe, expect, test } from 'bun:test';
import { DAEMON_REPLACED_CLOSE_CODE, RELAY_CLOSE_CODES } from '@ferretry/app';
import { DaemonClient } from '@ferretry/app/testing';
import { DaemonConnectionHealth } from '../../../app/lib/connection-health.ts';
import type { ScriptedHost } from '../../support/browser-network.ts';
import { rig } from '../../support/router-rig.ts';

const DIRECT = 'https://laptop.example.test';
const RELAY = 'wss://relay.example';
const DIRECT_HOST = new URL(DIRECT).host;
const RELAY_HOST = new URL(RELAY).host;
const NOT_THIS_DAEMON = 'this daemon does not answer for that fingerprint';
const DIRECT_AND_RELAY = [
  { kind: 'direct', url: DIRECT },
  { kind: 'relay', url: RELAY },
] as const;

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 30));

/** The loop's schedule, held by hand: a timer is a retry the loop would make. */
const scheduler = () => {
  const timers: { readonly run: () => void; cancelled: boolean; fired: boolean }[] = [];
  return {
    timers,
    schedule: (run: () => void) => {
      const timer = { run, cancelled: false, fired: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
    pending: () => timers.filter(timer => !timer.cancelled && !timer.fired),
  };
};

/** One machine, a router and the real health loop whose every attempt dials a fresh session through that router. */
const world = async (hosts: Record<string, ScriptedHost>, carriers: readonly unknown[]) => {
  const held = scheduler();
  let dial: (() => Promise<{ code: number | undefined; reason: string | undefined }>) | undefined;
  const health = new DaemonConnectionHealth(
    { now: () => 0, schedule: held.schedule, random: () => 0, isOnline: () => true },
    async () => {
      await dial?.();
      return false;
    },
  );
  const r = await rig(hosts, carriers, 'auto', null, undefined, { health, chosen: () => false });
  dial = () =>
    new Promise(resolve => {
      r.router.dial(r.daemon)({
        onBinary: () => undefined,
        onText: () => undefined,
        onClose: (code, reason) => resolve({ code, reason }),
      });
    });
  const walk = () => (dial ?? (() => Promise.reject(new Error('not ready'))))();
  /** Fires every retry the loop has scheduled, as many rounds as it keeps asking for (bounded: an endless loop stays endless). */
  const drain = async (rounds: number): Promise<void> => {
    for (let round = 0; round < rounds; round += 1) {
      const due = held.pending();
      if (due.length === 0) return;
      for (const timer of due) {
        timer.fired = true;
        timer.run();
      }
      await settle();
    }
  };
  return { r, health, held, walk, drain };
};

describe('C-80 a replaced daemon identity at the paired address', () => {
  for (const closeOnly of [true, false])
    test(`a relay ${closeOnly ? 'close' : 'control message'} carrying 4405 keeps the backoff, never replaced`, async () => {
      const w = await world({ [RELAY_HOST]: { kind: 'absent', code: 4405, closeOnly } }, [
        { kind: 'relay', url: RELAY },
      ]);
      const transport = await w.r.connect();
      try {
        if (transport === undefined) throw new Error('no transport');
        const refused: string[] = [];
        const client = new DaemonClient({ transport, surfaces: [] });
        client.onRefused(reason => refused.push(reason));
        await client.start();
        expect(refused).toEqual([]);
        expect(w.health.state(w.r.fx.daemonId).kind).toBe('reconnecting');
        expect(w.held.pending().length).toBeGreaterThan(0);
      } finally {
        transport?.close?.();
        w.r.fx.layer.close();
      }
    });

  test('one failure, no loop: the walk ends 4405, the loop stops, and the old identity is dialled once', async () => {
    const w = await world(
      {
        [DIRECT_HOST]: { kind: 'absent', code: RELAY_CLOSE_CODES.daemonAbsent, reason: NOT_THIS_DAEMON },
        [RELAY_HOST]: { kind: 'absent', code: RELAY_CLOSE_CODES.daemonAbsent },
      },
      DIRECT_AND_RELAY,
    );
    try {
      const ended = await w.walk();
      await settle();
      const dialledAfterOne = w.r.network.dialled.length;

      // The shell reads this close as "pair again", not as a carrier outage.
      expect(ended.code).toBe(DAEMON_REPLACED_CLOSE_CODE);
      // The loop was not started: nothing is scheduled, and nothing says "reconnecting".
      expect(w.health.state(w.r.fx.daemonId).kind).not.toBe('reconnecting');
      expect(w.held.pending()).toEqual([]);
      await w.drain(5);
      expect(w.r.network.dialled.length).toBe(dialledAfterOne);
    } finally {
      w.r.fx.layer.close();
    }
  });

  test('a TUNNEL leg that opened and was answered 4404 is the same proof', async () => {
    const TUNNEL = 'https://abc.tunnel.example';
    const w = await world(
      { [new URL(TUNNEL).host]: { kind: 'absent', code: RELAY_CLOSE_CODES.daemonAbsent, reason: NOT_THIS_DAEMON } },
      [{ kind: 'tunnel', url: TUNNEL }],
    );
    try {
      const ended = await w.walk();
      expect(ended.code).toBe(DAEMON_REPLACED_CLOSE_CODE);
      expect(w.held.pending()).toEqual([]);
    } finally {
      w.r.fx.layer.close();
    }
  });

  test('the opened direct 4404 proof reaches the client as an internal replacement verdict', async () => {
    const w = await world({ [DIRECT_HOST]: { kind: 'absent', code: 4404 } }, [{ kind: 'direct', url: DIRECT }]);
    const transport = await w.r.connect();
    try {
      if (transport === undefined) throw new Error('no transport');
      const refused: string[] = [];
      const client = new DaemonClient({ transport, surfaces: [] });
      client.onRefused(reason => refused.push(reason));
      await client.start();
      expect(refused).toEqual(['replaced']);
      expect(w.held.pending()).toEqual([]);
    } finally {
      transport?.close?.();
      w.r.fx.layer.close();
    }
  });

  test('a relay-only pairing cannot tell replaced from asleep: its 4404 keeps the backoff', async () => {
    const w = await world({ [RELAY_HOST]: { kind: 'absent', code: RELAY_CLOSE_CODES.daemonAbsent } }, [
      { kind: 'relay', url: RELAY },
    ]);
    try {
      const ended = await w.walk();
      expect(ended.code).toBe(RELAY_CLOSE_CODES.daemonAbsent);
      expect(w.health.state(w.r.fx.daemonId).kind).toBe('reconnecting');
      expect(w.held.pending().length).toBeGreaterThan(0);
    } finally {
      w.r.fx.layer.close();
    }
  });

  test('a direct address that never opened (asleep, refused, off the network) keeps the backoff', async () => {
    const w = await world(
      {
        [DIRECT_HOST]: { kind: 'dead' },
        [RELAY_HOST]: { kind: 'absent', code: RELAY_CLOSE_CODES.daemonAbsent },
      },
      DIRECT_AND_RELAY,
    );
    try {
      const ended = await w.walk();
      expect(ended.code).not.toBe(DAEMON_REPLACED_CLOSE_CODE);
      expect(w.health.state(w.r.fx.daemonId).kind).toBe('reconnecting');
      expect(w.held.pending().length).toBeGreaterThan(0);
    } finally {
      w.r.fx.layer.close();
    }
  });

  test('a direct address that opened and closed with another code keeps the backoff', async () => {
    const w = await world(
      {
        [DIRECT_HOST]: { kind: 'absent', code: RELAY_CLOSE_CODES.rendezvousBusy },
        [RELAY_HOST]: { kind: 'absent', code: RELAY_CLOSE_CODES.daemonAbsent },
      },
      DIRECT_AND_RELAY,
    );
    try {
      const ended = await w.walk();
      expect(ended.code).not.toBe(DAEMON_REPLACED_CLOSE_CODE);
      expect(w.health.state(w.r.fx.daemonId).kind).toBe('reconnecting');
    } finally {
      w.r.fx.layer.close();
    }
  });
});
