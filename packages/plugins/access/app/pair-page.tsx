/**
 * ACCESS'S DAEMON-LESS `/pair` SCREEN: where the QR a machine shows lands on a device that has no daemon yet, and where
 * a person who already has some adds another.
 *
 * It is handed the shell's {@link DaemonlessPorts} and nothing else — NO daemon client, because it has no daemon to
 * talk to. Its only way to one is the pairing exchange (`lib/pair-exchange.ts`), which rides the `pair` session the
 * shell opens over the carriers Connections' walk gives (the daemon's own address first, then the one discovered
 * rendezvous; protocol §14). Today's `ConnectionPicker` (`pwa/src/App.tsx`), moved.
 *
 * THE CODE: read once from the address at mount (`location()`), then the entry is REPLACED with its bare path so
 * history, a bookmark or the share sheet never hold it; kept only in this screen's state; never logged, never in a
 * live region, never in an error sentence, never stored. A sealed refusal ends the attempt: nothing here retries.
 */
import { type DaemonlessPorts, type DaemonlessScreenProps, daemonHomeHref, distinctDaemonName } from '@ferretry/app';
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
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
export function browserQrScan(loadDecoder?: () => Promise<DecodePixels>): QrScanHost | null {
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
    // Read ONCE, at mount. A later render must not re-read an address the screen has already emptied, and must not
    // resurrect a code the reader declined.
    const [arrival] = useState<PairingArrival>(() => pairingArrival(location()));
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
          arrival={arrival}
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
