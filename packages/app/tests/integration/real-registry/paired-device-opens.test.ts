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
