/**
 * WHAT IS CARRYING THIS CONNECTION, AND WHO CAN SEE THAT IT EXISTS.
 *
 * `docs/relay-protocol.md` §1: a surface that shows a connection without naming its
 * carrier is not conforming. This is that naming, and it is deliberately about the
 * carrier the LIVE SESSION WON ON rather than the one anybody preferred — the two
 * differ exactly when it matters, and the version that is merely preferred is the
 * version that tells somebody their traffic is direct while it is going through
 * Cloudflare.
 *
 * THE ONE CHOICE HERE IS WHICH CARRIERS THIS DEVICE WALKS, NOT WHICH ONE IS LIVE.
 * §15 gives each device a per-machine preference — Auto, WebRTC only, Tunnel only or
 * Relay only — and the card carries that selector (the same one Settings › This device
 * lists), but what it REPORTS is still the measurement: the carrier that won under the
 * preference, and the reason, in `chooseConnection`'s own words — including "Tunnel
 * only: this machine has no tunnel yet" when a preference leaves nothing to try.
 *
 * THE OBSERVER LIST IS `describeConnectionMethod`'s, verbatim. A second copy of "what
 * a relay operator can see" would be a second thing to keep true, and the one in
 * `packages/relay` is the one the protocol document is written against. This
 * component chooses nothing about the wording; it only decides that the wording is
 * shown, for the carrier that is actually live.
 *
 * ONE STATUS WORD COMES FIRST — direct, WebRTC, via tunnel, via relay, or reconnecting — because that is what a reader
 * came here to learn, and the measured carrier alone cannot say the third: a router remembers the
 * carrier that last WON, so during an outage it would go on naming a connection that is gone. The
 * reconnect loop's state (`connection-health.ts`) is the one fact that knows, so it decides the word.
 *
 * RUNNING YOUR OWN RELAY IS NOT CONFIGURED HERE. It is an expert path set on the daemon
 * (`config/daemon.json`), and this page follows whatever the daemon publishes; the card links the
 * runbook rather than offering a setting, so there is no second place a carrier could be chosen.
 *
 * NOT KNOWING IS ITS OWN STATE. Before the first request there is no measured
 * answer, and this says so rather than guessing "direct" — that guess was the bug in
 * the text this replaces, which claimed a carrier nothing had measured.
 */

import { type ConnectionChoice, type ConnectionMethod, describeConnectionMethod } from '@ferretry/relay';
import type { CarrierPreference } from '../../lib/carrier-preference.ts';
import type { ConnectionHealthState } from '../../lib/connection-health.ts';
import { carrierLines, RECONNECTING_LABEL, stallCopy } from '../connection/connection-copy.ts';
import { type CarrierPreferenceAvailability, CarrierPreferenceSelector } from './carrier-preference-selector.tsx';

/** This machine's connection preference on this device, and how to change it. */
export interface CarrierPreferenceControl {
  readonly value: CarrierPreference;
  readonly onChange: (preference: CarrierPreference) => void;
  readonly availability: CarrierPreferenceAvailability;
}

export interface ActiveCarrierCardProps {
  /** What the router measured, or `undefined` before anything has been carried. */
  readonly choice: ConnectionChoice | undefined;
  /** Whether a rendezvous is even available to fall back to, from the live advertisement. */
  readonly relayAdvertised: boolean;
  /** The reconnect loop's state for this daemon; absent reads as nothing measured yet. */
  readonly health?: ConnectionHealthState;
  /** The machine's display name, for the reconnecting advice. */
  readonly machine?: string;
  /** The connection preference selector; absent where nothing can change it. */
  readonly preference?: CarrierPreferenceControl;
}

/** The status the card leads with, as one machine-readable word. */
export type ConnectionStatusKind = ConnectionMethod['kind'] | 'reconnecting' | 'none';

/** Where running your own relay is documented. The app links it and never configures it. */
export const SELF_HOSTING_RUNBOOK_URL =
  'https://github.com/kirinnee/ferretry/blob/main/docs/cloudflare-relay-self-hosting.md';

/** Said beside that link, so nobody looks for a relay setting this app does not have. */
export const SELF_HOSTING_NOTE =
  'Running your own relay is an expert option set on the daemon, not in this app. This page follows ' +
  'whatever the daemon publishes.';

/** The lead word for each status. */
export const CONNECTION_STATUS_LABEL: Readonly<Record<ConnectionStatusKind, string>> = {
  direct: 'Direct',
  webrtc: 'WebRTC',
  tunnel: 'Via Cloudflare tunnel',
  relay: 'Via relay',
  reconnecting: RECONNECTING_LABEL,
  none: 'Not measured yet',
};

/** Which relay carried it: whose, and the host it lives on — never the daemon fingerprint. */
export const relayName = (method: Extract<ConnectionMethod, { kind: 'relay' }>): string =>
  `${describeConnectionMethod(method).label} · ${new URL(method.relayUrl).host}`;

/**
 * What follows the status word, naming WHICH carrier of its kind: a relay's operator and host, a
 * tunnel's hostname (one random label, never the fingerprint). Direct and WebRTC need nothing more.
 */
export const carrierDetail = (method: ConnectionMethod): string | undefined => {
  if (method.kind === 'relay') return relayName(method);
  if (method.kind === 'tunnel') return new URL(method.tunnelUrl).host;
  return undefined;
};

/** Reconnecting outranks any measured carrier: the router's answer is the LAST one that won. */
export const connectionStatusKind = (
  method: ConnectionMethod | undefined,
  health: ConnectionHealthState | undefined,
): ConnectionStatusKind => (health?.kind === 'reconnecting' ? 'reconnecting' : (method?.kind ?? 'none'));

/** Said before the first request, because a carrier nobody has tried is not a carrier. */
/**
 * The lead word when a walk RAN and nothing carried — "Tunnel only: not set up by the operator." among
 * them. Not "not measured yet": something was measured, and the answer was no. The machine-readable
 * status stays `none`, because no carrier is live.
 */
export const NOT_CONNECTED_LABEL = 'Not connected';

export const CARRIER_UNMEASURED =
  'Nothing has been carried yet, so there is no carrier to name. This will say which one is in use, ' +
  'and why, as soon as this daemon is asked for anything.';

/** Said when direct is the only carrier there is, so a reader knows what the constraint is. */
export const CARRIER_NO_FALLBACK =
  'There is no relay to fall back on right now, so this daemon has to be reachable from here — same ' +
  'network, a VPN, a tailnet, or a public address.';

/**
 * WHAT A RELAY OPERATOR OBSERVES ABOUT A LIVE STREAM, which is more than about a request.
 *
 * This slot used to say live updates were unavailable over a relay, and that was true when it was
 * written. `docs/relay-protocol.md` §14 now carries them, one session per stream — so the honest
 * thing to say in its place is not silence but the DISCLOSURE the new capability brings with it.
 *
 * A stream's content is sealed exactly as a request's is. Its SHAPE is not: a relay sees a frame
 * arrive whenever one does, and for a terminal that is keystroke timing, which is a materially
 * stronger observation than "a request happened" and deserves its own sentence rather than a clause.
 */
export const CARRIER_STREAM_DISCLOSURE =
  'Live updates and terminals travel this relay too, each on its own session. The relay cannot read any ' +
  'of it — but it sees when each frame arrives and how big it is, and for a terminal that is the rhythm ' +
  'of your typing.';

/** The same disclosure for a tunnel: Cloudflare's edge sees each frame's size and timing (§15). */
export const CARRIER_TUNNEL_STREAM_DISCLOSURE =
  'Live updates and terminals travel this tunnel too, each on its own session. Cloudflare cannot read any of ' +
  'it — but it sees when each frame arrives and how big it is, and for a terminal that is the rhythm of your typing.';

export function ActiveCarrierCard({
  choice,
  relayAdvertised,
  health,
  machine = 'this machine',
  preference,
}: ActiveCarrierCardProps) {
  const method = choice?.ok === true ? choice.method : undefined;
  const disclosure = method === undefined ? undefined : describeConnectionMethod(method);
  const status = connectionStatusKind(method, health);
  const outage = health?.kind === 'reconnecting' ? health : undefined;
  const advice = outage === undefined ? undefined : stallCopy(outage.cause, machine);
  const detail = method === undefined ? undefined : carrierDetail(method);
  const measured = choice?.ok === true ? choice : undefined;
  const caveat =
    method?.kind === 'relay'
      ? CARRIER_STREAM_DISCLOSURE
      : method?.kind === 'tunnel'
        ? CARRIER_TUNNEL_STREAM_DISCLOSURE
        : choice !== undefined && !relayAdvertised
          ? CARRIER_NO_FALLBACK
          : undefined;
  return (
    <section
      className="kt-panel p-panel"
      aria-labelledby="settings-carrier-heading"
      data-active-carrier=""
      /*
       * The MEASURED carrier as one machine-readable word, beside the prose that explains it.
       * `none` is "nothing has measured a carrier yet" and is deliberately not "direct": a surface
       * that defaulted to direct would state a fact no walk has established. A harness proving that
       * the session after a pairing won on the relay reads this rather than matching rendered copy,
       * which is how a journey starts failing for a rewording.
       */
      data-carrier-kind={method?.kind ?? 'none'}
    >
      <h3 id="settings-carrier-heading" className="m-0 text-row font-semibold text-fg">
        Connection
      </h3>
      {/* The lead answer. `role="status"` so a reader on assistive tech hears it change. */}
      <p role="status" className="mb-0 mt-1 text-row font-semibold text-fg" data-connection-status={status}>
        {status === 'none' && choice?.ok === false ? NOT_CONNECTED_LABEL : CONNECTION_STATUS_LABEL[status]}
        {detail !== undefined && outage === undefined ? (
          <span className="font-normal text-muted"> — {detail}</span>
        ) : null}
      </p>
      {outage === undefined ? null : (
        <div className="mt-2" data-connection-outage="">
          <p className="mb-0 text-cell leading-base text-warn">{advice?.heading}.</p>
          <p className="mb-0 mt-1 text-cell leading-base text-muted">{advice?.advice}</p>
          {outage.failures.length === 0 ? null : (
            <ul className="mb-0 mt-2 flex list-disc flex-col gap-1 pl-5 text-meta leading-base text-muted">
              {carrierLines(outage.failures).map(failure => (
                <li key={failure.label}>
                  {failure.label}: {failure.detail}
                </li>
              ))}
            </ul>
          )}
          {method === undefined ? null : (
            <h4 className="mb-0 mt-4 text-cell font-semibold text-fg">Last connected over {disclosure?.label}</h4>
          )}
        </div>
      )}
      {/* The measured sentence, or the honest absence of one. Never a default. */}
      <p className="mb-0 mt-1 text-cell leading-base text-muted">
        {choice === undefined ? CARRIER_UNMEASURED : choice.reason}
      </p>
      {/* A constraint the reader will otherwise discover as a screen that stops
          updating, or a daemon that stops answering from a café. `text-warn` because
          it is a limit on what works, not decoration. */}
      {caveat === undefined ? null : <p className="mb-0 mt-2 text-meta leading-base text-warn">{caveat}</p>}
      {/* What a carrier measured about itself, when it measures anything (WebRTC does). */}
      {measured?.rttMs === undefined ? null : (
        <p className="mb-0 mt-2 text-meta leading-base text-muted" data-carrier-rtt="">
          Round trip: {Math.round(measured.rttMs)} ms
        </p>
      )}
      {measured?.fallbackReason === undefined ? null : (
        <p className="mb-0 mt-2 text-meta leading-base text-muted" data-carrier-fallback-reason="">
          Why not a faster carrier: {measured.fallbackReason}
        </p>
      )}
      {/* The machine's own line about its tunnel — "Tunnel: off (opt-in) — turn on with …" — because a
          tunnel is opt-in per machine (§15) and "Tunnel only" without one otherwise reads as broken. */}
      {preference?.availability.tunnel === undefined ? null : (
        <p className="mb-0 mt-2 text-meta leading-base text-muted" data-tunnel-status="">
          {preference.availability.tunnel.sentence}
        </p>
      )}
      {preference === undefined ? null : (
        <div className="mt-4" data-carrier-preference-control="">
          <CarrierPreferenceSelector
            legend="How this device connects"
            value={preference.value}
            onChange={preference.onChange}
            availability={preference.availability}
          />
        </div>
      )}
      {disclosure === undefined ? null : (
        <>
          <p className="mb-0 mt-3 text-cell leading-base text-fg">{disclosure.summary}</p>
          {/* Under a "who can see this" heading an empty list reads as a redaction, so
              the list is only ever rendered with its heading and never on its own. */}
          <h4 className="mb-0 mt-4 text-cell font-semibold text-fg">What the parties on this path can see</h4>
          <ul className="mb-0 mt-2 flex list-disc flex-col gap-1 pl-5 text-meta leading-base text-muted">
            {disclosure.observers.map(observer => (
              <li key={observer}>{observer}</li>
            ))}
          </ul>
        </>
      )}
      {/* Every carrier that was tried and did not work, named. A relay that carried a
          session because a firewall dropped the direct address is a fact its owner
          should be able to see, not a silent degradation. */}
      {choice === undefined || choice.passedOver.length === 0 ? null : (
        <>
          <h4 className="mb-0 mt-4 text-cell font-semibold text-fg">Passed over</h4>
          <ul className="mb-0 mt-2 flex list-disc flex-col gap-1 pl-5 text-meta leading-base text-muted">
            {choice.passedOver.map(skip => (
              <li key={`${skip.method.kind}:${skip.detail}`}>
                {describeConnectionMethod(skip.method).label}
                {skip.untried === true
                  ? ' (not tried)'
                  : skip.connected === true
                    ? ' (connected, then the session failed)'
                    : ''}
                : {skip.detail}
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="mb-0 mt-4 text-meta leading-base text-muted" data-self-hosting-note="">
        {SELF_HOSTING_NOTE}{' '}
        <a
          className="inline-flex min-h-[44px] items-center text-accent underline sm:min-h-0"
          href={SELF_HOSTING_RUNBOOK_URL}
          target="_blank"
          rel="noreferrer noopener"
        >
          Self-hosting runbook
        </a>
      </p>
    </section>
  );
}
