/**
 * THE INSTALL OFFER, in its two places (`lib/install-prompt.ts` decides when):
 *
 *   * a small dismissible banner on a phone — "Install Ferretry" with an Install button where the
 *     browser offered installation, or, on iOS, where to tap: Share › Add to Home Screen;
 *   * Settings › This device › Install app — always there, so "not now" is never "never".
 *
 * Plain words: "Install", "home screen", "app". Never "PWA", "manifest" or "service worker".
 */

import { Share, Smartphone, X } from 'lucide-react';
import { useState } from 'react';
import { useInstallPrompt } from '../../hooks/use-install-prompt.ts';
import {
  type InstallBannerKind,
  type InstallOutcome,
  installBanner,
  installSetting,
} from '../../lib/install-prompt.ts';
import { Button } from '../../shell/primitives.tsx';

/** The Share sheet steps, with the Share glyph inline because that glyph is what a reader looks for. */
function ShareSteps() {
  return (
    <>
      tap Share <Share aria-hidden="true" className="inline size-4 align-[-3px]" /> then{' '}
      <span className="font-semibold">Add to Home Screen</span>
    </>
  );
}

export interface InstallBannerProps {
  readonly kind: InstallBannerKind;
  readonly onInstall: () => void;
  readonly onDismiss: () => void;
}

export function InstallBanner({ kind, onInstall, onDismiss }: InstallBannerProps) {
  return (
    <div
      role="status"
      data-install-banner={kind}
      className="mx-1 mt-1 flex items-center gap-2 rounded-md border border-accent-border bg-accent-soft px-3 py-1.5 text-ui text-fg"
    >
      <Smartphone aria-hidden="true" className="size-4 shrink-0 text-accent" />
      <p className="m-0 min-w-0 flex-1 leading-tight">
        <span className="font-semibold">Install Ferretry</span>
        {kind === 'ios-hint' ? (
          <>
            {' — '}
            <ShareSteps />
          </>
        ) : (
          <span className="text-muted"> as an app</span>
        )}
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

/** The banner where one is due, on a phone only; nothing anywhere else. */
export function InstallBannerSlot({ phone }: { readonly phone: boolean }) {
  const view = useInstallPrompt();
  const kind = view === null ? null : installBanner(view.snapshot);
  if (!phone || view === null || kind === null) return null;
  return (
    <InstallBanner kind={kind} onDismiss={() => view.store.dismiss()} onInstall={() => void view.store.install()} />
  );
}

/** An accepted install needs no words of its own: the row turns into its "installed" state. */
type UnfinishedOutcome = Exclude<InstallOutcome, 'accepted'>;

const OUTCOME_WORDS: Readonly<Record<UnfinishedOutcome, string>> = {
  dismissed: 'Not installed. The browser can offer it again later.',
  unavailable: 'The browser withdrew its offer. Use its menu instead.',
};

/** Settings › This device › Install app. */
export function InstallAppSetting() {
  const view = useInstallPrompt();
  const [outcome, setOutcome] = useState<UnfinishedOutcome | null>(null);
  const state = view === null ? 'manual' : installSetting(view.snapshot);
  return (
    <div className="flex flex-col gap-2 text-ui leading-base" data-install-setting={state}>
      {state === 'installed' ? (
        <p className="m-0 text-fg">Ferretry is installed on this device. Open it from your home screen or app list.</p>
      ) : null}
      {state === 'prompt' ? (
        <div>
          {/* The setting's own description already says what installing gives; the row is just the act. */}
          <Button
            variant="primary"
            data-install-accept=""
            onClick={() => {
              void view?.store.install().then(result => setOutcome(result === 'accepted' ? null : result));
            }}
          >
            Install app
          </Button>
        </div>
      ) : null}
      {state === 'ios' ? (
        <p className="m-0 text-muted">
          On iPhone and iPad, <ShareSteps /> in the browser’s toolbar. Ferretry then opens from your home screen, full
          screen.
        </p>
      ) : null}
      {state === 'manual' ? (
        <p className="m-0 text-muted">
          This browser has not offered to install Ferretry. In Chrome or Edge, open the browser menu and choose{' '}
          <span className="font-semibold">Install app</span> or{' '}
          <span className="font-semibold">Add to Home screen</span>.
        </p>
      ) : null}
      {outcome === null ? null : (
        <p className="m-0 text-meta text-muted" role="status">
          {OUTCOME_WORDS[outcome]}
        </p>
      )}
    </div>
  );
}
