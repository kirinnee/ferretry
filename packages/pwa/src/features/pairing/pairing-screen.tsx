/**
 * The public PWA's runtime pairing surface.
 *
 * A daemon address and device credential never come from the static bundle:
 * the host exchanges a one-time pairing link, then owns persistence in the
 * daemon connection registry. This screen deliberately sees only the
 * resulting connection metadata and an injected exchange callback.
 */
import { Check, Link2, Radio, Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';

import type { DaemonConnectionRecord } from '../../lib/connections.ts';
import type { DaemonId } from '../../lib/daemon-connection.ts';
import { pairingSeedFromUrl, type PairingSeed } from '../../lib/pairing.ts';

export type PairingExchange = (seed: PairingSeed) => Promise<void>;

export interface PairingScreenProps {
  /** Existing pairings from the host-owned, browser-local registry. */
  readonly connections: readonly DaemonConnectionRecord[];
  readonly selectedDaemonId: DaemonId | null;
  /** Exchanges the one-time code and adds the resulting connection. */
  readonly onPair: PairingExchange;
  readonly onSelect: (daemonId: DaemonId) => void;
  readonly onRemove: (daemonId: DaemonId) => void;
}

const connectionName = (connection: DaemonConnectionRecord): string => connection.label ?? String(connection.daemonId);

/**
 * A connection picker for a public, statically hosted PWA. Pairing links are
 * submitted by the reader; their code is parsed but never rendered or kept
 * after an exchange begins.
 */
export function PairingScreen({ connections, selectedDaemonId, onPair, onSelect, onRemove }: PairingScreenProps) {
  const [link, setLink] = useState('');
  const [status, setStatus] = useState<'idle' | 'pairing' | 'paired'>('idle');
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setError(null);
    let seed: PairingSeed;
    try {
      seed = pairingSeedFromUrl(link.trim());
    } catch (reason) {
      setStatus('idle');
      setError(reason instanceof Error ? reason.message : 'The pairing link could not be read.');
      return;
    }

    // The fragment carries a single-use secret. Remove it from the rendered
    // control before awaiting the host's network exchange.
    setLink('');
    setStatus('pairing');
    try {
      await onPair(seed);
      setStatus('paired');
    } catch (reason) {
      setStatus('idle');
      setError(reason instanceof Error ? reason.message : 'Could not pair with that daemon.');
    }
  };

  return (
    <main
      className="mx-auto flex min-h-full w-full max-w-[680px] flex-col gap-4 py-4 pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] sm:py-8"
      aria-labelledby="pairing-title"
    >
      <header className="min-w-0">
        <div className="flex items-center gap-2 text-accent">
          <Radio size={20} aria-hidden="true" />
          <span className="text-meta font-semibold uppercase tracking-label">Ferretry</span>
        </div>
        <h1 id="pairing-title" className="mt-2 font-display text-display font-bold tracking-display text-fg">
          Connect a daemon
        </h1>
        <p className="m-0 max-w-prose text-ui leading-base text-muted">
          Paste a pairing link from a daemon you control. The link is exchanged at runtime; this public app never ships
          with a daemon address or device credential.
        </p>
      </header>

      <section className="kt-panel p-panel" aria-labelledby="pair-link-title">
        <div className="flex items-start gap-2">
          <Link2 size={18} className="mt-0.5 shrink-0 text-accent" aria-hidden="true" />
          <div>
            <h2 id="pair-link-title" className="m-0 text-title font-semibold text-fg">
              Pair a new daemon
            </h2>
            <p className="m-0 text-ui leading-base text-muted">
              Pairing links are single-use. They are not saved in this field.
            </p>
          </div>
        </div>
        <form className="mt-3 flex flex-col gap-2" onSubmit={event => void submit(event)}>
          <label className="flex flex-col gap-1 text-ui font-medium text-fg" htmlFor="pairing-link">
            Pairing link
            <input
              id="pairing-link"
              aria-label="Pairing link"
              aria-describedby="pairing-link-help pairing-link-error"
              autoCapitalize="none"
              autoComplete="off"
              className="h-control w-full rounded-control border border-border bg-surface-2 px-control-x font-mono text-meta text-fg placeholder:text-faint focus:border-accent"
              onChange={event => setLink(event.target.value)}
              placeholder="https://app.example/#v1;…"
              spellCheck={false}
              value={link}
            />
          </label>
          <p id="pairing-link-help" className="m-0 text-meta leading-base text-faint">
            Check the daemon identity before sharing a link. You can keep more than one daemon paired.
          </p>
          {error && (
            <p id="pairing-link-error" className="m-0 text-ui text-err" role="alert">
              {error}
            </p>
          )}
          <button
            type="submit"
            className="kt-btn min-h-[44px] self-start"
            data-variant="primary"
            disabled={status === 'pairing' || link.trim() === ''}
          >
            <Link2 size={16} aria-hidden="true" />
            {status === 'pairing' ? 'Pairing…' : 'Pair daemon'}
          </button>
          {status === 'paired' && (
            <p className="m-0 text-ui text-ok" role="status">
              Daemon paired. It is now available in your fleet.
            </p>
          )}
        </form>
      </section>

      <section className="kt-panel p-panel" aria-labelledby="paired-daemons-title">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 id="paired-daemons-title" className="m-0 text-title font-semibold text-fg">
              Paired daemons
            </h2>
            <p className="m-0 text-ui leading-base text-muted">
              Choose where this tab should work. Each daemon keeps separate data.
            </p>
          </div>
          <div className="rounded-badge bg-surface-2 px-badge-x py-0.5 font-mono text-meta text-muted">
            <span aria-hidden="true">{connections.length}</span>
            <span className="sr-only">{connections.length} paired daemons</span>
          </div>
        </div>
        {connections.length === 0 ? (
          <p className="mb-0 mt-3 rounded-control border border-dashed border-border bg-surface-2 p-3 text-ui leading-base text-muted">
            No daemons are paired yet. Use a one-time pairing link above to get started.
          </p>
        ) : (
          <ul className="mb-0 mt-3 flex list-none flex-col gap-2 p-0" aria-label="Paired daemons">
            {connections.map(connection => {
              const selected = connection.daemonId === selectedDaemonId;
              const name = connectionName(connection);
              return (
                <li
                  key={connection.daemonId}
                  className="flex min-h-[44px] flex-wrap items-center gap-2 rounded-control border border-border bg-surface-2 px-control-x py-2"
                >
                  <button
                    type="button"
                    className="flex min-h-[44px] min-w-0 flex-1 items-center gap-2 text-left hover:text-accent focus-visible:outline-focus focus-visible:outline-offset-focus"
                    aria-current={selected ? 'true' : undefined}
                    onClick={() => onSelect(connection.daemonId)}
                  >
                    <span
                      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ${selected ? 'border-accent bg-accent text-accent-fg' : 'border-border-strong text-transparent'}`}
                      aria-hidden="true"
                    >
                      <Check size={13} strokeWidth={3} />
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-ui font-semibold text-fg">{name}</span>
                      <span className="block truncate font-mono text-meta text-faint">{connection.baseUrl}</span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="min-h-[44px] rounded-control px-2 text-ui font-semibold text-warn hover:bg-warn-bg focus-visible:outline-focus focus-visible:outline-offset-focus"
                    aria-label={`Forget ${name}`}
                    onClick={() => onRemove(connection.daemonId)}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                    <span className="sr-only">Forget</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
