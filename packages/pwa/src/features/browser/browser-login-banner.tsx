/**
 * Short-lived browser-login status, ported from kteam's BrowserLoginBanner.
 *
 * The connection data is supplied at runtime by the selected daemon. This is
 * deliberately a controlled component: it owns no transport, polling timer,
 * or module cache that could accidentally survive a daemon switch. Its host
 * supplies an action already bound to one `DaemonConnection`.
 */

import { useEffect, useState } from 'react';
import { ChevronDown, Copy, KeyRound, ShieldAlert } from 'lucide-react';
import { Button } from '../../shell/primitives.tsx';

export type BrowserLoginState = 'closed' | 'opening' | 'open' | 'closing' | 'error';

export interface BrowserLoginStatus {
  readonly state: BrowserLoginState;
  readonly profilePrimed: boolean;
  readonly expiresAt?: string;
  readonly connection?: {
    readonly host: string;
    readonly port: number;
    readonly password: string;
    readonly sshTunnel: string;
  };
  readonly error?: string;
}

/** A failed status read must not be represented as a closed login window. */
export type BrowserLoginView = BrowserLoginStatus | { readonly state: 'unknown'; readonly error: string };

export function browserLoginRemaining(expiresAt: string | undefined, now = Date.now()): string {
  if (expiresAt === undefined) return 'expiry unknown';
  const milliseconds = Date.parse(expiresAt) - now;
  if (!Number.isFinite(milliseconds)) return 'expiry unknown';
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

async function copyText(value: string): Promise<void> {
  await navigator.clipboard.writeText(value);
}

function CopyLine({ label, value }: { readonly label: string; readonly value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await copyText(value);
      setCopied(true);
    } catch {
      // Clipboard access is not guaranteed (for example in a restrictive
      // iframe); leaving the action available is more useful than an error.
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
  readonly status: BrowserLoginView | null;
  /** Bound by the host to the currently selected daemon connection. */
  readonly onClose: (primed: boolean) => Promise<BrowserLoginView>;
  /** A frozen clock is useful to deterministic visual harnesses. */
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

  if (status === null || status.state === 'closed') return null;
  const open = status.state === 'open';
  const close = async (primed: boolean) => {
    setBusy(true);
    try {
      await onClose(primed);
    } finally {
      setBusy(false);
      setMenuOpen(false);
    }
  };

  if (!open) {
    const copy =
      status.state === 'unknown' ? `Browser login status unknown · ${status.error}` : `Browser login ${status.state}`;
    return (
      <aside
        role="status"
        aria-live="polite"
        className="shrink-0 border-b border-warn/30 bg-warn-soft px-panel py-1.5 text-ui text-warn"
      >
        <span className="flex min-w-0 items-center gap-xs">
          <ShieldAlert size={15} aria-hidden="true" className="shrink-0" />
          <span className="truncate">{copy}</span>
        </span>
      </aside>
    );
  }

  const connection = status.connection;
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
      {connection !== undefined && (
        <details className="mt-1 border-t border-warn/30 pt-1 text-fg">
          <summary className="cursor-pointer select-none text-meta font-medium text-warn">Connection details</summary>
          <div className="mt-1 max-h-36 overflow-auto rounded-control border border-warn/30 bg-surface px-2 py-1">
            <CopyLine label="VNC" value={`${connection.host}:${connection.port}`} />
            <CopyLine label="Password" value={connection.password} />
            <CopyLine label="SSH" value={connection.sshTunnel} />
          </div>
        </details>
      )}
    </aside>
  );
}
