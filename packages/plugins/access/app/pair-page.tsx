/**
 * ACCESS'S DAEMON-LESS `/pair` SCREEN: where the QR a machine shows lands on a device that has no daemon yet, and where
 * a person who already has some adds another.
 *
 * It is handed the shell's {@link DaemonlessPorts} and nothing else — NO daemon client, because it has no daemon to
 * talk to. Its only way to one is the pairing exchange (`lib/pair-exchange.ts`), which rides the `pair` session the
 * shell opens over the carriers Connections' walk gives (the daemon's own address first, then the one discovered
 * rendezvous; protocol §14). Today's `ConnectionPicker` (`pwa/src/App.tsx`), moved.
 *
 * THE CODE: Access declares the `/pair` fragment (`{ form: 'path', screen: 'pair' }`), so the SHELL takes it off the
 * address bar and the history entry before the first render and before this chunk loads (shell contract S3) and holds
 * it in memory; this screen takes it once (`useFragment('pair').take()`, in an effect), drawing "Opening link…" until
 * then. A SECOND link opened on the open page (a `hashchange`, or the router's new entry for the same path) bumps the
 * arrival and restarts the screen for that link; the old code is not kept. The code lives only in this screen's state:
 * never logged, never in a live region, never in an error sentence, never stored. A sealed refusal ends the attempt:
 * nothing here retries.
 */
import {
  type DaemonlessPorts,
  type DaemonlessScreenProps,
  daemonHomeHref,
  distinctDaemonName,
  useFragment,
} from '@ferretry/app';
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { accessClaims, accessKeyStore } from './connect.ts';
import { DeviceRefusedNotice } from './features/pairing/device-refused-notice.tsx';
import { PairingScreen } from './features/pairing/pairing-screen.tsx';
import { exchangePairing } from './lib/pair-exchange.ts';
import { type QrScanHost, browserQrScanHost, type QrDetectorLike } from './lib/pair-scan.ts';
import { type PairingArrival, pairingArrival } from './lib/pairing.ts';
import { type DecodePixels, frameQrDetector } from './lib/qr-frame-decoder.ts';
import type { DeviceKeyStore } from './lib/device-keys.ts';
import { connectionRecord } from './daemon-scope.tsx';
import { daemonId } from './shell-pairing.ts';

/** The browser objects a scan reads; the page's own unless a suite hands others in. */
export interface PairPageEnvironment {
  readonly scanHost?: () => QrScanHost | null;
  /**
   * The software QR decoder for a browser with no `BarcodeDetector` (WebKit), fetched only when somebody taps Scan.
   * GAP(access-qr-software-decoder): the decoder library (`jsqr`) is not a dependency of this build yet, so none is
   * supplied and such a browser gets the paste path only.
   */
  readonly loadDecoder?: () => Promise<DecodePixels>;
  readonly defaultName?: () => string;
  /** Where the device keys live; the page's IndexedDB unless a suite hands one in. */
  readonly store?: DeviceKeyStore;
}

/** The camera, or `null` where this browser has no QR decoder of its own to offer (the paste path stays). */
function browserQrScan(loadDecoder?: () => Promise<DecodePixels>): QrScanHost | null {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return null;
  const native = (window as { BarcodeDetector?: new (options: { formats: string[] }) => QrDetectorLike })
    .BarcodeDetector;
  if (native === undefined && loadDecoder === undefined) return null;
  const host = browserQrScanHost({
    media: navigator.mediaDevices,
    detector:
      native === undefined
        ? () =>
            frameQrDetector({
              createCanvas: () => document.createElement('canvas'),
              loadDecoder: loadDecoder as () => Promise<DecodePixels>,
            })
        : () => new native({ formats: ['qr_code'] }),
    delay: async milliseconds => await new Promise(resolve => setTimeout(resolve, milliseconds)),
  });
  return host.supported ? host : null;
}

/** What `/pair` draws while a link arrived and its code is not taken yet: never the code itself. */
export const OPENING_LINK = 'Opening link…';

/** The screen id the pairing fragment is declared for (the manifest's `pair`). */
export const PAIR_SCREEN_ID = 'pair';

const NO_LINK: PairingArrival = Object.freeze({ kind: 'none' });

/** A plain absolute path: letters, digits and `. _ ~ -` in segments. No scheme, host, query, fragment or `//`. */
const PLAIN_PATH = /^\/(?:[\w.~-]+(?:\/[\w.~-]+)*)?$/u;

/**
 * Where `/pair?return=<path>` asks to land after a pairing (the first run opens this page and comes back to its
 * journey). Only a plain same-origin path is honoured, so the query can never send a person to another site; it never
 * holds a code (those ride the fragment) and is read from the page's address, not from anything the exchange returns.
 */
export const returnPathOf = (href: string): string | undefined => {
  const asked = new URL(href).searchParams.get('return');
  return asked !== null && PLAIN_PATH.test(asked) ? asked : undefined;
};

/** The arrival a taken fragment reads as, on this page's own (already stripped) address. */
const arrivalOf = (location: string, fragment: string): PairingArrival => {
  const url = new URL(location);
  url.hash = fragment;
  return pairingArrival(url.href);
};

/** The per-machine slot of a daemon-less screen: never drawn (its route is under no `/d/<machine>/`), so it draws nothing. */
export const daemonlessPlaceholder = (): null => null;

/** The `/pair` view over the shell's ports. */
export function pairPage(ports: DaemonlessPorts, environment: PairPageEnvironment = {}) {
  const store = environment.store ?? accessKeyStore(ports);
  const claims = accessClaims(ports, { store });
  return function PairPage({ navigate, location }: DaemonlessScreenProps) {
    // The code is taken once per arrival, never re-read from an address the shell already emptied, so a plain render
    // cannot resurrect a code the reader declined. Each new arrival restarts the screen (the new key) for that link.
    const fragment = useFragment(PAIR_SCREEN_ID);
    const { take } = fragment;
    const [link, setLink] = useState<{ readonly arrival: PairingArrival; readonly nonce: number } | null>(null);
    useEffect(() => {
      if (fragment.arrival === 0) return;
      const taken = take();
      // Nothing to take (it expired, or this effect ran again): keep what is open, or open the cold page.
      if (taken === undefined) setLink(held => held ?? { arrival: NO_LINK, nonce: 0 });
      else setLink(held => ({ arrival: arrivalOf(location(), taken), nonce: (held?.nonce ?? 0) + 1 }));
    }, [fragment.arrival, take, location]);
    // `/pair?refused=<machine>`: that machine no longer accepts this browser (it was removed, or went unused too long).
    // A machine id is not a secret; the code never rides the query.
    const [refusedBy, setRefusedBy] = useState<string | null>(() => new URL(location()).searchParams.get('refused'));
    const scanHost = useMemo(() => (environment.scanHost ?? (() => browserQrScan(environment.loadDecoder)))(), []);
    const snapshot = useSyncExternalStore(ports.daemons.subscribe, ports.daemons.snapshot);
    const connections = useMemo(() => snapshot.daemons.map(connectionRecord), [snapshot]);
    const refused = refusedBy === null ? undefined : snapshot.daemons.find(entry => entry.daemon === refusedBy);
    if (link === null && fragment.arrival > 0)
      return (
        <p role="status" className="m-0 p-4 text-cell text-muted" data-pair-opening="">
          {OPENING_LINK}
        </p>
      );
    return (
      <>
        {refused === undefined ? null : (
          <DeviceRefusedNotice
            machineName={distinctDaemonName(refused, snapshot.daemons)}
            onPairAgain={() => setRefusedBy(null)}
          />
        )}
        <PairingScreen
          key={link?.nonce ?? 0}
          arrival={link?.arrival ?? NO_LINK}
          scanHost={scanHost}
          connections={connections}
          selectedDaemonId={snapshot.selected === null ? null : daemonId(snapshot.selected)}
          {...(environment.defaultName === undefined ? {} : { defaultName: environment.defaultName })}
          onPair={async (seed, deviceName) => {
            const paired = await exchangePairing({ ports, claims, store }, seed, deviceName);
            navigate(returnPathOf(location()) ?? daemonHomeHref(paired.daemon));
          }}
          onSelect={id => {
            ports.daemons.select(String(id));
            navigate(daemonHomeHref(String(id)));
          }}
          onRemove={id => ports.daemons.remove(String(id))}
        />
      </>
    );
  };
}
