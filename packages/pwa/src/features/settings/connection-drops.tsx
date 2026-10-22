/**
 * SETTINGS › MACHINE › PERFORMANCE › CONNECTION DROPS: every held session this device lost to THIS
 * machine, as lines a person can read and copy to whoever is looking into "it keeps reconnecting".
 *
 * The evidence is `lib/carrier-drops.ts`'s: which carrier dropped, the close code, how long the session
 * had lived and when it last heard anything, whether the page was hidden and for how long, whether the
 * device was online and on what network, and how long the next session took to open. It is this
 * device's own record — nothing is asked of the machine, so it reads the same over any carrier, or none.
 */

import { Copy, Trash2, Unplug } from 'lucide-react';
import { useMemo, useState, useSyncExternalStore } from 'react';

import {
  type CarrierDrop,
  type CarrierDropLog,
  carrierDropsReport,
  describeCarrierDrop,
} from '../../lib/carrier-drops.ts';
import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import { Button } from '../../shell/primitives.tsx';
import { browserClipboardWriter, type ClipboardWriter } from '../onboarding/copy-button.tsx';

/** How many of the newest drops the page lists; Copy always carries every one kept. */
const CONNECTION_DROPS_SHOWN = 20;

const NO_DROPS: readonly CarrierDrop[] = [];

/** One sentence that says how often, and how fast it came back, before the lines that say each time. */
export const connectionDropsSummary = (drops: readonly CarrierDrop[]): string => {
  if (drops.length === 0) return 'No dropped connections recorded on this device.';
  const back = drops.flatMap(drop => (drop.reconnectMs === undefined ? [] : [drop.reconnectMs])).sort((a, b) => a - b);
  const median = back[Math.floor((back.length - 1) / 2)];
  const hidden = drops.filter(drop => drop.hidden).length;
  return [
    `${String(drops.length)} dropped ${drops.length === 1 ? 'connection' : 'connections'}`,
    hidden === 0 ? 'none while the app was hidden' : `${String(hidden)} while the app was hidden`,
    median === undefined ? 'none reconnected yet' : `usually back in ${(median / 1_000).toFixed(1)} s`,
  ].join(' · ');
};

export interface ConnectionDropsProps {
  readonly connection: DaemonConnection;
  readonly drops: CarrierDropLog;
  readonly write?: ClipboardWriter;
}

export function ConnectionDrops({ connection, drops, write = browserClipboardWriter() }: ConnectionDropsProps) {
  const all = useSyncExternalStore(drops.subscribe, drops.snapshot, () => NO_DROPS);
  const mine = useMemo(() => all.filter(drop => drop.daemonId === connection.daemonId), [all, connection.daemonId]);
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = (): void => {
    write(carrierDropsReport(mine)).then(
      () => setCopied('copied'),
      () => setCopied('failed'),
    );
  };
  return (
    <section
      className="kt-panel flex min-w-0 flex-col gap-2 p-panel"
      aria-label="Connection drops"
      data-connection-drops={mine.length}
    >
      <h4 className="m-0 flex items-center gap-2 text-row font-semibold text-fg">
        <Unplug size={16} aria-hidden="true" className="text-muted" />
        Connection drops on this device
      </h4>
      <p className="m-0 text-cell leading-base text-muted" data-connection-drops-summary="">
        {connectionDropsSummary(mine)}
      </p>
      {mine.length === 0 ? null : (
        <>
          <ol className="m-0 flex list-none flex-col gap-1 p-0" aria-label="Newest first">
            {[...mine]
              .reverse()
              .slice(0, CONNECTION_DROPS_SHOWN)
              .map(drop => (
                <li
                  key={`${String(drop.at)}-${drop.carrier}-${drop.purpose}`}
                  className="min-w-0 break-words font-mono text-cell leading-base text-fg"
                >
                  {describeCarrierDrop(drop)}
                </li>
              ))}
          </ol>
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={copy} data-connection-drops-copy="">
              <Copy size={16} aria-hidden="true" />
              Copy drops
            </Button>
            <Button
              type="button"
              onClick={() => {
                drops.clearDaemon(connection.daemonId);
                setCopied('idle');
              }}
              data-connection-drops-clear=""
            >
              <Trash2 size={16} aria-hidden="true" />
              Clear
            </Button>
          </div>
        </>
      )}
      {copied === 'idle' ? null : (
        <p className="m-0 text-cell leading-base text-muted" role="status">
          {copied === 'copied' ? 'Copied the drops.' : 'Copy was blocked — select the lines instead.'}
        </p>
      )}
    </section>
  );
}
