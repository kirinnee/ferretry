/**
 * The status strip of the daemon-global human browser-login window: what it is doing, how long it has left, and the
 * two explicit ways to close it. (v4's `BrowserLoginBanner`.)
 *
 * It is a CONTROLLED view: it owns no transport, poll or cache. The panel reads the status from the daemon's own
 * `DaemonBrowserLoginStore` and binds `onClose` to that one daemon, so nothing here can outlive a daemon switch.
 *
 * The open window's connection data is a live credential (a VNC port and password). It is drawn only inside the
 * collapsed "Connection details" disclosure of the open state, never in the `aria-live` status line, never in a
 * title or attribute, and never stored: it lives in the props for as long as the store holds the snapshot.
 */

import { Button } from '@ferretry/app/ui';
import { ChevronDown, Copy, KeyRound, ShieldAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { BrowserLoginSnapshot } from '../../lib/browser-login.ts';

/** `m:ss` until the window closes itself, or a plain "expiry unknown" when the time cannot be read. */
export function browserLoginRemaining(expiresAt: string | undefined, now = Date.now()): string {
  if (expiresAt === undefined) return 'expiry unknown';
  const milliseconds = Date.parse(expiresAt) - now;
  if (!Number.isFinite(milliseconds)) return 'expiry unknown';
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function CopyLine({ label, value }: { readonly label: string; readonly value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      // Clipboard access is not guaranteed (a restrictive iframe, a denied permission): the action stays available.
      setCopied(false);
    }
  };

  return (
    <div className="grid min-w-max grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-xs py-1">
      <span className="font-medium text-muted">{label}</span>
      <code className="select-all font-mono text-meta text-fg">{value}</code>
      <Button type="button" variant="ghost" size="sm" onClick={() => void copy()} className="min-h-[32px] px-2">
        <Copy size={13} aria-hidden="true" />
        <span>{copied ? 'Copied' : 'Copy'}</span>
      </Button>
    </div>
  );
}

export interface BrowserLoginBannerProps {
  /** `null` is "not read yet": nothing is drawn, because it is not known to be open. */
  readonly status: BrowserLoginSnapshot | null;
  /** Bound by the host to the one daemon whose window this is. `primed` is the person's own "I signed in". */
  readonly onClose: (primed: boolean) => Promise<BrowserLoginSnapshot>;
  /** A frozen clock, for deterministic tests. */
  readonly now?: number;
}

export function BrowserLoginBanner({ status, onClose, now: fixedNow }: BrowserLoginBannerProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [liveNow, setLiveNow] = useState(() => Date.now());

  useEffect(() => {
    if (fixedNow !== undefined) return undefined;
    const interval = setInterval(() => setLiveNow(Date.now()), 1_000);
    return () => clearInterval(interval);
  }, [fixedNow]);

  // A closed window draws nothing. A FAILED read is not closed: it says so below, rather than looking like no banner.
  if (status === null || status.state === 'closed') return null;

  const close = async (primed: boolean): Promise<void> => {
    setBusy(true);
    try {
      await onClose(primed);
    } finally {
      setBusy(false);
      setMenuOpen(false);
    }
  };

  if (status.state !== 'open') {
    const detail = status.state === 'unknown' || status.state === 'error' ? status.error : undefined;
    const words =
      status.state === 'unknown'
        ? `Browser login status unknown · ${detail}`
        : detail === undefined
          ? `Browser login ${status.state}`
          : `Browser login ${status.state} · ${detail}`;
    return (
      <aside
        role="status"
        aria-live="polite"
        className="shrink-0 border-b border-warn/30 bg-warn-soft px-panel py-1.5 text-ui text-warn"
      >
        <span className="flex min-w-0 items-center gap-xs">
          <ShieldAlert size={15} aria-hidden="true" className="shrink-0" />
          <span className="truncate">{words}</span>
        </span>
      </aside>
    );
  }

  const { connection } = status;
  return (
    <aside
      className="shrink-0 border-b border-warn/30 bg-warn-soft px-panel py-1.5 text-ui text-warn"
      aria-label="Browser login window"
    >
      <div className="flex min-w-0 items-center gap-xs">
        <KeyRound size={15} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 flex-1 truncate font-medium">
          Browser login window open · closes in {browserLoginRemaining(status.expiresAt, fixedNow ?? liveNow)}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => setMenuOpen(value => !value)}
          aria-expanded={menuOpen}
          className="min-h-[32px] shrink-0 border-warn/40 bg-surface px-2 text-warn hover:text-fg"
        >
          Close <ChevronDown size={13} aria-hidden="true" />
        </Button>
      </div>
      {menuOpen && (
        <fieldset className="mt-1 grid gap-xs border-t border-warn/30 pt-1" aria-label="Close browser login window">
          <Button
            type="button"
            variant="primary"
            disabled={busy}
            onClick={() => void close(true)}
            className="min-h-[44px] justify-center"
          >
            Close — I signed in
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => void close(false)}
            className="min-h-[44px] justify-center"
          >
            Close — not signed in
          </Button>
        </fieldset>
      )}
      <details className="mt-1 border-t border-warn/30 pt-1 text-fg">
        <summary className="cursor-pointer select-none text-meta font-medium text-warn">Connection details</summary>
        <div className="mt-1 max-h-36 overflow-auto rounded-control border border-warn/30 bg-surface px-2 py-1">
          <CopyLine label="VNC" value={`${connection.host}:${connection.port}`} />
          <CopyLine label="Password" value={connection.password} />
          <CopyLine label="SSH" value={connection.sshTunnel} />
        </div>
      </details>
    </aside>
  );
}
