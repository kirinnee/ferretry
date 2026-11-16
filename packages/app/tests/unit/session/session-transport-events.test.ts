import { describe, expect, test } from 'bun:test';
import { BUS_PATH, SessionTransport } from '../../../src/session/session-transport.ts';
import { newDaemonIdentity, relayCrypto, testDevice } from '../../../src/testing/relay.ts';
import { rotatingDial } from '../../../src/testing/rotating-daemon.ts';

/**
 * The app's plugin events come from the kernel's bus socket (`GET /v1/bus`), never from Ferrets' journal stream
 * (`/v1/events`), which carries no plugin event (no guarantees row).
 */
describe('the session transport event feed', () => {
  test('(no guarantees row) events() opens the kernel bus socket, not the ferret journal stream', async () => {
    const identity = await newDaemonIdentity();
    const device = await testDevice('fy_dev_events');
    const route = rotatingDial(identity, {
      accepts: () => [device.publicKey],
      rotateBy: () => undefined,
      respond: async () => ({ status: 200, body: {} }),
    });
    const transport = new SessionTransport({
      crypto: relayCrypto,
      daemonId: identity.daemonId,
      device: device.claim,
      dial: route.dial,
    });
    const opened: string[] = [];
    transport.socket = path => {
      opened.push(path);
      return { close: () => undefined } as ReturnType<SessionTransport['socket']>;
    };

    const stop = transport.events(
      () => undefined,
      () => undefined,
    );
    stop();

    expect(BUS_PATH).toBe('/v1/bus');
    expect(opened).toEqual(['/v1/bus']);
  });
});
