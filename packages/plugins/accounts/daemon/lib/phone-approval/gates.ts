/**
 * THE THREE GATES AND THE MOVE-ON TEST of "Approve on your phone" (docs/input-requests.md), copied from today's
 * `input-requests/phone-approval.ts` (`gatedNumber`, `movedOn`, bb89d054d). Pure: the decision on what the browser
 * read, never a read of its own.
 *
 * THE NUMBER COMES ONLY FROM THE PAGE, read by the browser, and only past three gates (I200): the page is https on a
 * login domain of the sign-in it matched (or one its provider chain reaches) or on a fixed identity provider's host,
 * and still the host it was raised on; no ferret ran a page script in this session; and the number is in a provider's
 * own challenge view, visible and not one anyone can type into, in a document that did not change while it was read.
 * An element the ferret points at is never read (I201): the page may echo back text the ferret typed.
 */
import type { PushNumberRead } from '@ferretry/core-vault/contract';
import { type PhoneApproval, PhoneApprovalSchema } from '../../../contract/routes/phone-approval.ts';
import { identityProviderOf, numberSourceFits } from './providers.ts';

type PhoneApprovalNumber = NonNullable<PhoneApproval['number']>;
type PhoneApprovalNumberMissing = NonNullable<PhoneApproval['numberMissing']>;

/** Where a number goes: Duo's Verified Push code is typed into the app, the rest are tapped among the phone's choices. */
const directionOf = (from: PhoneApprovalNumber['from']): PhoneApprovalNumber['direction'] =>
  from === 'duo' ? 'type-on-phone' : 'tap-on-phone';

const instant = (ms: number): string => new Date(ms).toISOString();

/**
 * An origin's host when it is one a number may be read on at all: https and no port. The schema proves it parses and IS
 * its own origin (so it carries no credentials or path), so the URL below cannot throw.
 */
export function httpsHost(origin: string): string | undefined {
  if (!PhoneApprovalSchema.shape.origin.safeParse(origin).success) return undefined;
  const url = new URL(origin);
  return url.port === '' ? url.hostname.toLowerCase() : undefined;
}

/** What the gates decide on: the hosts a number may be read on, and what the session did to the page. */
export interface GateContext {
  readonly domains: ReadonlySet<string>;
  readonly scripted: boolean;
  readonly now: number;
  /** Hosts off Okta's own where its widget may give a number: the chain's provider sign-ins' domains. */
  readonly providerDomains?: ReadonlySet<string>;
  /** The host the approval was raised on: a read anywhere else, even another identity provider's, has no number. */
  readonly pinnedHost?: string;
}

/**
 * A number is believed only when the page is https on a host the matched sign-in (or its provider chain) signs in at, or
 * a fixed identity provider's, and it is still the host the approval was raised on; no ferret scripted a page this
 * session; the browser found it in a provider's OWN challenge view in the main frame, on a host that provider is on, in
 * a document that did not change while it was read; and it has the shape its source shows (1 to 3 digits to tap, 3 to 6
 * to type). Anything else is a reason, never a number.
 */
export function gatedNumber(
  read: PushNumberRead,
  context: GateContext,
): { readonly number: PhoneApprovalNumber } | { readonly numberMissing: PhoneApprovalNumberMissing } {
  const host = httpsHost(read.origin);
  if (host === undefined || (!context.domains.has(host) && identityProviderOf(host) === undefined))
    return { numberMissing: 'origin' };
  if (context.pinnedHost !== undefined && host !== context.pinnedHost) return { numberMissing: 'origin' };
  if (context.scripted) return { numberMissing: 'scripted' };
  if (read.missing === 'changed') return { numberMissing: 'changed' };
  const found = read.number;
  if (found === undefined) return { numberMissing: 'none-found' };
  if (found.frameOrigin !== read.origin || !numberSourceFits(found.from, host, context.providerDomains))
    return { numberMissing: 'origin' };
  // Only the provider whose challenge view this document IS may give its number (secrev-1244 H1).
  if (read.provider === undefined || found.from !== read.provider) return { numberMissing: 'none-found' };
  const parsed = PhoneApprovalSchema.shape.number.safeParse({
    value: found.value,
    from: found.from,
    direction: directionOf(found.from),
    readAt: instant(context.now),
  });
  return parsed.success && parsed.data !== undefined ? { number: parsed.data } : { numberMissing: 'none-found' };
}

/**
 * Whether a page the approval was raised on has moved on, and how: `left`, a new document on a host no identity
 * provider serves (the sign-in finished somewhere); `challenge-ended`, a new document on the same host that is no
 * longer the provider's challenge (Microsoft's "Stay signed in?", or a provider's own "denied" or "expired" view, which
 * cannot be told apart yet). Undefined: it may be the same challenge again.
 */
export function movedOn(
  held: { readonly document?: string; readonly raisedOnChallenge: boolean; readonly raisedHost?: string },
  now: { readonly navigationId: string; readonly host?: string; readonly provider?: string },
): 'left' | 'challenge-ended' | undefined {
  if (held.document === undefined || now.navigationId === held.document) return undefined;
  if (now.host !== undefined && now.host !== held.raisedHost && identityProviderOf(now.host) === undefined)
    return 'left';
  return held.raisedOnChallenge && now.provider === undefined ? 'challenge-ended' : undefined;
}
