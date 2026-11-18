/**
 * SETTINGS › THIS DEVICE › CONNECTION › CONNECTION DROPS: every held session this browser lost, with what the page
 * could see at that moment (`lib/carrier-drops.ts` owns the log), so "it keeps reconnecting" arrives as evidence.
 *
 * v4 drew this card on Settings › Machine › Performance. It lives with Connection here because the drops are about how
 * this DEVICE reaches a machine, the same subject as the carrier preference above it, and Performance (the usage
 * plugin's) has no seam for another plugin's card. The log is bounded and never leaves this browser; Copy report puts
 * the same text on the clipboard that the rows show.
 */

import { useMemo, useState, useSyncExternalStore } from 'react';
import { type CarrierDrop, carrierDropsReport, describeCarrierDrop } from '../../lib/carrier-drops.ts';
import { Button } from '../../shell/primitives.tsx';

/** The log as this card reads it: its snapshot and changes, and forgetting one machine's drops. */
export interface CarrierDropsSource {
  readonly snapshot: () => readonly CarrierDrop[];
  readonly subscribe: (listener: () => void) => () => void;
  readonly clearDaemon: (daemonId: string) => void;
}

/** The newest drops listed on screen; Copy report carries every one of the machine's. */
const CARRIER_DROPS_SHOWN = 20;

/** "3 dropped · 1 while hidden · usually back in 4.0 s": v4's one-line summary of a machine's drops. */
export function carrierDropsSummary(drops: readonly CarrierDrop[]): string {
  const hidden = drops.filter(drop => drop.hidden).length;
  const back = drops
    .flatMap(drop => (drop.reconnectMs === undefined ? [] : [drop.reconnectMs]))
    .toSorted((a, b) => a - b);
  const middle = back[Math.floor(back.length / 2)];
  return [
    `${String(drops.length)} dropped`,
    `${String(hidden)} while hidden`,
    ...(middle === undefined ? [] : [`usually back in ${(middle / 1_000).toFixed(1)} s`]),
  ].join(' · ');
}

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

/** One machine's drops: the log is device-wide, so each card names its machine and lists only that machine's. */
export function CarrierDropsCard({
  log,
  daemonId,
  machine,
  copy = browserClipboard,
}: {
  readonly log: CarrierDropsSource;
  readonly daemonId: string;
  readonly machine: string;
  readonly copy?: (text: string) => Promise<void>;
}) {
  const all = useSyncExternalStore(log.subscribe, log.snapshot, log.snapshot);
  const drops = useMemo(() => all.filter(drop => drop.daemonId === daemonId), [all, daemonId]);
  const [note, setNote] = useState<string | null>(null);
  const newest = drops.toReversed().slice(0, CARRIER_DROPS_SHOWN);
  return (
    <section
      className="flex flex-col gap-2"
      aria-labelledby={`carrier-drops-${daemonId}`}
      data-carrier-drops={daemonId}
    >
      <h3 id={`carrier-drops-${daemonId}`} className="m-0 text-row font-semibold text-fg">
        Connection drops on this device · {machine}
      </h3>
      <p className="m-0 text-cell leading-base text-muted">
        Every time a held connection to {machine} was lost without this app asking. Kept on this device only.
      </p>
      {drops.length === 0 ? (
        <p className="m-0 text-cell text-muted" data-carrier-drops-empty="">
          {NO_CARRIER_DROPS}
        </p>
      ) : (
        <>
          <p className="m-0 text-cell text-fg" data-carrier-drops-summary="">
            {carrierDropsSummary(drops)}
          </p>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {newest.map(drop => (
              <li
                key={`${String(drop.at)}-${drop.daemonId}-${drop.purpose}`}
                className="mono break-words text-meta text-fg-soft"
              >
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
            <Button size="sm" variant="ghost" data-carrier-drops-clear="" onClick={() => log.clearDaemon(daemonId)}>
              Clear
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
