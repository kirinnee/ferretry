/** A carrier close cannot outrun the handshake's authentication boundary in the next leg's verdict. */
import { describe, expect, test } from 'bun:test';
import { WebCryptoRelayCrypto } from '@ferretry/app';
import { connector, fakeDeviceClaims } from '@ferretry/app/testing';
import { session } from '@ferretry/kernel/host';
import type { BrowserSocket } from '../../../app/adapters/browser-relay-dial.ts';
import { DaemonConnectionHealth } from '../../../app/lib/connection-health.ts';
import { rig } from '../../support/router-rig.ts';

class HeldVerification extends WebCryptoRelayCrypto {
  readonly entered = Promise.withResolvers<void>();
  readonly release = Promise.withResolvers<void>();
  readonly results: boolean[] = [];

  override async verifyEd25519(...args: Parameters<WebCryptoRelayCrypto['verifyEd25519']>): Promise<boolean> {
    this.entered.resolve();
    await this.release.promise;
    const verified = await super.verifyEd25519(...args);
    this.results.push(verified);
    return verified;
  }
}

/** Corrupt only the wire signature; fingerprint checks and Ed25519 verification remain real. */
function corruptHello(socket: BrowserSocket): BrowserSocket {
  const intercepted: BrowserSocket = { ...socket };
  socket.onopen = () => intercepted.onopen?.();
  socket.onclose = event => intercepted.onclose?.(event);
  socket.onerror = () => intercepted.onerror?.();
  socket.onmessage = event => {
    if (event.data instanceof ArrayBuffer) {
      const decoded = session.decodeFrame(new Uint8Array(event.data));
      if (decoded.ok && decoded.frame.kind === session.FRAME_KINDS.handshake) {
        const hello = session.decodeDaemonHello(decoded.frame.payload);
        if (hello === null) throw new Error('expected a real daemon hello');
        const signature = Buffer.from(hello.sig, 'base64url');
        signature[0] = (signature[0] ?? 0) ^ 1;
        const payload = session.encodeHandshakeMessage({ ...hello, sig: signature.toString('base64url') });
        intercepted.onmessage?.({ data: session.encodeFrame({ ...decoded.frame, payload }).buffer });
        return;
      }
    }
    intercepted.onmessage?.(event);
  };
  return intercepted;
}

const settle = () => new Promise<void>(resolve => setTimeout(resolve, 30));

describe('R4-1 close during handshake verification', () => {
  for (const carrier of ['direct', 'tunnel'] as const) {
    for (const mode of ['request', 'stream'] as const) {
      for (const [code, rejected] of mode === 'stream'
        ? ([
            [4404, false],
            [4429, false],
            [4404, true],
          ] as const)
        : ([
            [4404, false],
            [4404, true],
          ] as const)) {
        test(`${carrier} ${code} while verifying a ${mode}${rejected ? ' with a corrupted signature' : ''} is connection loss, then retry`, async () => {
          const crypto = new HeldVerification();
          const scheduled: (() => void)[] = [];
          const health = new DaemonConnectionHealth(
            {
              now: () => 0,
              schedule: run => {
                scheduled.push(run);
                return () => undefined;
              },
              random: () => 0,
              isOnline: () => true,
            },
            async () => false,
          );
          let socket: BrowserSocket | undefined;
          let attack = rejected;
          const r = await rig(
            {
              'laptop.example.test': { kind: 'carries', carrier },
              'relay.example.test': { kind: 'dead' },
            },
            [
              { kind: carrier, url: 'https://laptop.example.test' },
              { kind: 'relay', url: 'wss://relay.example.test' },
            ],
            'auto',
            null,
            network => url => {
              const raw = network.openSocket(url);
              const opened = attack && new URL(url).host === 'laptop.example.test' ? corruptHello(raw) : raw;
              if (new URL(url).host === 'laptop.example.test') socket = opened;
              return opened;
            },
            { health, chosen: () => false },
          );
          r.fx.acceptStreams();
          const device = await r.fx.paired('race');
          const transport = await connector({
            crypto,
            claims: fakeDeviceClaims({
              claims: {
                [r.fx.daemonId]: {
                  deviceId: device.deviceId,
                  appSession: device.appSession,
                  key: crypto.deviceKeyHandle(device.privateKey),
                },
              },
            }),
            carriers: [r.router.dialer()],
            direct: () => {
              throw new Error('Connections owns this walk');
            },
          })(r.daemon);
          if (transport === undefined) throw new Error('no transport');
          try {
            const ended =
              mode === 'request'
                ? transport.request({ method: 'GET', path: '/waiting' }).catch((error: unknown) => error)
                : new Promise(resolve => {
                    transport.socket('/waiting', {
                      onFrame: () => undefined,
                      onClose: (reason, code) => resolve({ code, message: reason }),
                    });
                  });
            await crypto.entered.promise;
            socket?.close(code, 'forged replacement or ceiling');
            await settle();
            // The close has landed, but no next leg may consume it while authentication is still pending.
            expect(r.network.dialled).toHaveLength(1);
            crypto.release.resolve();
            expect(await ended).toMatchObject({ code: 1006 });
            expect(crypto.results[0]).toBe(!rejected);
            expect(r.network.dialled.map(url => new URL(url).host)).toEqual([
              'laptop.example.test',
              'relay.example.test',
            ]);
            expect(health.state(r.fx.daemonId).kind).toBe('reconnecting');
            expect(scheduled.length).toBeGreaterThan(0);
            expect(r.network.records('laptop.example.test')).toHaveLength(0);
            // Nothing was sent; a fresh attempt can still reach the genuine daemon without re-pairing.
            attack = false;
            expect((await transport.request({ method: 'GET', path: '/retry' })).status).toBe(200);
          } finally {
            crypto.release.resolve();
            transport.close?.();
            await r.fx.layer.close();
          }
        });
      }
    }
  }
});
