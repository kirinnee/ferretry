/**
 * SETTINGS › THIS DEVICE › CONNECTION › CONNECTION DROPS: every held session this browser lost, with what the page
 * could see at that moment (`lib/carrier-drops.ts` owns the log), so "it keeps reconnecting" arrives as evidence.
 *
 * v4 drew this card on Settings › Machine › Performance. It lives with Connection here because the drops are about how
 * this DEVICE reaches a machine, the same subject as the carrier preference above it, and Performance (the usage
 * plugin's) has no seam for another plugin's card. The log is bounded and never leaves this browser; Copy report puts
 * the same text on the clipboard that the rows show.
 */

import { useState, useSyncExternalStore } from 'react';
import { type CarrierDrop, carrierDropsReport, describeCarrierDrop } from '../../lib/carrier-drops.ts';
import { Button } from '../../shell/primitives.tsx';

/** The log as this card reads it: its snapshot and changes, nothing else. */
export interface CarrierDropsSource {
  readonly snapshot: () => readonly CarrierDrop[];
  readonly subscribe: (listener: () => void) => () => void;
}

/** The newest drops listed on screen; Copy report carries every one the log keeps. */
const CARRIER_DROPS_SHOWN = 10;

export const NO_CARRIER_DROPS = 'No dropped connections recorded on this device.';

/** Puts text on the clipboard; rejects on a browser that gives the page none. */
const browserClipboard = async (text: string): Promise<void> => {
  const clipboard = (
    globalThis.navigator as { clipboard?: { writeText?: (value: string) => Promise<void> } } | undefined
  )?.clipboard;
  if (typeof clipboard?.writeText !== 'function')
    throw new Error('this browser will not give the page clipboard access');
  await clipboard.writeText(text);
};

export function CarrierDropsCard({
  log,
  copy = browserClipboard,
}: {
  readonly log: CarrierDropsSource;
  readonly copy?: (text: string) => Promise<void>;
}) {
  const drops = useSyncExternalStore(log.subscribe, log.snapshot, log.snapshot);
  const [note, setNote] = useState<string | null>(null);
  const newest = drops.toReversed().slice(0, CARRIER_DROPS_SHOWN);
  return (
    <section className="flex flex-col gap-2" aria-labelledby="carrier-drops-heading" data-carrier-drops="">
      <h3 id="carrier-drops-heading" className="m-0 text-row font-semibold text-fg">
        Connection drops on this device
      </h3>
      <p className="m-0 text-cell leading-base text-muted">
        Every time a held connection to a machine was lost without this app asking. Kept on this device only.
      </p>
      {drops.length === 0 ? (
        <p className="m-0 text-cell text-muted" data-carrier-drops-empty="">
          {NO_CARRIER_DROPS}
        </p>
      ) : (
        <>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {newest.map(drop => (
              <li key={`${String(drop.at)}-${drop.daemonId}-${drop.purpose}`} className="mono text-meta text-fg-soft">
                {describeCarrierDrop(drop)}
              </li>
            ))}
          </ul>
          {drops.length > newest.length && (
            <p className="m-0 text-meta text-faint">
              {String(newest.length)} newest of {String(drops.length)} shown; Copy report has them all.
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              onClick={() => {
                copy(carrierDropsReport(drops)).then(
                  () => setNote('Copied.'),
                  (reason: unknown) => setNote(reason instanceof Error ? reason.message : 'Could not copy.'),
                );
              }}
            >
              Copy report
            </Button>
            {note !== null && (
              <span role="status" className="text-meta text-muted">
                {note}
              </span>
            )}
          </div>
        </>
      )}
    </section>
  );
}
