/**
 * ONE DISMISSIBLE LINE after pairing: this device holds no passkey for this machine, and Settings →
 * Security is where to add one (`docs/design/zero-trust.md` B2).
 *
 * Read ONCE per machine load, with no timer: a nudge that polled would re-ask the machine for a fact
 * that only changes when somebody acts. It is shown only where the press would work — a machine whose
 * registration window is `closed` offers nothing to do, and a line pointing at a dead end is worse than
 * silence. A failed read shows nothing for the same reason. A dismissal is remembered per machine, in
 * storage that is allowed to throw.
 */

import { Fingerprint, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { DaemonConnection } from '../../lib/daemon-connection.ts';
import {
  browserNudgeStorage,
  dismissPasskeyNudge,
  type NudgeStorage,
  passkeyNudgeDismissed,
} from '../../lib/passkey-panel.ts';
import { fetchPasskeys } from '../../lib/step-up-client.ts';
import { useDaemonClient } from '../../lib/store.tsx';
import type { PasskeyClientFactory } from './security-settings.tsx';

export interface PasskeyNudgeProps {
  readonly connection: DaemonConnection;
  /** Opens Settings → Daemons → Security for this machine. */
  readonly onOpenSecurity: () => void;
  readonly createClient?: PasskeyClientFactory;
  readonly storage?: () => NudgeStorage | undefined;
}

export function PasskeyNudge({
  connection,
  onOpenSecurity,
  createClient: injectedClient,
  storage = browserNudgeStorage,
}: PasskeyNudgeProps) {
  const routedClient = useDaemonClient();
  const createClient = injectedClient ?? routedClient;
  const [dismissed, setDismissed] = useState(() => passkeyNudgeDismissed(storage(), connection.daemonId));
  const [wanted, setWanted] = useState(false);

  useEffect(() => {
    let current = true;
    setWanted(false);
    const already = passkeyNudgeDismissed(storage(), connection.daemonId);
    setDismissed(already);
    if (already) return;
    void createClient(connection)
      .then(async client => await fetchPasskeys(client))
      .then(view => {
        if (current) setWanted(view.passkeys.length === 0 && view.registration !== 'closed');
      })
      // A machine that cannot answer, or answers something else, is a nudge that stays quiet.
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [connection, createClient, storage]);

  if (!wanted || dismissed) return null;
  return (
    <div
      role="status"
      data-passkey-nudge={String(connection.daemonId)}
      className="mx-auto mt-2 flex w-full max-w-[1320px] min-w-0 items-center gap-2 rounded-control border border-border-strong bg-surface-2 px-3 py-1"
    >
      <Fingerprint size={16} className="shrink-0 text-accent" aria-hidden="true" />
      <p className="m-0 min-w-0 flex-1 text-cell leading-base text-fg">
        This device has no passkey for this machine yet.{' '}
        <button
          type="button"
          data-passkey-nudge-open=""
          onClick={onOpenSecurity}
          className="min-h-[44px] bg-transparent p-0 text-left font-semibold text-accent underline"
        >
          Settings → Daemons → Security → Add a passkey
        </button>
      </p>
      <button
        type="button"
        aria-label="Dismiss this reminder"
        data-passkey-nudge-dismiss=""
        onClick={() => {
          dismissPasskeyNudge(storage(), connection.daemonId);
          setDismissed(true);
        }}
        className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-control text-muted hover:bg-surface hover:text-fg"
      >
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
