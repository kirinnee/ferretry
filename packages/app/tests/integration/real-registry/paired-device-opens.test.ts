// This import MUST come first: it captures Bun's WebSocket and WebCrypto before anything replaces the globals.
import { NativeResponse } from '../two-release/native-socket.ts';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type StartedDaemon, startDaemon } from '../../../../../scripts/test/two-release/daemon.ts';
import type { DaemonRegistry } from '../../../../../scripts/test/two-release/releases.ts';
import { realDaemonRegistry } from '../../../../../scripts/test/two-release/real-release.ts';
import { standings, wholeDaemonBlocked } from '../../../src/client/inventory.ts';
import { CORE_IDS } from '@ferretry/kernel/contract';
import type { SurfaceEntry } from '../../../src/surfaces/registry.ts';
import { type AppSession, openApp } from '../two-release/session.ts';

/**
 * A PAIRED DEVICE ON A SAME-COMMIT DAEMON OPENS THE FLEET, not the reload block (merge bar 14).
 *
 * The two-release fixture proves the guard on a toy workspace of a dozen packages. This file proves the guarantee on the
 * REAL tree: the daemon is booted over the real generated registry (`packages/core/kernel/src/generated/plugins.ts`: all
 * 31 packages and the contract hashes `fyd` itself reads), the app is the real compiled registry
 * (`packages/app/src/generated/surfaces.ts`), the device is paired over the real direct carrier with the owner's code,
 * and the app's own `standings()` / `wholeDaemonBlocked()` read the inventory the daemon answered that device.
 * A dress rehearsal showed every screen on "Reload to get the new app." for an app and a daemon of one commit; whatever
 * the cause, this is the line that must never be crossed on a tree where the two agree.
 */

let daemonRegistry: DaemonRegistry;
let surfaces: readonly SurfaceEntry[];
let appVersion: string;
const originalResponse = globalThis.Response;

beforeAll(async () => {
  // The daemon in this process answers through the global `Response`, and `Bun.serve` accepts only Bun's own.
  globalThis.Response = NativeResponse;
  daemonRegistry = await realDaemonRegistry();
  const generated = (await import('../../../src/generated/surfaces.ts')) as unknown as {
    generated: { appVersion: string; surfaces: readonly SurfaceEntry[] };
  };
  surfaces = generated.generated.surfaces;
  appVersion = generated.generated.appVersion;
});

afterAll(() => {
  globalThis.Response = originalResponse;
});

describe('the real registries agree before anything is booted', () => {
  test('every package the app compiled is on the daemon registry with the same effective contract hash', () => {
    for (const entry of surfaces)
      expect({ id: entry.id, daemon: daemonRegistry.contractHashes[entry.id]?.effective }).toEqual({
        id: entry.id,
        daemon: entry.contract,
      });
  });

  test('the five core pieces are compiled into the app', () => {
    const compiled = surfaces.map(entry => entry.id);
    for (const id of CORE_IDS) expect(compiled).toContain(id);
  });
});

describe.each([['full'], ['limited']] as const)('a %s device on a daemon of this commit', grants => {
  let daemon: StartedDaemon;
  let session: AppSession;

  beforeAll(async () => {
    daemon = await startDaemon({ name: 'A', daemon: daemonRegistry } as never, { version: appVersion });
    session = await openApp(daemon, { surfaces, appVersion }, { grants });
    await session.ready();
  }, 60_000);

  afterAll(async () => {
    session?.close();
    await daemon?.stop();
  });

  const inventory = () => {
    const connection = session.runtime.connection(session.daemonId);
    if (connection.kind !== 'connected') throw new Error(`the app is ${connection.kind}, not connected`);
    return connection.client.inventory;
  };

  test('the daemon answered the device a plugin list the app can read', () => {
    expect(inventory()?.kind).toBe('read');
  });

  test('the whole daemon is not blocked, and the shell shows no full-screen line or reason', () => {
    expect(wholeDaemonBlocked(inventory(), surfaces)).toBe(false);
    expect(session.runtime.wholeDaemonLine(session.daemonId)).toBeUndefined();
    expect(session.runtime.wholeDaemonDetail(session.daemonId)).toBeUndefined();
  });

  test('every core piece is allowed', () => {
    const all = standings(inventory(), surfaces);
    for (const id of CORE_IDS) expect(all.get(id)).toEqual({ state: 'allowed' });
  });

  test('the fleet package is allowed, the surface the device came to open', () => {
    expect(standings(inventory(), surfaces).get('runtimes')).toEqual({ state: 'allowed' });
  });
});

describe('narrowing still narrows', () => {
  test('a full device sees every package; a limited one loses what its grants do not reach, never a core piece', async () => {
    const daemon = await startDaemon({ name: 'A', daemon: daemonRegistry } as never, { version: appVersion });
    const full = await openApp(daemon, { surfaces, appVersion }, { grants: 'full' });
    const limited = await openApp(daemon, { surfaces, appVersion }, { grants: 'limited' });
    try {
      await Promise.all([full.ready(), limited.ready()]);
      const read = (session: AppSession) => {
        const connection = session.runtime.connection(session.daemonId);
        if (connection.kind !== 'connected') throw new Error(`the app is ${connection.kind}`);
        return standings(connection.client.inventory, surfaces);
      };
      const fullStandings = read(full);
      const limitedStandings = read(limited);
      for (const entry of surfaces) expect(fullStandings.get(entry.id)).toEqual({ state: 'allowed' });
      for (const id of CORE_IDS) expect(limitedStandings.get(id)).toEqual({ state: 'allowed' });
      const hidden = surfaces.filter(entry => limitedStandings.get(entry.id)?.state === 'blocked');
      expect(hidden.length).toBeGreaterThan(0);
      for (const entry of hidden)
        expect(limitedStandings.get(entry.id)).toEqual({ state: 'blocked', reason: 'missing' });
    } finally {
      full.close();
      limited.close();
      await daemon.stop();
    }
  }, 60_000);
});

/**
 * THE PRODUCTION CARRIER, NOT `carriers: []` (merge bar 14; ruling 2026-11-13).
 *
 * The cases above open the fleet over the shell's own direct dial. The shipped app registers Connections instead, and
 * its router, with NO saved preference, used to walk "Relay only": a device that paired directly was never tried
 * directly, so a daemon with no relay (or one that does not answer) was a permanent "could not read" block. These cases
 * run the REGISTERED router (`registeredConnect` over the real generated registry) with its real default:
 *   - the default (nobody chose) falls back to the address this device paired over, says so, and flips back when the
 *     relay answers;
 *   - a "Relay only" the person CHOSE stays strict, stays blocked, names the relay as the cause, and the Connection
 *     setting is reachable from the block;
 *   - a device that paired over a relay has no direct address it paired over, so it gets no fallback.
 */
const FALLBACK_LINE = 'Couldn’t reach it through the relay, using the direct connection.';

describe('the registered production carrier router, with its real default', () => {
  const withDevice = async (
    production: Parameters<typeof openApp>[2]['production'],
    run: (session: AppSession) => Promise<void>,
  ): Promise<void> => {
    const daemon = await startDaemon({ name: 'A', daemon: daemonRegistry } as never, { version: appVersion });
    const session = await openApp(daemon, { surfaces, appVersion }, { grants: 'full', production });
    try {
      await run(session);
    } finally {
      session.close();
      await daemon.stop();
    }
  };
  const inventoryKind = (session: AppSession) => {
    const connection = session.runtime.connection(session.daemonId);
    if (connection.kind !== 'connected') throw new Error(`the app is ${connection.kind}, not connected`);
    return connection.client.inventory?.kind;
  };
  const isRelayDial = (url: string): boolean => new URL(url).port === '9';

  test('1. default + direct pairing + no relay discovered: the fleet opens over direct and says the relay was not used', async () => {
    await withDevice({}, async session => {
      await session.ready();
      expect(inventoryKind(session)).toBe('read');
      expect(session.runtime.wholeDaemonLine(session.daemonId)).toBeUndefined();
      expect(session.runtime.wholeDaemonDetail(session.daemonId)).toBeUndefined();
      expect(session.relayFallbackLine()).toBe(FALLBACK_LINE);
      expect(session.dialled.some(isRelayDial)).toBe(false);
    });
  }, 60_000);

  test('2. default + a relay discovered but unreachable: the relay is dialled FIRST, then the paired direct address carries', async () => {
    await withDevice({ relay: { up: false } }, async session => {
      await session.ready();
      expect(inventoryKind(session)).toBe('read');
      expect(session.runtime.wholeDaemonLine(session.daemonId)).toBeUndefined();
      expect(session.relayFallbackLine()).toBe(FALLBACK_LINE);
      const first = session.dialled[0];
      expect(first !== undefined && isRelayDial(first)).toBe(true);
      expect(session.dialled.some(url => !isRelayDial(url))).toBe(true);
    });
  }, 60_000);

  test('3. a Relay only the person CHOSE stays strict: blocked, the relay named as the cause, the Connection setting reachable', async () => {
    await withDevice({ relay: { up: false }, chosenRelayOnly: true }, async session => {
      await session.ready();
      expect(inventoryKind(session)).toBe('unreadable');
      expect(session.runtime.wholeDaemonLine(session.daemonId)).toContain('Could not read');
      const why = session.runtime.wholeDaemonDetail(session.daemonId) ?? '';
      // The carrier's own cause, alone (no "the plugin list could not be read:" stacked in front of it).
      expect(why.toLowerCase()).toContain('relay');
      expect(why).not.toContain('could not be read');
      // Strict: the daemon's own address is never dialled, so no line says it was used.
      expect(session.dialled.every(isRelayDial)).toBe(true);
      expect(session.relayFallbackLine()).toBeUndefined();
      // The Connection setting is a device-level panel, so the block can link to it with no machine behind it.
      expect(session.deviceSettingsPanels()).toContain('connections.connection');
    });
  }, 60_000);

  test('4. the relay comes back: once nothing sends direct any more, the next session flips back to the relay and the line goes away', async () => {
    await withDevice({ relay: { up: false } }, async session => {
      await session.ready();
      expect(session.relayFallbackLine()).toBe(FALLBACK_LINE);
      session.setRelayUp(true);
      // The app's own sessions were the ones standing in for the relay; with them gone the relay carries the next.
      session.endAppSessions();
      await session.probe();
      expect(session.relayFallbackLine()).toBeUndefined();
    });
  }, 60_000);

  test('6. one lane on the relay does not hide the fallback while another lane of the same app still sends direct', async () => {
    await withDevice({ relay: { up: false } }, async session => {
      await session.ready();
      expect(session.relayFallbackLine()).toBe(FALLBACK_LINE);
      session.setRelayUp(true);
      const before = session.dialled.length;
      // A body too large for the ordinary lane opens the separate bulk lane, which the relay now carries.
      await session.recording().request({ method: 'POST', path: '/v1/health', body: 'x'.repeat(40_000) });
      expect(session.dialled.slice(before).some(isRelayDial)).toBe(true);
      // The original lane has not moved: it is still direct, so the notice stays and the app never claims the relay.
      await session.recording().request({ method: 'GET', path: '/v1/health' });
      expect(session.relayFallbackLine()).toBe(FALLBACK_LINE);
    });
  }, 60_000);

  test('5. a pairing without the "paired over direct" mark (every older record, a relayed pairing) has no fallback: blocked with the relay as the cause', async () => {
    await withDevice({ unmarkedPairing: true }, async session => {
      await session.ready();
      expect(inventoryKind(session)).toBe('unreadable');
      expect(session.runtime.wholeDaemonLine(session.daemonId)).toContain('Could not read');
      expect((session.runtime.wholeDaemonDetail(session.daemonId) ?? '').toLowerCase()).toContain('relay');
      expect(session.dialled).toEqual([]);
      expect(session.relayFallbackLine()).toBeUndefined();
    });
  }, 60_000);
});
