/**
 * Whether this daemon dials at all, and with which key.
 *
 * Both decisions fail closed, and both explain themselves: a daemon with no relay and a daemon whose
 * relay is broken look identical from the outside, so the reason is part of the answer.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import type { FileInformation, FileSystemPort } from '../../../src/lib/ports.ts';
import { decideRelayCarrier, relaySocketIsStale } from '../../../src/lib/relay/carrier.ts';
import { DAEMON_IDENTITY_FILE_MODE, readDaemonRelayIdentity } from '../../../src/lib/relay/identity.ts';
import { DaemonRelayConfigSchema } from '../../../src/lib/runtime/config.ts';

const DAEMON_ID = 'fy_daemon_HKk0mHiVBz4CHkYSCYnLK1LZ8xrxsWnkuiwlOihQaN8';

const relayConfig = (patch: Record<string, unknown> = {}) =>
  DaemonRelayConfigSchema.parse({ url: 'https://relay.example', ...patch });

interface FakeFiles {
  readonly port: FileSystemPort;
  readonly modes: number[];
}

function files(stored: string | undefined, information: FileInformation | undefined): FakeFiles {
  const modes: number[] = [];
  return {
    modes,
    port: {
      ensureDirectory: async () => {},
      setMode: async (_path, mode) => {
        modes.push(mode);
      },
      listDirectory: async () => [],
      readText: async () => stored,
      readChunks: async function* () {},
      readSlice: async () => undefined,
      information: async () => information,
      writeTextAtomic: async () => {},
      createFileExclusive: async () => ({ size: 0, modifiedAtMs: 0, inode: '0' }) as never,
      appendLineDurable: async () => ({}) as never,
      appendLineToExisting: async () => ({ kind: 'absent' }) as never,
      removeFile: async () => {},
      sweepTemporaryFiles: async () => {},
    },
  };
}

const stat = (mode: number): FileInformation => ({ mode, size: 1, modifiedAtMs: 1, inode: '1' }) as FileInformation;

const identityDocument = (pem: string): string => JSON.stringify({ schemaVersion: 1, privateKeyPem: pem });

describe('the relay carrier decision', () => {
  it('should refuse to dial without an address, and never invent one', () => {
    // Assert — the fail-closed cases, each with the sentence a surface shows.
    should(decideRelayCarrier(undefined, DAEMON_ID)).match({ kind: 'none', reason: /only directly/u });
    should(decideRelayCarrier(relayConfig({ enabled: false }), DAEMON_ID)).match({
      kind: 'none',
      reason: /switched off/u,
    });
    // A fingerprint that is not one cannot address a rendezvous, so dialling would put a socket on a
    // path the rendezvous refuses.
    should(decideRelayCarrier(relayConfig(), 'not-a-fingerprint')).containDeep({ kind: 'none' });
  });

  it('should derive the daemon-role socket URL and the host the claim signature covers', () => {
    // Act
    const decision = decideRelayCarrier(
      relayConfig({ url: 'https://relay.example:8443', reconnectSeconds: 45 }),
      DAEMON_ID,
    );

    // Assert
    should(decision).containDeep({
      kind: 'dial',
      socketUrl: `wss://relay.example:8443/v1/rendezvous/${DAEMON_ID}/daemon`,
      // The host as the configured URL spells it, port included: it is inside the signature.
      relayHost: 'relay.example:8443',
      reconnectMs: 45_000,
    });
  });

  it('should read silence as death rather than waiting for a close that never comes', () => {
    // Assert
    should(relaySocketIsStale(0, 44_999)).be.false();
    should(relaySocketIsStale(0, 45_000)).be.true();
  });
});

describe("reading the daemon's own identity", () => {
  it('should refuse every damaged document rather than mint a second identity', async () => {
    // Assert — absent is absent: pairing mints the key, and a relay that minted one would rename
    // this daemon out from under every browser that pinned its fingerprint.
    should(
      await readDaemonRelayIdentity(files(undefined, undefined).port, '/state/id.json', { load: notCalled }),
    ).match({
      ok: false,
      reason: /does not exist yet/u,
    });
    should(
      await readDaemonRelayIdentity(files('{', stat(0o600)).port, '/state/id.json', { load: notCalled }),
    ).containDeep({
      ok: false,
    });
    should(
      await readDaemonRelayIdentity(files(JSON.stringify({ schemaVersion: 2 }), stat(0o600)).port, '/x', {
        load: notCalled,
      }),
    ).containDeep({ ok: false });
    // A key the platform will not import is a fault to report, not a reason to replace it.
    should(
      await readDaemonRelayIdentity(files(identityDocument('not a pem'), stat(0o600)).port, '/x', {
        load: async () => {
          throw new Error('not a PEM document');
        },
      }),
    ).match({ ok: false, reason: /not a PEM document/u });
  });

  it('should tighten a key file whose mode cannot be proved owner-only', async () => {
    // Arrange
    const identity = { publicKeySpki: new Uint8Array(44), daemonId: DAEMON_ID, privateKey: { algorithm: 'Ed25519' } };
    const load = async () => identity as never;

    // Act + Assert — a tight mode is left alone.
    const tight = files(identityDocument('pem'), stat(0o600));
    should(await readDaemonRelayIdentity(tight.port, '/x', { load })).containDeep({ ok: true });
    should(tight.modes).deepEqual([]);

    // Act + Assert — a readable one is tightened.
    const loose = files(identityDocument('pem'), stat(0o644));
    should(await readDaemonRelayIdentity(loose.port, '/x', { load })).containDeep({ ok: true });
    should(loose.modes).deepEqual([DAEMON_IDENTITY_FILE_MODE]);

    // Act + Assert — so is one whose mode could not be read at all. An absent stat is the case FOR
    // tightening, not evidence that tightening is unnecessary.
    const unknown = files(identityDocument('pem'), undefined);
    should(await readDaemonRelayIdentity(unknown.port, '/x', { load })).containDeep({ ok: true });
    should(unknown.modes).deepEqual([DAEMON_IDENTITY_FILE_MODE]);
  });
});

async function notCalled(): Promise<never> {
  throw new Error('the identity key must not be read for a document that failed to parse');
}
