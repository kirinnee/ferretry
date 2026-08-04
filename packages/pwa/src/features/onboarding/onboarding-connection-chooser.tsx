/** The second chooser: a connection is a route, not a hidden setting. */

import { ChevronRight, Cloud, Network, Radio } from 'lucide-react';
import type { ReactNode } from 'react';

import {
  type HostedRelayFallback,
  HOSTED_RELAY_DISABLED_NOTE,
  HOSTED_RELAY_DISCLOSURE,
  HOSTED_RELAY_ROW_NOTE,
  HOSTED_RELAY_UNDETERMINED_NOTE,
  TRANSPORT_NOT_WIRED_NOTE,
} from './hosted-relay.ts';
import { CONNECTION_METHODS, type ConnectionMethodId } from './onboarding-model.ts';

const ICON: Record<ConnectionMethodId, ReactNode> = {
  'default-relay': <Cloud size={22} aria-hidden="true" />,
  'own-relay': <Radio size={22} aria-hidden="true" />,
  direct: <Network size={22} aria-hidden="true" />,
};

const ROW =
  'flex w-full min-w-0 items-center gap-3 rounded-control border border-border bg-surface-2 px-3 py-3 text-left transition-colors hover:border-accent hover:bg-accent-bg focus-visible:outline-focus focus-visible:outline-offset-focus';

export interface OnboardingConnectionChooserProps {
  readonly onChoose: (connection: ConnectionMethodId) => void;
  /**
   * What the runtime advertisement said about the default relay.
   *
   * A live fact, not a constant: its operator can withdraw it between a release
   * and a reader arriving, so the recommended row has to be able to say it is
   * switched off — and to say when this page could not find out, which is neither
   * available nor off.
   */
  readonly fallback: HostedRelayFallback;
}

export function OnboardingConnectionChooser({ onChoose, fallback }: OnboardingConnectionChooserProps) {
  return (
    <div
      className="flex min-w-0 flex-col gap-2"
      data-onboarding-connection-chooser=""
      data-onboarding-fallback={fallback.kind}
    >
      <p className="m-0 text-meta leading-base text-muted">
        Direct is used whenever it is reachable; otherwise the chosen relay carries the connection.
      </p>
      {/*
        FIRST, AND IN THE WARNING TONE, because it changes what every row below
        actually does today: nothing dials a relay yet. The reader it matters most
        to is the one whose daemon is behind NAT, who would otherwise pick the
        recommended row, pair successfully, and connect to nothing.
      */}
      <p className="m-0 text-meta leading-base text-warn" data-onboarding-transport-gap="">
        {TRANSPORT_NOT_WIRED_NOTE}
      </p>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {CONNECTION_METHODS.map(method => (
          <li key={method.id} className="min-w-0">
            <button
              type="button"
              className={ROW}
              onClick={() => onChoose(method.id)}
              data-onboarding-connection={method.id}
            >
              <span className="shrink-0 text-accent">{ICON[method.id]}</span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="font-display text-title font-bold tracking-display text-fg">
                  {method.title}
                  {method.recommended === true ? <span className="ml-2 text-meta text-accent">Recommended</span> : null}
                </span>
                <span className="text-meta leading-base text-muted">{method.answer}</span>
                {/*
                  Only the row this is a fact ABOUT carries it. The other two
                  carriers do not depend on Ferretry's advertisement, so a state
                  line under them would be noise attached to the wrong thing.
                */}
                {method.id === 'default-relay' ? <DefaultRelayState fallback={fallback} /> : null}
              </span>
              <ChevronRight size={18} aria-hidden="true" className="shrink-0 text-faint" />
            </button>
          </li>
        ))}
      </ul>
      <Aside summary="What the default relay would see">
        <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-meta leading-base text-muted">
          {HOSTED_RELAY_DISCLOSURE.map(line => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </Aside>
    </div>
  );
}

/**
 * The recommended row's live state, in the four answers that are not each other.
 *
 * `role="status"` because it arrives after first paint: the page renders
 * "checking", the advertisement lands, and a reader who is not watching this line
 * is told rather than left with stale text. `undetermined` is shown as ignorance
 * rather than as "switched off" — that would blame an operator who did nothing —
 * and never as available, which would offer a carrier that may not exist.
 */
function DefaultRelayState({ fallback }: { readonly fallback: HostedRelayFallback }) {
  if (fallback.kind === 'checking') {
    return (
      <span className="text-meta leading-base text-faint" role="status">
        Checking whether it is available&hellip;
      </span>
    );
  }
  if (fallback.kind === 'available') {
    return (
      <span className="text-meta leading-base text-muted" role="status">
        {HOSTED_RELAY_ROW_NOTE} Advertising itself now, at{' '}
        <code className="font-mono text-syn-string">{fallback.relayUrl}</code>.
      </span>
    );
  }
  if (fallback.kind === 'disabled') {
    return (
      <span className="text-meta leading-base text-warn" role="status">
        {HOSTED_RELAY_DISABLED_NOTE}
      </span>
    );
  }
  return (
    <span className="text-meta leading-base text-warn" role="status">
      Unavailable &mdash; {fallback.reason}. {HOSTED_RELAY_UNDETERMINED_NOTE}
    </span>
  );
}

/**
 * A secondary thing, folded away — the same `<details>` shape the stages use.
 *
 * Local rather than imported from `onboarding-stages.tsx`: that module's copy is
 * private to it, and exporting a wrapper across two files to save nine lines
 * would couple a chooser to a stage for no behaviour.
 */
function Aside({ summary, children }: { readonly summary: string; readonly children: ReactNode }) {
  return (
    <details
      className="min-w-0 rounded-control border border-border bg-surface-2 px-2 py-1"
      data-onboarding-aside={summary}
    >
      <summary className="cursor-pointer text-meta text-muted focus-visible:outline-focus focus-visible:outline-offset-focus">
        {summary}
      </summary>
      <div className="mt-2 flex min-w-0 flex-col gap-2 pb-1">{children}</div>
    </details>
  );
}
