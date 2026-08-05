import { Bot, CircleAlert, CircleDashed, KeyRound, Layers3, ShieldQuestion, Sparkles } from 'lucide-react';

import { cn } from '../../lib/class-names.ts';
import type { DaemonId } from '../../lib/daemon-connection.ts';
import {
  defaultFleetHarness,
  type FleetAccountView,
  type FleetHarnessKind,
  type FleetHarnessView,
  type FleetReadState,
  fleetHarnessLabel,
} from './fleet-model.ts';

export interface FleetSurfaceProps {
  /** The only daemon whose fleet this surface may render. */
  readonly daemonId: DaemonId;
  /** A missing or damaged read stays unavailable; it is never rendered as zero accounts. */
  readonly state: FleetReadState;
  className?: string;
}

const harnessTone = (kind: FleetHarnessKind): string =>
  kind === 'claude' ? 'border-accent bg-accent-soft text-accent' : 'border-border bg-surface-2 text-fg';

const accountsFor = (accounts: readonly FleetAccountView[], harness: FleetHarnessKind): readonly FleetAccountView[] =>
  accounts.filter(account => account.harness === harness);

function AccountRow({ account }: { readonly account: FleetAccountView }) {
  return (
    <li className="flex min-w-0 items-start justify-between gap-3 border-t border-border-soft py-3 first:border-t-0 first:pt-0">
      <div className="min-w-0">
        <p className="m-0 truncate text-ui font-semibold text-fg">{account.label}</p>
        <code className="mt-0.5 block truncate font-mono text-meta text-muted">{account.wrapper}</code>
      </div>
      <span
        className={cn(
          'shrink-0 rounded-full border px-2 py-0.5 text-meta font-medium',
          account.available ? 'border-border bg-surface text-muted' : 'border-warn-border bg-warn-bg text-warn',
        )}
      >
        {account.available ? 'Published' : 'Unavailable'}
      </span>
      {!account.available && account.unavailableReason ? (
        <span className="sr-only">{account.unavailableReason}</span>
      ) : null}
    </li>
  );
}

function HarnessCard({
  harness,
  accounts,
  preferred,
}: {
  readonly harness: FleetHarnessView;
  readonly accounts: readonly FleetAccountView[];
  readonly preferred: FleetHarnessKind | undefined;
}) {
  const label = fleetHarnessLabel(harness.kind);
  const ready = harness.launchable.length > 0;
  return (
    <section
      className="kt-panel overflow-hidden"
      data-fleet-harness={harness.kind}
      aria-labelledby={`fleet-${harness.kind}`}
    >
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-3 border-b border-border-soft bg-surface-2 px-panel py-3">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-control border',
              harnessTone(harness.kind),
            )}
          >
            <Bot size={18} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h2 id={`fleet-${harness.kind}`} className="m-0 text-title font-semibold text-fg">
              {label}
            </h2>
            <p className="m-0 text-meta text-muted">
              {ready
                ? `${harness.launchable.length} wrapper${harness.launchable.length === 1 ? '' : 's'} found on PATH`
                : 'No launchable wrapper found'}
            </p>
          </div>
        </div>
        {preferred === harness.kind ? (
          <span className="inline-flex min-h-[28px] items-center gap-1 rounded-full border border-accent bg-accent-soft px-2 text-meta font-semibold text-accent">
            <Sparkles size={13} aria-hidden="true" />
            Default
          </span>
        ) : null}
      </header>

      <div className="p-panel">
        {harness.launchable.length > 0 ? (
          <p className="m-0 flex items-start gap-2 text-ui leading-base text-muted">
            <KeyRound size={16} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
            Found locally. Sign-in and provider access have not been verified.
          </p>
        ) : null}
        {harness.blocked.length > 0 ? (
          <ul className="mt-3 list-none space-y-2 p-0" aria-label={`${label} launch blockers`}>
            {harness.blocked.map(reason => (
              <li
                key={reason}
                className="flex gap-2 rounded-control border border-warn-border bg-warn-bg px-3 py-2 text-ui leading-base text-warn"
              >
                <CircleAlert size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
                {reason}
              </li>
            ))}
          </ul>
        ) : null}
        <div className="mt-4">
          <p className="mb-2 text-meta font-semibold uppercase tracking-label text-faint">Published accounts</p>
          {accounts.length > 0 ? (
            <ul className="m-0 list-none p-0" aria-label={`${label} accounts`}>
              {accounts.map(account => (
                <AccountRow key={account.id} account={account} />
              ))}
            </ul>
          ) : (
            <p className="m-0 rounded-control border border-dashed border-border px-3 py-2 text-ui text-muted">
              No {label} account is published for this daemon.
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

/**
 * Read-only first Fleet pass. It deliberately has no provisioning controls
 * until the daemon exposes a mutation boundary that can materialise wrappers
 * without turning a browser click into an ambient host filesystem write.
 */
export function FleetSurface({ daemonId, state, className }: FleetSurfaceProps) {
  if (state.kind === 'unavailable') {
    return (
      <section
        data-fleet-surface="unavailable"
        data-fleet-daemon-id={String(daemonId)}
        aria-labelledby="fleet-heading"
        className={cn('kt-panel border-warn-border p-panel', className)}
      >
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-control border border-warn-border bg-warn-bg text-warn">
            <ShieldQuestion size={20} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <h1 id="fleet-heading" className="m-0 font-display text-title font-bold tracking-display text-fg">
              Fleet inventory is unavailable
            </h1>
            <p className="mb-0 mt-1 text-ui leading-base text-muted">{state.reason}</p>
          </div>
        </div>
      </section>
    );
  }

  const preferred = defaultFleetHarness(state.harnesses);
  return (
    <section
      data-fleet-surface="available"
      data-fleet-daemon-id={String(daemonId)}
      aria-labelledby="fleet-heading"
      className={cn('space-y-3', className)}
    >
      <header className="kt-panel overflow-hidden">
        <div className="border-b border-border-soft bg-surface-2 px-panel py-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control border border-accent bg-accent-soft text-accent">
              <Layers3 size={18} aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <h1 id="fleet-heading" className="m-0 font-display text-title font-bold tracking-display text-fg">
                Fleet
              </h1>
              <p className="m-0 text-ui text-muted">Accounts and wrappers published on this daemon.</p>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 px-panel py-3 text-ui text-muted">
          <CircleDashed size={16} className="shrink-0 text-accent" aria-hidden="true" />
          {preferred === undefined
            ? 'No default: this daemon has no wrapper it can launch.'
            : `${fleetHarnessLabel(preferred)} is the default when a harness is not specified.`}
        </div>
      </header>
      <div className="grid min-w-0 gap-3 xl:grid-cols-2">
        {state.harnesses.map(harness => (
          <HarnessCard
            key={harness.kind}
            harness={harness}
            accounts={accountsFor(state.accounts, harness.kind)}
            preferred={preferred}
          />
        ))}
      </div>
    </section>
  );
}
