/**
 * THE INSTALL OFFER, in its two places (`lib/install-prompt.ts` decides when; the shell holds the browser's facts, S13):
 *
 *   * a `background` toast on a phone — a small dismissible line, "Install Ferretry", with an Install button where the
 *     browser offered installation, or, on iOS, where to tap: Share › Add to Home Screen. It is a DOCK
 *     (`.fy-status-dock`, shell.css): it docks at the bottom of the body, above the phone's bottom bar, and covers nothing; it never changes the app's height;
 *   * a `device.settings` panel — Settings › This device › Install app, always there, so "not now" is never "never".
 *
 * Plain words: "Install", "home screen", "app". Never "PWA", "manifest" or "service worker".
 */

import {
  type BackgroundViewProps,
  Button,
  type InstallOutcome,
  type InstallPrompt,
  SettingGroup,
  SettingRow,
  useDevicePaired,
  useInstallPrompt,
} from '@ferretry/app';
import { useLayoutMode } from '@ferretry/app/ui';
import { Share, Smartphone, X } from 'lucide-react';
import { type ReactNode, useEffect, useState, useSyncExternalStore } from 'react';
import {
  browserInstallStorage,
  InstallDismissal,
  type InstallSettingState,
  type InstallToastKind,
  type InstallWindow,
  installSetting,
  installToast,
  speaksForDevice,
} from '../lib/install-prompt.ts';

/** The one dismissal this device has, made when first needed so a page whose storage throws still starts. */
let dismissal: InstallDismissal | undefined;
const sharedDismissal = (): InstallDismissal => {
  dismissal ??= new InstallDismissal(browserInstallStorage(globalThis as unknown as InstallWindow));
  return dismissal;
};

/** The Share sheet steps, with the Share glyph inline because that glyph is what a reader looks for. */
function ShareSteps(): ReactNode {
  return (
    <>
      tap Share <Share aria-hidden="true" className="inline size-4 align-[-3px]" /> then{' '}
      <span className="font-semibold">Add to Home Screen</span>
    </>
  );
}

export interface InstallToastLineProps {
  readonly kind: InstallToastKind;
  readonly onInstall: () => void;
  readonly onDismiss: () => void;
}

/** The toast's line: what to do, an Install button where the browser offered one, and a way to say "not now". */
export function InstallToastLine({ kind, onInstall, onDismiss }: InstallToastLineProps): ReactNode {
  // A polite live region announces text that CHANGES inside it, so it mounts empty and its words arrive a moment later.
  const [spoken, setSpoken] = useState(false);
  useEffect(() => setSpoken(true), []);
  return (
    <div
      role="status"
      data-install-toast={kind}
      className="fy-status-dock flex items-center gap-2 rounded-md border border-accent-border bg-accent-soft px-3 py-1.5 text-ui text-fg shadow"
    >
      <Smartphone aria-hidden="true" className="size-4 shrink-0 text-accent" />
      <p className="m-0 min-w-0 flex-1 leading-tight">
        {spoken ? (
          <>
            <span className="font-semibold">Install Ferretry</span>
            {kind === 'ios-hint' ? (
              <>
                {' — '}
                <ShareSteps />
              </>
            ) : (
              <span className="text-muted"> as an app</span>
            )}
          </>
        ) : null}
      </p>
      {kind === 'prompt' ? (
        <Button size="sm" variant="primary" className="shrink-0" onClick={onInstall} data-install-accept="">
          Install
        </Button>
      ) : null}
      <Button
        aria-label="Dismiss — don’t offer to install again on this device"
        className="shrink-0"
        data-install-dismiss=""
        onClick={onDismiss}
        size="sm"
        title="Don’t offer again on this device"
        variant="ghost"
      >
        <X aria-hidden="true" className="size-4" />
      </Button>
    </div>
  );
}

export interface InstallToastProps {
  readonly prompt: InstallPrompt;
  readonly dismissed: boolean;
  readonly dismiss: () => void;
  /** Whether this is a phone: the toast is a phone's, and a bigger screen has the Settings row. */
  readonly phone: boolean;
  /** Whether this is the one machine whose view speaks for the device (the offer is the device's, not a machine's). */
  readonly speaksForDevice: boolean;
}

/** The toast where one is due; nothing anywhere else. */
export function InstallToastWhenDue({
  prompt,
  dismissed,
  dismiss,
  phone,
  speaksForDevice,
}: InstallToastProps): ReactNode {
  const kind = installToast(prompt, dismissed);
  if (!phone || !speaksForDevice || kind === null) return null;
  return <InstallToastLine kind={kind} onDismiss={dismiss} onInstall={() => void prompt.prompt()} />;
}

/**
 * The `background` view: the shell mounts it once per paired machine, but the offer belongs to this device, so only the
 * first paired machine's mount draws it.
 */
export function InstallToast({ daemon }: BackgroundViewProps): ReactNode {
  const prompt = useInstallPrompt();
  const held = sharedDismissal();
  const dismissed = useSyncExternalStore(held.subscribe, held.getSnapshot, held.getSnapshot);
  const phone = useLayoutMode() === 'drawer';
  const paired = useDevicePaired().daemons.map(machine => machine.daemon);
  return (
    <InstallToastWhenDue
      dismiss={held.dismiss}
      dismissed={dismissed}
      phone={phone}
      prompt={prompt}
      speaksForDevice={speaksForDevice(paired, daemon)}
    />
  );
}

/** An accepted install needs no words of its own: the row turns into its "installed" state. */
type UnfinishedOutcome = Exclude<InstallOutcome, 'accepted'>;

const OUTCOME_WORDS: Readonly<Record<UnfinishedOutcome, string>> = {
  dismissed: 'Not installed. The browser can offer it again later.',
  unavailable: 'The browser withdrew its offer. Use its menu instead.',
};

const INSTALL_HINT: Readonly<Record<InstallSettingState, string>> = {
  installed: 'Installed on this device',
  prompt: 'Add Ferretry to your home screen or app list',
  ios: 'Share › Add to Home Screen',
  manual: 'Not offered by this browser — use the browser menu › Install app',
};

/** Settings › This device › Install app, as one compact row. */
export function InstallAppRow({ prompt }: { readonly prompt: InstallPrompt }): ReactNode {
  const [outcome, setOutcome] = useState<UnfinishedOutcome | null>(null);
  const state = installSetting(prompt);
  return (
    <SettingGroup label="App">
      <SettingRow
        settingId="install-app"
        name="Install app"
        hint={INSTALL_HINT[state]}
        dataAttributes={{ 'data-install-setting': state }}
        explanation={
          <div className="flex flex-col gap-2">
            <p className="m-0">Open Ferretry from your home screen or app list, full screen, like any other app.</p>
            {state === 'installed' ? (
              <p className="m-0">Ferretry is installed on this device. Open it from your home screen or app list.</p>
            ) : null}
            {state === 'ios' ? (
              <p className="m-0">
                On iPhone and iPad, <ShareSteps /> in the browser’s toolbar. Ferretry then opens from your home screen,
                full screen.
              </p>
            ) : null}
            {state === 'manual' ? (
              <p className="m-0">
                This browser has not offered to install Ferretry. In Chrome or Edge, open the browser menu and choose{' '}
                <span className="font-semibold">Install app</span> or{' '}
                <span className="font-semibold">Add to Home screen</span>.
              </p>
            ) : null}
          </div>
        }
        control={() =>
          state === 'prompt' ? (
            <Button
              variant="primary"
              size="sm"
              className="min-h-[44px]"
              data-install-accept=""
              onClick={() => {
                void prompt.prompt().then(result => setOutcome(result === 'accepted' ? null : result));
              }}
            >
              Install
            </Button>
          ) : null
        }
      >
        {outcome === null ? null : (
          <p className="m-0 px-panel pb-3 text-meta text-muted" role="status">
            {OUTCOME_WORDS[outcome]}
          </p>
        )}
      </SettingRow>
    </SettingGroup>
  );
}

/** The `device.settings` panel (no daemon, no client): the shell's install prompt, drawn as a row. */
export function InstallAppPanel(): ReactNode {
  return <InstallAppRow prompt={useInstallPrompt()} />;
}
