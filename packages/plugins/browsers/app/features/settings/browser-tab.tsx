/**
 * The Browser tab (docs/browser-mode.md, docs/browser-proxy.md): the machine's one shared browser, in one place.
 *
 * - **Status** — whether it is running, and whether its traffic goes through the proxy.
 * - **Browser mode** — Headless, or a Real window an owner browses through.
 * - **Browser proxy** — where its traffic goes, with secret-store credentials, and **Test proxy**.
 * - **User agent** — what the browser says about itself, and nothing more than is true.
 *
 * The mode and the proxy live in `browsers.yaml`, read and written through the kernel's config file service. Until a
 * machine serves that service the tab says so and shows what it can: the status and the user agent.
 */

import { useCallback, useEffect, useState } from 'react';
import type { BrowserMode, BrowserProxySetting } from '../../../contract/index.ts';
import { type CallClient, reasonOf } from '../../lib/clients.ts';
import {
  type BrowsersChange,
  type BrowsersDocument,
  readBrowsersConfig,
  writeBrowsersConfig,
} from '../../lib/browsers-config.ts';
import { BrowserModeSection, type SaveOutcome } from './browser-mode-section.tsx';
import { BrowserProxySection } from './browser-proxy-section.tsx';
import { BrowserStateLine } from './browser-state-line.tsx';
import { SetupNote, SetupSection } from './setup-ui.tsx';

/** Honest about the one thing the browser changes about itself. */
export const BROWSER_USER_AGENT_WORDS =
  'A headless browser announces itself with “HeadlessChrome” in its user agent. This browser sends the ordinary Chrome user agent instead, without that token. Nothing else about it is changed.';

type Reading =
  | { readonly kind: 'reading' }
  | { readonly kind: 'shown'; readonly document: BrowsersDocument }
  | { readonly kind: 'unavailable'; readonly sentence: string };

export function BrowserTab({ client }: { readonly client: CallClient }) {
  const [reading, setReading] = useState<Reading>({ kind: 'reading' });
  const load = useCallback((): (() => void) => {
    let current = true;
    readBrowsersConfig(client).then(
      document => {
        if (current) setReading({ kind: 'shown', document });
      },
      (caught: unknown) => {
        if (current) setReading({ kind: 'unavailable', sentence: reasonOf(caught) });
      },
    );
    return () => {
      current = false;
    };
  }, [client]);
  useEffect(() => load(), [load]);

  // One write at a time, against the digest it was read at; a write that took re-reads so the next one has a fresh digest.
  const save = useCallback(
    async (change: BrowsersChange): Promise<SaveOutcome> => {
      if (reading.kind !== 'shown')
        return { kind: 'refused', sentence: 'This machine’s browser settings are not loaded.' };
      try {
        await writeBrowsersConfig(client, reading.document, change);
      } catch (caught) {
        return { kind: 'refused', sentence: reasonOf(caught) };
      }
      load();
      return { kind: 'saved' };
    },
    [client, reading, load],
  );

  return (
    <div className="flex min-w-0 flex-col gap-5" data-browser-tab="">
      <BrowserStateLine
        client={client}
        savedProxy={reading.kind === 'shown' && reading.document.config.proxy !== undefined}
      />
      {reading.kind === 'reading' ? (
        <p role="status" className="m-0 text-cell text-muted" data-browser-tab-waiting="">
          Checking this machine’s browser settings…
        </p>
      ) : reading.kind === 'unavailable' ? (
        <SetupNote tone="warn" name="browser-settings-unavailable" title="This machine’s browser settings did not load">
          <span data-browser-settings-reason="">{reading.sentence}</span>
        </SetupNote>
      ) : (
        <>
          <BrowserModeSection
            key={reading.document.config.mode}
            mode={reading.document.config.mode}
            save={(mode: BrowserMode) => save({ mode })}
          />
          <BrowserProxySection
            key={JSON.stringify(reading.document.config.proxy ?? null)}
            client={client}
            saved={reading.document.config.proxy ?? null}
            save={(proxy: BrowserProxySetting | null) => save({ proxy })}
          />
        </>
      )}
      <SetupSection title="User agent" name="browser-user-agent">
        <p className="m-0 text-meta leading-base text-muted" data-browser-user-agent="">
          {BROWSER_USER_AGENT_WORDS}
        </p>
      </SetupSection>
    </div>
  );
}
