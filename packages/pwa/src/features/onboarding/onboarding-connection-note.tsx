/**
 * HOW OTHER DEVICES REACH THIS COMPUTER — said, never asked.
 *
 * This used to be a three-way chooser (the hosted relay, a relay of your own,
 * direct) standing in the middle of first run. A stranger cannot answer that
 * question and did not need to: direct is attempted first and Ferretry's hosted
 * relay is the automatic fallback (`docs/relay-protocol.md` §13), so the only
 * honest thing left to put on the glass is what WILL happen, and whether the
 * fallback is actually there right now. Running a relay of your own is an expert
 * path with its own runbook, `docs/cloudflare-relay-self-hosting.md`, and never
 * a step here.
 */

import type { ReactNode } from 'react';

import {
  type HostedRelayFallback,
  HOSTED_RELAY_DISABLED_NOTE,
  HOSTED_RELAY_DISCLOSURE,
  HOSTED_RELAY_ROW_NOTE,
  HOSTED_RELAY_UNDETERMINED_NOTE,
  TRANSPORT_NOT_WIRED_NOTE,
} from './hosted-relay.ts';

export interface OnboardingConnectionNoteProps {
  /**
   * What the runtime advertisement said about the hosted relay.
   *
   * A live fact, not a constant: its operator can withdraw it between a release
   * and a reader arriving, so the note has to be able to say it is switched off —
   * and to say when this page could not find out, which is neither available nor
   * off.
   */
  readonly fallback: HostedRelayFallback;
}

export function OnboardingConnectionNote({ fallback }: OnboardingConnectionNoteProps) {
  return (
    <div
      className="flex min-w-0 flex-col gap-2 rounded-control border border-border bg-surface-2 px-3 py-3"
      data-onboarding-connection-note=""
      data-onboarding-fallback={fallback.kind}
    >
      <p className="m-0 text-meta font-bold leading-base text-fg">How your other devices reach it</p>
      <p className="m-0 text-meta leading-base text-muted">
        Nothing to choose. They try this computer directly first. When they cannot reach it, Ferretry&rsquo;s hosted
        relay carries the connection instead.
      </p>
      <HostedRelayState fallback={fallback} />
      <Aside summary="What works over the relay">
        <p className="m-0 text-meta leading-base text-muted" data-onboarding-transport-gap="">
          {TRANSPORT_NOT_WIRED_NOTE}
        </p>
      </Aside>
      <Aside summary="What the hosted relay would see">
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
 * The hosted relay's live state, in the four answers that are not each other.
 *
 * `role="status"` because it arrives after first paint: the page renders
 * "checking", the advertisement lands, and a reader who is not watching this line
 * is told rather than left with stale text. `undetermined` is shown as ignorance
 * rather than as "switched off" — that would blame an operator who did nothing —
 * and never as available, which would promise a fallback that may not exist.
 */
function HostedRelayState({ fallback }: { readonly fallback: HostedRelayFallback }) {
  if (fallback.kind === 'checking') {
    return (
      <span className="text-meta leading-base text-faint" role="status">
        Checking whether the hosted relay is available&hellip;
      </span>
    );
  }
  if (fallback.kind === 'available') {
    return (
      <span className="text-meta leading-base text-muted" role="status">
        {HOSTED_RELAY_ROW_NOTE} Available now, at <code className="font-mono text-syn-string">{fallback.relayUrl}</code>
        .
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
      The hosted relay is unavailable &mdash; {fallback.reason}. {HOSTED_RELAY_UNDETERMINED_NOTE}
    </span>
  );
}

/**
 * A secondary thing, folded away — the same `<details>` shape the stages use.
 *
 * Local rather than imported from `onboarding-stages.tsx`: that module's copy is
 * private to it, and exporting a wrapper across two files to save nine lines
 * would couple this note to a stage for no behaviour.
 */
function Aside({ summary, children }: { readonly summary: string; readonly children: ReactNode }) {
  return (
    <details
      className="min-w-0 rounded-control border border-border bg-surface px-2 py-1"
      data-onboarding-aside={summary}
    >
      <summary className="cursor-pointer text-meta text-muted focus-visible:outline-focus focus-visible:outline-offset-focus">
        {summary}
      </summary>
      <div className="mt-2 flex min-w-0 flex-col gap-2 pb-1">{children}</div>
    </details>
  );
}
