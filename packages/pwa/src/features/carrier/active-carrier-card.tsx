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
 * NOTHING HERE IS A CHOICE. There is no control, because there is nothing to decide:
 * direct is attempted first and the relay is the automatic fallback. What a reader
 * gets is the answer and the reason, in `chooseConnection`'s own words.
 *
 * THE OBSERVER LIST IS `describeConnectionMethod`'s, verbatim. A second copy of "what
 * a relay operator can see" would be a second thing to keep true, and the one in
 * `packages/relay` is the one the protocol document is written against. This
 * component chooses nothing about the wording; it only decides that the wording is
 * shown, for the carrier that is actually live.
 *
 * NOT KNOWING IS ITS OWN STATE. Before the first request there is no measured
 * answer, and this says so rather than guessing "direct" — that guess was the bug in
 * the text this replaces, which claimed a carrier nothing had measured.
 */

import { type ConnectionChoice, describeConnectionMethod } from '@ferretry/relay';

export interface ActiveCarrierCardProps {
  /** What the router measured, or `undefined` before anything has been carried. */
  readonly choice: ConnectionChoice | undefined;
  /** Whether a rendezvous is even available to fall back to, from the live advertisement. */
  readonly relayAdvertised: boolean;
}

/** Said before the first request, because a carrier nobody has tried is not a carrier. */
export const CARRIER_UNMEASURED =
  'Nothing has been carried yet, so there is no carrier to name. This will say which one is in use, ' +
  'and why, as soon as this daemon is asked for anything.';

/** Said when direct is the only carrier there is, so a reader knows what the constraint is. */
export const CARRIER_NO_FALLBACK =
  'There is no relay to fall back on right now, so this daemon has to be reachable from here — same ' +
  'network, a VPN, a tailnet, or a public address.';

/**
 * The one thing a relayed connection cannot do, said where the carrier is named.
 *
 * §14 carries one request and one answer per record, so a stream has no envelope.
 * A reader whose live updates have stopped deserves the reason next to the carrier
 * that caused it rather than a screen that simply stops changing.
 */
export const CARRIER_NO_LIVE_UPDATES =
  'Live updates are unavailable over a relay: the relay protocol carries one request and one answer at ' +
  'a time, and a stream needs an envelope neither end has built yet. Everything else works.';

export function ActiveCarrierCard({ choice, relayAdvertised }: ActiveCarrierCardProps) {
  const method = choice?.ok === true ? choice.method : undefined;
  const disclosure = method === undefined ? undefined : describeConnectionMethod(method);
  const caveat =
    method?.kind === 'relay'
      ? CARRIER_NO_LIVE_UPDATES
      : choice !== undefined && !relayAdvertised
        ? CARRIER_NO_FALLBACK
        : undefined;
  return (
    <section className="kt-panel p-panel" aria-labelledby="settings-carrier-heading" data-active-carrier="">
      <h3 id="settings-carrier-heading" className="m-0 text-title font-semibold text-fg">
        {disclosure?.label ?? 'Carrier'}
      </h3>
      {/* The measured sentence, or the honest absence of one. Never a default. */}
      <p className="mb-0 mt-1 text-ui leading-base text-muted">
        {choice === undefined ? CARRIER_UNMEASURED : choice.reason}
      </p>
      {/* A constraint the reader will otherwise discover as a screen that stops
          updating, or a daemon that stops answering from a café. `text-warn` because
          it is a limit on what works, not decoration. */}
      {caveat === undefined ? null : <p className="mb-0 mt-2 text-meta leading-base text-warn">{caveat}</p>}
      {disclosure === undefined ? null : (
        <>
          <p className="mb-0 mt-3 text-ui leading-base text-fg">{disclosure.summary}</p>
          {/* Under a "who can see this" heading an empty list reads as a redaction, so
              the list is only ever rendered with its heading and never on its own. */}
          <h4 className="mb-0 mt-4 text-meta font-semibold uppercase tracking-label text-faint">
            What the parties on this path can see
          </h4>
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
          <h4 className="mb-0 mt-4 text-meta font-semibold uppercase tracking-label text-faint">Passed over</h4>
          <ul className="mb-0 mt-2 flex list-disc flex-col gap-1 pl-5 text-meta leading-base text-muted">
            {choice.passedOver.map(skip => (
              <li key={`${skip.method.kind}:${skip.detail}`}>
                {describeConnectionMethod(skip.method).label}: {skip.detail}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
