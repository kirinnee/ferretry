import { Button } from '@ferretry/app/ui';
import { useCallback, useEffect, useState } from 'react';
import type { BrowserStateView, LOOPBACK_FIREWALL_STATES } from '../../../contract/index.ts';
import type { CallClient } from '../../lib/clients.ts';
import { readBrowserState } from './browser-proxy-api.ts';
import { SetupNote, SetupSection } from './setup-ui.tsx';

/** The one sentence the status line shows: whether the shared browser runs, and how its traffic leaves. */
export const browserStateSentence = (view: BrowserStateView, savedProxy: boolean): string => {
  switch (view.state) {
    case 'running': {
      if (view.proxy === undefined) return 'Running · direct, no proxy.';
      return `Running · via proxy ${view.proxy.url} · ${view.proxy.authenticated ? 'signs in' : 'no sign-in'}.`;
    }
    case 'starting':
      return 'Starting…';
    case 'stopping':
      return 'Stopping…';
    case 'error':
      return 'Stopped after an error. It starts again the next time an agent opens a page.';
    case 'stopped':
      return `Stopped · the next start goes ${savedProxy ? 'via the saved proxy' : 'direct'}.`;
  }
};

/** The heading of the firewall note, by what the daemon read; `applied` shows no note. */
const FIREWALL_TITLES: Record<(typeof LOOPBACK_FIREWALL_STATES)[number], string> = {
  applied: 'The loopback firewall is applied',
  missing: 'Other users on this host can reach this browser’s ports',
  stale: 'Other users on this host can reach this browser’s ports',
  failed: 'The loopback firewall let another user reach this browser’s ports',
  unverified: 'The loopback firewall has not been checked recently',
};

type Reading =
  | { readonly kind: 'reading' }
  | { readonly kind: 'shown'; readonly view: BrowserStateView }
  | { readonly kind: 'unavailable' };

/** "Status": is the shared browser running, and is it going through the proxy? */
export function BrowserStateLine({
  client,
  savedProxy,
}: {
  readonly client: CallClient;
  /** A proxy is saved, so a stopped browser's next start uses it. */
  readonly savedProxy: boolean;
}) {
  const [reading, setReading] = useState<Reading>({ kind: 'reading' });
  const load = useCallback((): (() => void) => {
    let current = true;
    setReading({ kind: 'reading' });
    readBrowserState(client).then(
      view => {
        if (current) setReading({ kind: 'shown', view });
      },
      () => {
        if (current) setReading({ kind: 'unavailable' });
      },
    );
    return () => {
      current = false;
    };
  }, [client]);
  useEffect(() => load(), [load]);

  const words =
    reading.kind === 'reading'
      ? 'Checking the browser…'
      : reading.kind === 'unavailable'
        ? 'This machine did not say whether its browser is running.'
        : browserStateSentence(reading.view, savedProxy);
  return (
    <SetupSection title="Status" name="browser-status">
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <p
          role="status"
          className="m-0 min-w-0 break-words text-cell leading-base text-fg"
          data-browser-state={reading.kind === 'shown' ? reading.view.state : reading.kind}
        >
          {words}
        </p>
        <Button type="button" size="sm" data-browser-state-refresh="" onClick={() => void load()}>
          Refresh
        </Button>
      </div>
      {reading.kind === 'shown' && reading.view.firewall !== undefined && reading.view.firewall.state !== 'applied' ? (
        <SetupNote tone="warn" name="browser-firewall" title={FIREWALL_TITLES[reading.view.firewall.state]}>
          <p className="m-0 min-w-0 break-words">{reading.view.firewall.detail}</p>
        </SetupNote>
      ) : null}
    </SetupSection>
  );
}
