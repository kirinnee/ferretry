import type { PairedDaemon } from '../daemons/daemon-list.ts';
import type { SessionDeviceClaim } from '../session/session-client.ts';
import type { CarrierDial } from '../session/session-transport.ts';
import type { CarrierDialer, DeviceClaims, PairingKey } from './provides.ts';

/**
 * TEST FAKES FOR THE CONNECT INTERFACE (`@ferretry/app/testing`). A plugin app half's suite drives the shell with these
 * instead of a browser; the Access and Connections halves are checked against the same interfaces the fakes satisfy.
 * Neither fake holds key material: a fake claim's key is whatever handle the test hands in.
 */

export interface FakeDeviceClaims extends DeviceClaims {
  /** The daemons a claim was asked for, in order. */
  readonly asked: readonly string[];
  /** The daemons a pairing key was asked for. */
  readonly pairingAsked: readonly string[];
  /** The daemons forgotten. */
  readonly forgotten: readonly string[];
}

export interface FakeDeviceClaimsOptions {
  /** The claim per daemon id; a daemon absent here has no key on this device. */
  readonly claims?: Readonly<Record<string, SessionDeviceClaim>>;
  /** The key a `pair` session registers; absent, `pairingKey` rejects. */
  readonly pairingKey?: PairingKey;
}

export function fakeDeviceClaims(options: FakeDeviceClaimsOptions = {}): FakeDeviceClaims {
  const claims = new Map(Object.entries(options.claims ?? {}));
  const asked: string[] = [];
  const pairingAsked: string[] = [];
  const forgotten: string[] = [];
  return {
    asked,
    pairingAsked,
    forgotten,
    claim: async (daemon: PairedDaemon) => {
      asked.push(daemon.daemon);
      return claims.get(daemon.daemon);
    },
    pairingKey: async (daemonId: string) => {
      pairingAsked.push(daemonId);
      if (options.pairingKey === undefined) throw new Error('this fake holds no pairing key');
      return options.pairingKey;
    },
    forget: async (daemonId: string) => {
      forgotten.push(daemonId);
      claims.delete(daemonId);
    },
  };
}

export interface FakeCarrier extends CarrierDialer {
  /** The daemons this carrier was asked to dial, in order. */
  readonly dialed: readonly string[];
}

/** A carrier that answers `dial` for the daemons `reaches` says, with the given dial; every other daemon is out of reach. */
export function fakeCarrier(options: {
  readonly id: string;
  readonly order: number;
  readonly dial: CarrierDial;
  readonly reaches?: (daemon: PairedDaemon) => boolean;
}): FakeCarrier {
  const dialed: string[] = [];
  return {
    id: options.id,
    order: options.order,
    dialed,
    dial: daemon => {
      dialed.push(daemon.daemon);
      return (options.reaches ?? (() => true))(daemon) ? options.dial : undefined;
    },
  };
}

/**
 * The shell's own session pieces, for a plugin's integration fixture: the real WebCrypto session crypto and the real
 * `connect` / `pair` functions `src/main.tsx` binds, so a provider's suite drives the production path against a real
 * daemon session layer rather than a fake of it.
 */
export { WebCryptoRelayCrypto } from '../session/webcrypto.ts';
export { connector, pairOnLeg, pairOverCarriers } from './connector.ts';
