import type { BrowserStateView } from '@ferretry/protocol';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../../shell/primitives.tsx';
import type { SetupAccess } from '../setup/setup-access.ts';
import { SetupSection } from '../setup/setup-ui.tsx';
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

type Reading =
  | { readonly kind: 'reading' }
  | { readonly kind: 'shown'; readonly view: BrowserStateView }
  | { readonly kind: 'unavailable' };

/** "Status": is the shared browser running, and is it going through the proxy? */
export function BrowserStateLine({
  access,
  online,
  savedProxy,
}: {
  readonly access: SetupAccess;
  readonly online: boolean;
  /** A proxy is saved, so a stopped browser's next start uses it. */
  readonly savedProxy: boolean;
}) {
  const { read } = access;
  const [reading, setReading] = useState<Reading>({ kind: 'reading' });
  const load = useCallback((): (() => void) => {
    let current = true;
    setReading({ kind: 'reading' });
    void read(client => readBrowserState(client)).then(result => {
      if (!current) return;
      setReading(result.kind === 'done' ? { kind: 'shown', view: result.value } : { kind: 'unavailable' });
    });
    return () => {
      current = false;
    };
  }, [read]);
  useEffect(() => (online ? load() : undefined), [online, load]);

  const words = !online
    ? 'Offline · the status shows once this machine answers.'
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
    </SetupSection>
  );
}
