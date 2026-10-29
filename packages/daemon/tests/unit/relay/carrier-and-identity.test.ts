/**
 * Whether this daemon dials at all, and with which key.
 *
 * Both decisions fail closed, and both explain themselves: a daemon with no relay and a daemon whose
 * relay is broken look identical from the outside, so the reason is part of the answer.
 */

import { describe, it } from 'bun:test';
import should from 'should';
import type { FileInformation, FileSystemPort } from '../../../src/lib/ports.ts';
import {
  decideRelayCarrier,
  RELAY_BANDWIDTH_RECHECK_MS,
  RELAY_BANDWIDTH_REDIAL_MIN_MS,
  RELAY_BANDWIDTH_REDIAL_SPREAD_MS,
  RELAY_CAPACITY_REDIAL_BASE_MS,
  RELAY_CAPACITY_REDIAL_CEILING_MS,
  relayBandwidthRedialDelayMs,
  relayCapacityRedialDelayMs,
  relayDialUrl,
  relayRedialDelayMs,
  relaySocketIsStale,
} from '../../../src/lib/relay/carrier.ts';
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
      // The origin only: the path carries the daemon's fingerprint and a log line must not.
      relayOrigin: 'https://relay.example:8443',
      reconnectMs: 45_000,
    });
  });

  it('should ask a rendezvous for its features in the query, leaving the route untouched', () => {
    const route = 'wss://relay.example/hosted/v1/rendezvous/fy_daemon_x/daemon';
    const dialled = new URL(relayDialUrl(route));
    should(`${dialled.origin}${dialled.pathname}`).equal(route);
    should(dialled.searchParams.get('features')).equal('claim-probe,claim-handover');
  });

  it('should read silence as death rather than waiting for a close that never comes', () => {
    // Assert
    should(relaySocketIsStale(0, 44_999)).be.false();
    should(relaySocketIsStale(0, 45_000)).be.true();
  });
});

describe('the redial schedule', () => {
  it('should redial the first time immediately, whatever the jitter draw', () => {
    // Assert
    for (const random of [0, 0.5, 1]) should(relayRedialDelayMs(0, random, 5_000)).equal(0);
  });

  it('should double the window from 500 ms and keep the delay in its upper half', () => {
    // Assert — attempt n has window 500 × 2^(n−1): the bottom of the range at random 0, the top at 1.
    should([1, 2, 3, 4].map(attempt => relayRedialDelayMs(attempt, 0, 10_000))).deepEqual([250, 500, 1_000, 2_000]);
    should([1, 2, 3, 4].map(attempt => relayRedialDelayMs(attempt, 1, 10_000))).deepEqual([500, 1_000, 2_000, 4_000]);
    should(relayRedialDelayMs(3, 0.5, 10_000)).equal(1_500);
  });

  it('should never exceed the ceiling, however long the outage runs', () => {
    // Assert
    should(relayRedialDelayMs(10, 1, 5_000)).equal(5_000);
    should(relayRedialDelayMs(10, 0, 5_000)).equal(2_500);
    should(relayRedialDelayMs(1_000_000, 1, 5_000)).equal(5_000);
  });

  it('should read the configured seconds as a ceiling clamped to one through ten seconds', () => {
    // Assert — a ceiling of an hour is ten seconds; of a millisecond is one second.
    should(relayRedialDelayMs(20, 1, 3_600_000)).equal(10_000);
    should(relayRedialDelayMs(20, 1, 1)).equal(1_000);
    should(relayRedialDelayMs(20, 1, -5)).equal(1_000);
    should(relayRedialDelayMs(20, 1, Number.POSITIVE_INFINITY)).equal(10_000);
    should(relayRedialDelayMs(20, 1, Number.NEGATIVE_INFINITY)).equal(1_000);
  });

  it('should be total: unusable inputs normalise rather than become a zero-length timer', () => {
    // Assert — an unusable attempt is the first redial and an infinite one the longest window.
    should(relayRedialDelayMs(Number.NaN, 1, 5_000)).equal(0);
    should(relayRedialDelayMs(-3, 1, 5_000)).equal(0);
    should(relayRedialDelayMs(Number.NEGATIVE_INFINITY, 1, 5_000)).equal(0);
    should(relayRedialDelayMs(Number.POSITIVE_INFINITY, 1, 5_000)).equal(5_000);
    should(relayRedialDelayMs(2.9, 0, 5_000)).equal(relayRedialDelayMs(2, 0, 5_000));
    // An unusable draw is the bottom of the range, never a shorter wait than the schedule allows.
    should(relayRedialDelayMs(3, Number.NaN, 10_000)).equal(1_000);
    should(relayRedialDelayMs(3, Number.POSITIVE_INFINITY, 10_000)).equal(1_000);
    should(relayRedialDelayMs(3, -1, 10_000)).equal(1_000);
    should(relayRedialDelayMs(3, 7, 10_000)).equal(2_000);
    // An unusable ceiling is the five-second default.
    should(relayRedialDelayMs(20, 1, Number.NaN)).equal(5_000);
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

describe('the redial schedule after a hosted connection ceiling', () => {
  it('should wait minutes, doubling to a ten-minute window, with equal jitter', () => {
    should([1, 2, 3, 4, 9].map(refusals => relayCapacityRedialDelayMs(refusals, 1))).deepEqual([
      RELAY_CAPACITY_REDIAL_BASE_MS,
      240_000,
      480_000,
      RELAY_CAPACITY_REDIAL_CEILING_MS,
      RELAY_CAPACITY_REDIAL_CEILING_MS,
    ]);
    should(relayCapacityRedialDelayMs(1, 0)).equal(RELAY_CAPACITY_REDIAL_BASE_MS / 2);
    should(relayCapacityRedialDelayMs(1, 0.5)).equal(90_000);
  });

  it('should be total: an unusable count is the first refusal, an unusable random the bottom of the range', () => {
    should(relayCapacityRedialDelayMs(Number.NaN, 1)).equal(RELAY_CAPACITY_REDIAL_BASE_MS);
    should(relayCapacityRedialDelayMs(-3, 1)).equal(RELAY_CAPACITY_REDIAL_BASE_MS);
    should(relayCapacityRedialDelayMs(Number.POSITIVE_INFINITY, 1)).equal(RELAY_CAPACITY_REDIAL_CEILING_MS);
    should(relayCapacityRedialDelayMs(1, Number.NaN)).equal(RELAY_CAPACITY_REDIAL_BASE_MS / 2);
    should(relayCapacityRedialDelayMs(1, 7)).equal(RELAY_CAPACITY_REDIAL_BASE_MS);
  });
});

describe('the redial schedule after a hosted byte ceiling', () => {
  it('should wait until the reset, between a minute and the recheck interval, spread after it', () => {
    should(relayBandwidthRedialDelayMs(300_000, 0)).equal(300_000);
    should(relayBandwidthRedialDelayMs(300_000, 1)).equal(300_000 + RELAY_BANDWIDTH_REDIAL_SPREAD_MS);
    should(relayBandwidthRedialDelayMs(5_000, 0)).equal(RELAY_BANDWIDTH_REDIAL_MIN_MS);
    should(relayBandwidthRedialDelayMs(-5_000, 0)).equal(RELAY_BANDWIDTH_REDIAL_MIN_MS);
    should(relayBandwidthRedialDelayMs(20 * 3_600_000, 0)).equal(RELAY_BANDWIDTH_RECHECK_MS);
  });

  it('should be total: an unusable wait is the recheck interval, an unusable random adds nothing', () => {
    should(relayBandwidthRedialDelayMs(Number.NaN, 0)).equal(RELAY_BANDWIDTH_RECHECK_MS);
    should(relayBandwidthRedialDelayMs(Number.POSITIVE_INFINITY, 0)).equal(RELAY_BANDWIDTH_RECHECK_MS);
    should(relayBandwidthRedialDelayMs(300_000, Number.NaN)).equal(300_000);
    should(relayBandwidthRedialDelayMs(300_000, 7)).equal(300_000 + RELAY_BANDWIDTH_REDIAL_SPREAD_MS);
  });
});
