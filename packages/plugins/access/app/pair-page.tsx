/**
 * ACCESS'S DAEMON-LESS `/pair` SCREEN: where the QR a machine shows lands on a device that has no daemon yet, and where
 * a person who already has some adds another.
 *
 * It is handed the shell's {@link DaemonlessPorts} and nothing else — NO daemon client, because it has no daemon to
 * talk to. Its only way to one is the pairing exchange (`lib/pair-exchange.ts`), which rides the `pair` session the
 * shell opens over the carriers Connections' walk gives (the daemon's own address first, then the one discovered
 * rendezvous; protocol §14). Today's `ConnectionPicker` (`pwa/src/App.tsx`), moved.
 *
 * THE CODE: read from the address (`location()`) when the page opens and again whenever a SECOND link reaches the open
 * page (a `hashchange`, or the router's new entry for the same path), then the entry is REPLACED with its bare path so
 * history, a bookmark or the share sheet never hold it; kept only in this screen's state; never logged, never in a
 * live region, never in an error sentence, never stored. A second link restarts the screen for that link. A sealed
 * refusal ends the attempt: nothing here retries.
 */
import {
  type DaemonlessPorts,
  type DaemonlessScreenProps,
  daemonHomeHref,
  distinctDaemonName,
  useOptionalRouter,
} from '@ferretry/app';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
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

/** The per-machine slot of a daemon-less screen: never drawn (its route is under no `/d/<machine>/`), so it draws nothing. */
export const daemonlessPlaceholder = (): null => null;

/** The `/pair` view over the shell's ports. */
export function pairPage(ports: DaemonlessPorts, environment: PairPageEnvironment = {}) {
  const store = environment.store ?? accessKeyStore(ports);
  const claims = accessClaims(ports, { store });
  return function PairPage({ navigate, location }: DaemonlessScreenProps) {
    // Read at mount, and again only when a new link arrives (below). A plain render must not re-read an address the
    // screen has already emptied, and must not resurrect a code the reader declined.
    const [link, setLink] = useState<{ readonly arrival: PairingArrival; readonly nonce: number }>(() => ({
      arrival: pairingArrival(location()),
      nonce: 0,
    }));
    // A second link opened on this page reloads nothing: it is a fragment-only navigation, so the page is read again
    // from the router's new entry or from `hashchange`. The screen restarts for it (the new key); its own mount
    // effect then takes the fragment out of the address, replacing the entry.
    const readSecondLink = useCallback((): void => {
      if (new URL(location()).hash === '') return;
      const arrival = pairingArrival(location());
      setLink(held => ({ arrival, nonce: held.nonce + 1 }));
    }, [location]);
    const entryKey = useOptionalRouter()?.entryKey;
    const seenEntry = useRef(entryKey);
    useEffect(() => {
      if (seenEntry.current === entryKey) return;
      seenEntry.current = entryKey;
      readSecondLink();
    }, [entryKey, readSecondLink]);
    useEffect(() => {
      window.addEventListener('hashchange', readSecondLink);
      return () => window.removeEventListener('hashchange', readSecondLink);
    }, [readSecondLink]);
    // `/pair?refused=<machine>`: that machine no longer accepts this browser (it was removed, or went unused too long).
    // A machine id is not a secret; the code never rides the query.
    const [refusedBy, setRefusedBy] = useState<string | null>(() => new URL(location()).searchParams.get('refused'));
    const scanHost = useMemo(() => (environment.scanHost ?? (() => browserQrScan(environment.loadDecoder)))(), []);
    const snapshot = useSyncExternalStore(ports.daemons.subscribe, ports.daemons.snapshot);
    const connections = useMemo(() => snapshot.daemons.map(connectionRecord), [snapshot]);
    const takeArrival = useCallback(() => {
      // `replace`, not push: a back button that restored the code would undo exactly this.
      const here = new URL(location());
      navigate(`${here.pathname}${here.search}`, { replace: true });
    }, [location, navigate]);
    const refused = refusedBy === null ? undefined : snapshot.daemons.find(entry => entry.daemon === refusedBy);
    return (
      <>
        {refused === undefined ? null : (
          <DeviceRefusedNotice
            machineName={distinctDaemonName(refused, snapshot.daemons)}
            onPairAgain={() => setRefusedBy(null)}
          />
        )}
        <PairingScreen
          key={link.nonce}
          arrival={link.arrival}
          scanHost={scanHost}
          onArrivalTaken={takeArrival}
          connections={connections}
          selectedDaemonId={snapshot.selected === null ? null : daemonId(snapshot.selected)}
          {...(environment.defaultName === undefined ? {} : { defaultName: environment.defaultName })}
          onPair={async (seed, deviceName) => {
            const paired = await exchangePairing({ ports, claims, store }, seed, deviceName);
            navigate(daemonHomeHref(paired.daemon));
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
