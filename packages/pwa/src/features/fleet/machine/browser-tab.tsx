/**
 * The Browser tab (docs/browser-mode.md, docs/browser-proxy.md): the machine's one shared browser, in one place.
 *
 * - **Status** — whether it is running, and whether its traffic goes through the proxy.
 * - **Browser mode** — Headless, or a Real window an owner browses through.
 * - **Browser proxy** — where its traffic goes, with secret-store credentials, and **Test proxy**.
 * - **User agent** — what the browser says about itself, and nothing more than is true.
 */

import { useSetupAccess } from '../setup/setup-access.ts';
import { SetupSection } from '../setup/setup-ui.tsx';
import type { MachineTabProps } from '../shell/machines-surface.tsx';
import { BrowserModeSection } from './browser-mode-section.tsx';
import { BrowserProxySection } from './browser-proxy-section.tsx';
import { BrowserStateLine } from './browser-state-line.tsx';

/** Honest about the one thing the browser changes about itself. */
export const BROWSER_USER_AGENT_WORDS =
  'A headless browser announces itself with “HeadlessChrome” in its user agent. This browser sends the ordinary Chrome user agent instead, without that token. Nothing else about it is changed.';

export function BrowserTab(props: MachineTabProps) {
  const { machine, machineName, online, checking, connection, createClient, onRetry } = props;
  // A save re-reads the machine quietly, so the sections being edited are not swapped for "Checking…".
  const onSaved = props.onRefresh ?? onRetry;
  const access = useSetupAccess({ connection, createClient });

  if (machine === null)
    return (
      <p role="status" className="m-0 text-cell text-muted" data-browser-tab-waiting="">
        {checking ? `Checking ${machineName}…` : `${machineName}’s browser settings show once it answers.`}
      </p>
    );

  return (
    <div className="flex min-w-0 flex-col gap-5" data-browser-tab="">
      <BrowserStateLine access={access} online={online} savedProxy={machine.browserProxy != null} />
      <BrowserModeSection
        key={machine.browserMode ?? 'headless'}
        machine={machine}
        machineName={machineName}
        access={access}
        onSaved={onSaved}
      />
      <BrowserProxySection
        key={JSON.stringify(machine.browserProxy ?? null)}
        machine={machine}
        machineName={machineName}
        access={access}
        onSaved={onSaved}
        online={online}
      />
      <SetupSection title="User agent" name="browser-user-agent">
        <p className="m-0 text-meta leading-base text-muted" data-browser-user-agent="">
          {BROWSER_USER_AGENT_WORDS}
        </p>
      </SetupSection>
    </div>
  );
}
