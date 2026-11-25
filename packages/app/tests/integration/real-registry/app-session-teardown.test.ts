// This import MUST come first: it captures Bun's WebSocket and WebCrypto before anything replaces the globals.
import { nativeSetTimeout } from '../two-release/native-socket.ts';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type StartedDaemon, startDaemon } from '../../../../../scripts/test/two-release/daemon.ts';
import type { DaemonRegistry } from '../../../../../scripts/test/two-release/releases.ts';
import { realDaemonRegistry } from '../../../../../scripts/test/two-release/real-release.ts';
import type { SurfaceEntry } from '../../../src/surfaces/registry.ts';
import { type AppSession, openApp, turnUnlockOffAtTheMachine } from '../two-release/session.ts';

/**
 * THE TEST FIXTURE'S OWN TEARDOWN, WITNESSED (`two-release/session.ts`): a session the app reopens AFTER `endAppSessions`
 * (a read through the same transport) is still one the final `close` must end, or the daemon's stop waits on a live socket for
 * ever. The real daemon, the real direct carrier, a loopback port in this unit's range (7480-7499).
 */

const PORTS = { from: 7480, to: 7499 } as const;
/** This file's own port in the range, derived from the process id so two runs on one box rarely meet. */
const PORT = PORTS.from + (process.pid % (PORTS.to - PORTS.from + 1));

let daemonRegistry: DaemonRegistry;
let surfaces: readonly SurfaceEntry[];
let appVersion: string;
let daemon: StartedDaemon | undefined;

beforeAll(async () => {
  daemonRegistry = await realDaemonRegistry();
  const generated = (await import('../../../src/generated/surfaces.ts')) as unknown as {
    generated: { appVersion: string; surfaces: readonly SurfaceEntry[] };
  };
  surfaces = generated.generated.surfaces;
  appVersion = generated.generated.appVersion;
  daemon = await startDaemon({ name: 'A', daemon: daemonRegistry } as never, { version: appVersion, port: PORT });
  await turnUnlockOffAtTheMachine(daemon);
}, 90_000);

afterAll(async () => {
  await daemon?.stop();
});

describe('the app session fixture', () => {
  test('endAppSessions, then a read through the same transport, then close: no socket is left open', async () => {
    if (daemon === undefined) throw new Error('the daemon did not start');
    const session: AppSession = await openApp(daemon, { surfaces, appVersion }, { grants: 'full' });
    try {
      await session.ready();
      expect(session.openSockets()).toBeGreaterThan(0);
      session.endAppSessions();
      // The transport the app holds reopens its session for the next read: a live socket again.
      await session.recording().request({ method: 'GET', path: '/v1/health' });
      expect(session.openSockets()).toBeGreaterThan(0);
    } finally {
      session.close();
    }
    // The close frames cross the loopback socket: give them the time a real teardown takes.
    await new Promise<void>(resolve => nativeSetTimeout(resolve, 1_200));
    expect(session.openSockets()).toBe(0);
  }, 60_000);
});
