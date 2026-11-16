import { Button, SetupNote, SetupSection } from '@ferretry/app/ui';
import { useCallback, useEffect, useState } from 'react';
import type { BrowserStateView, LOOPBACK_FIREWALL_STATES } from '../../../contract/index.ts';
import type { CallClient } from '../../lib/clients.ts';
import { readBrowserState } from './browser-proxy-api.ts';

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

/** What the status line says while the machine's feed is down (today's words). */
export const BROWSER_OFFLINE_WORDS = 'Offline · the status shows once this machine answers.';

/** "Status": is the shared browser running, and is it going through the proxy? */
export function BrowserStateLine({
  client,
  savedProxy,
  online = true,
}: {
  readonly client: CallClient;
  /** A proxy is saved, so a stopped browser's next start uses it. */
  readonly savedProxy: boolean;
  /** The machine answers (its feed is live): while it does not, nothing is read and the line says so. */
  readonly online?: boolean;
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
  useEffect(() => (online ? load() : undefined), [online, load]);

  const words = !online
    ? BROWSER_OFFLINE_WORDS
    : reading.kind === 'reading'
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
        <Button type="button" size="sm" data-browser-state-refresh="" disabled={!online} onClick={() => void load()}>
          Refresh
        </Button>
      </div>
      {online &&
      reading.kind === 'shown' &&
      reading.view.firewall !== undefined &&
      reading.view.firewall.state !== 'applied' ? (
        <SetupNote tone="warn" name="browser-firewall" title={FIREWALL_TITLES[reading.view.firewall.state]}>
          <p className="m-0 min-w-0 break-words">{reading.view.firewall.detail}</p>
        </SetupNote>
      ) : null}
    </SetupSection>
  );
}
