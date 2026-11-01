import { randomBytes } from 'node:crypto';
import {
  type AccountId,
  type AuditDetail,
  type Place,
  placeKeys,
  SIGN_IN_RULE_SUGGESTION_TTL_SECONDS,
  SIGN_IN_RULE_SUGGESTION_WHY_MAX_CHARS,
  SIGN_IN_RULE_SUGGESTIONS_PER_HOUR,
  type SignInId,
  type SignInRuleSuggestionId,
  type SignInRuleSuggestionList,
  type SignInRuleSuggestionView,
  type SignInSummary,
} from '@ferretry/protocol';
import type { AuditSink } from '../audit/types.ts';
import type { PasteRuleCaller } from '../secure-copy/rules.ts';
import type { RuleListing } from './drift.ts';
import { ruleSurfaceOf } from './eligibility.ts';
import { auditText } from './words.ts';

/**
 * A FERRET'S SUGGESTION OF A STANDING RULE (docs/secrets.md, "Standing sign-in rules"; plan §10). A ferret may ASK the
 * owner to consider a rule and nothing more: this holds a card on the owner's agenda and a line in RAM. It holds no
 * stage, no proof and no field that could become a rule, and no route turns it into one: the card opens the owner's
 * create sheet with NOTHING ticked, and the rule is then made exactly as if the owner had started it (a fresh passkey
 * over the bytes the daemon built).
 *
 * ## THE CARD NAMES THE HOST, NEVER THE FERRET'S WORDS
 *
 * The card's text is the daemon's: the host comes from the sign-in's own place. No account label, no username and no word
 * of the ferret's is in it. The ferret's reason is redacted (the vault redactor), flattened to one line and clipped,
 * and is shown only in the owner's sheet, faint and quoted.
 *
 * ## THE CAPS ARE TAKEN BEFORE ANYTHING AWAITS (secrev-1261 L1)
 *
 * At most {@link SIGN_IN_RULE_SUGGESTIONS_PER_HOUR} an hour per session, and at most one pending per sign-in per
 * session. Both are reserved in the same synchronous run that checks them, so calls sent together cannot all pass.
 * A refused suggestion gives its place and its count back. A suggestion is RAM only and ends after a day.
 *
 * ## THE FERRET LEARNS NOTHING ABOUT RULES
 *
 * A refusal is only ever about the sign-in itself, which the ferret can already read (not a password sign-in, signed
 * in with a provider, a program no rule covers), or about the ferret's own earlier suggestion. Whether the owner has a
 * rule, tapped this sign-in by hand, or holds a passkey is never said: the answer is the same whatever it is.
 */

/** The agenda, as a suggestion's card needs it: raise one, and close it when the suggestion ends. */
export interface SignInRuleSuggestionAgendaPort {
  raise(
    sessionId: string,
    card: SignInRuleSuggestionCard,
  ): Promise<{ readonly ok: true; readonly id: string } | { readonly ok: false; readonly message: string }>;
  close(sessionId: string, id: string, note: string): Promise<void>;
  /** Whether the card is still open on the agenda: the owner may close it there instead of in the sheet. */
  isOpen(sessionId: string, id: string): Promise<boolean>;
}

/** The daemon's words for the card. Nothing here is the ferret's. */
export interface SignInRuleSuggestionCard {
  readonly suggestionId: SignInRuleSuggestionId;
  readonly ask: string;
  readonly context: string;
  readonly howToResolve: string;
  readonly expiresAt: string;
}

export interface SignInRuleSuggestionPorts {
  readonly accounts: { listing(): Promise<RuleListing> };
  readonly agenda: SignInRuleSuggestionAgendaPort;
  /** The vault redactor, for the ferret's reason. */
  readonly redact: (text: string) => Promise<string>;
  readonly audit: AuditSink;
  readonly clock: { now(): number };
  readonly ids?: { suggestionId?(): SignInRuleSuggestionId };
  /** Whether the daemon reports `sign-in-rules-terminal.1`: until it does, no terminal sign-in can have a rule. */
  readonly terminalRules?: () => boolean;
}

/** A refusal in words the ferret can act on; `code` is the agent tool's own. */
export class SignInRuleSuggestionError extends Error {
  constructor(
    readonly code: 'bad_request' | 'not_found' | 'capacity' | 'unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'SignInRuleSuggestionError';
  }
}

/** What a ferret asks: one sign-in (or, in the older spelling, the account whose only sign-in it is) and why. */
export interface SignInRuleSuggestionAsk {
  readonly signIn?: SignInId | undefined;
  readonly login?: AccountId | undefined;
  readonly why: string;
}

/** What a suggestion came to: the card the owner will see, and the host the daemon named on it. */
export interface SignInRuleSuggested {
  readonly suggestion: SignInRuleSuggestionId;
  readonly signIn: SignInId;
  readonly host: string;
  readonly agenda: string;
}

interface Pending {
  readonly id: SignInRuleSuggestionId;
  readonly sessionId: string;
  readonly signIn: SignInId;
  readonly surface: 'page' | 'terminal';
  readonly host: string;
  readonly why: string;
  readonly agenda: string;
  readonly raisedAt: number;
  readonly expiresAt: number;
}

const HOUR_MS = 3_600_000;
const CLOSED_NOTE = 'The owner closed this card.';
const randomSuggestionId = (): SignInRuleSuggestionId => `srg_${randomBytes(8).toString('hex')}`;

const oneLine = (text: string, max: number): string => {
  const flat = text
    .replaceAll(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replaceAll(/\s+/gu, ' ')
    .trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

/** The host the daemon names: the sign-in's first login domain (or what it is for), or the terminal's program and host. */
export function suggestionHost(place: Place): string {
  const named = placeKeys(place)[0] ?? (place.kind === 'site' ? place.match[0] : undefined) ?? 'this site';
  return oneLine(named, 120);
}

export class SignInRuleSuggestions {
  readonly #pending = new Map<SignInRuleSuggestionId, Pending>();
  /**
   * Suggestions the owner turned down, by either door. They stay in `#pending` until their own expiry so `waiting()`
   * keeps answering as if the owner had not answered: the ferret can never tell a "no" from silence.
   */
  readonly #turnedDown = new Set<SignInRuleSuggestionId>();
  /** Session → the sign-ins whose suggestion is being raised right now, so two calls together can't both pass. */
  readonly #raising = new Map<string, Set<SignInId>>();
  readonly #raised = new Map<string, number[]>();
  readonly #newId: () => SignInRuleSuggestionId;

  constructor(private readonly ports: SignInRuleSuggestionPorts) {
    this.#newId = ports.ids?.suggestionId?.bind(ports.ids) ?? randomSuggestionId;
  }

  /**
   * Raises one card for the owner. Resolves with the sign-in's host and the card's agenda id. Refuses when the sign-in
   * is not one a rule could ever cover, when this session already has one waiting for it, or has asked three times this hour.
   */
  async suggest(sessionId: string, ask: SignInRuleSuggestionAsk): Promise<SignInRuleSuggested> {
    const now = this.ports.clock.now();
    this.sweep();
    // RESERVED before anything awaits: the hour's count now, and the sign-in's place as soon as it is known.
    const hour = this.#reserveHour(sessionId, now);
    let release = (): void => {};
    try {
      const listing = await this.ports.accounts.listing().catch(() => {
        throw new SignInRuleSuggestionError(
          'unavailable',
          'The saved logins cannot be read right now; try again later.',
        );
      });
      const found = this.#resolve(listing, ask);
      release = this.#reserveSignIn(sessionId, found.id);
      this.#refuseUncoverable(found);
      const why = await this.#whyOf(ask.why);
      const id = this.#newId();
      const expiresAt = now + SIGN_IN_RULE_SUGGESTION_TTL_SECONDS * 1000;
      const host = suggestionHost(found.place);
      const card = await this.ports.agenda.raise(sessionId, {
        suggestionId: id,
        ask: `A ferret suggests a standing rule for a sign-in on ${host}.`,
        context:
          'Nothing is allowed yet. Open it in the app: nothing is ticked, and you choose what to allow and confirm with your passkey. You can also just close this card.',
        howToResolve: 'Open it in the app to start a rule, or close the card to say no.',
        expiresAt: new Date(expiresAt).toISOString(),
      });
      if (!card.ok) throw new SignInRuleSuggestionError('unavailable', card.message);
      this.#pending.set(id, {
        id,
        sessionId,
        signIn: found.id,
        surface: ruleSurfaceOf(found),
        host,
        why,
        agenda: card.id,
        raisedAt: now,
        expiresAt,
      });
      hour.kept();
      await this.#record(id, {
        action: 'sign-in-rule-suggested',
        by: 'agent',
        session: auditText(sessionId),
        signIn: found.id,
        agenda: card.id,
        why: auditText(why),
      });
      return { suggestion: id, signIn: found.id, host, agenda: card.id };
    } finally {
      release();
      hour.release();
    }
  }

  /** The suggestions still waiting, for the owner's sheet. */
  list(caller: PasteRuleCaller): SignInRuleSuggestionList {
    this.#requireOwner(caller);
    this.sweep();
    return {
      suggestions: [...this.#pending.values()].filter(pending => !this.#turnedDown.has(pending.id)).map(viewOf),
    };
  }

  /** The owner turns one down: it leaves the sheet and its card closes, but the ferret is still told it is waiting. */
  async dismiss(caller: PasteRuleCaller, id: SignInRuleSuggestionId): Promise<boolean> {
    this.#requireOwner(caller);
    const pending = this.#pending.get(id);
    if (pending === undefined || this.#turnedDown.has(id)) return false;
    this.#turnedDown.add(id);
    await this.ports.agenda.close(pending.sessionId, pending.agenda, CLOSED_NOTE).catch(() => undefined);
    return true;
  }

  /** A card the owner closed on the agenda is a "no" like a dismissal: it leaves the sheet and keeps the ferret blocked. */
  async reconcile(): Promise<void> {
    for (const pending of [...this.#pending.values()]) {
      if (this.#turnedDown.has(pending.id)) continue;
      const open = await this.ports.agenda.isOpen(pending.sessionId, pending.agenda).catch(() => true);
      if (!open) this.#turnedDown.add(pending.id);
    }
  }

  /** Ends every suggestion past its day, with its card. */
  sweep(): void {
    const now = this.ports.clock.now();
    for (const pending of this.#pending.values()) if (pending.expiresAt <= now) void this.#expire(pending);
  }

  /** Whether a suggestion is waiting for this sign-in from this session. */
  waiting(sessionId: string, signIn: SignInId): boolean {
    return (
      (this.#raising.get(sessionId)?.has(signIn) ?? false) ||
      [...this.#pending.values()].some(pending => pending.sessionId === sessionId && pending.signIn === signIn)
    );
  }

  async #expire(pending: Pending): Promise<void> {
    this.#pending.delete(pending.id);
    if (this.#turnedDown.delete(pending.id)) return;
    await this.ports.agenda.close(pending.sessionId, pending.agenda, 'This suggestion expired.').catch(() => undefined);
  }

  #requireOwner(caller: PasteRuleCaller): void {
    if (caller.kind !== 'owner')
      throw new SignInRuleSuggestionError('bad_request', 'only the owner reads or dismisses a rule suggestion');
  }

  #resolve(listing: RuleListing, ask: SignInRuleSuggestionAsk): SignInSummary {
    if (ask.signIn !== undefined) {
      const found = listing.signIns.find(each => each.id === ask.signIn);
      if (found === undefined) throw new SignInRuleSuggestionError('not_found', `There is no sign-in ${ask.signIn}.`);
      return found;
    }
    const own = listing.signIns.filter(each => each.account === ask.login);
    if (own.length === 0)
      throw new SignInRuleSuggestionError(
        'not_found',
        'There is no such saved login; name the sign-in (account_hint).',
      );
    const [only] = own;
    if (own.length > 1 || only === undefined)
      throw new SignInRuleSuggestionError('bad_request', 'That account has several sign-ins; name one (signIn).');
    return only;
  }

  /** Only what the ferret can read for itself. Never the owner's taps, rules or passkeys. */
  #refuseUncoverable(signIn: SignInSummary): void {
    if (ruleSurfaceOf(signIn) === 'terminal' && this.ports.terminalRules?.() !== true)
      throw new SignInRuleSuggestionError('bad_request', 'No standing rule can cover this sign-in.');
    if (signIn.via !== undefined || signIn.method.via !== undefined || signIn.method.kind !== 'password')
      throw new SignInRuleSuggestionError('bad_request', 'No standing rule can cover this sign-in.');
  }

  async #whyOf(text: string): Promise<string> {
    const redacted = await this.ports.redact(text).catch(() => '(reason withheld)');
    const flat = oneLine(redacted, SIGN_IN_RULE_SUGGESTION_WHY_MAX_CHARS);
    return flat === '' ? '(no reason given)' : flat;
  }

  /** Synchronous: checks the hour's count and the session's open suggestions together, then takes one place. */
  #reserveHour(sessionId: string, now: number): { kept(): void; release(): void } {
    const recent = (this.#raised.get(sessionId) ?? []).filter(at => at > now - HOUR_MS);
    if (recent.length >= SIGN_IN_RULE_SUGGESTIONS_PER_HOUR)
      throw new SignInRuleSuggestionError(
        'capacity',
        `This session already suggested ${String(SIGN_IN_RULE_SUGGESTIONS_PER_HOUR)} rules this hour; wait.`,
      );
    this.#raised.set(sessionId, [...recent, now]);
    let kept = false;
    return {
      kept: () => {
        kept = true;
      },
      release: () => {
        if (kept) return;
        const times = [...(this.#raised.get(sessionId) ?? [])];
        const at = times.lastIndexOf(now);
        if (at >= 0) times.splice(at, 1);
        this.#raised.set(sessionId, times);
      },
    };
  }

  /** Synchronous: one suggestion per sign-in per session, waiting or being raised. */
  #reserveSignIn(sessionId: string, signIn: SignInId): () => void {
    if (this.waiting(sessionId, signIn))
      throw new SignInRuleSuggestionError(
        'capacity',
        'You already suggested a rule for this sign-in and the owner has not answered; do not ask again.',
      );
    const raising = this.#raising.get(sessionId) ?? new Set<SignInId>();
    raising.add(signIn);
    this.#raising.set(sessionId, raising);
    return () => {
      raising.delete(signIn);
      if (raising.size === 0 && this.#raising.get(sessionId) === raising) this.#raising.delete(sessionId);
    };
  }

  async #record(subject: string, detail: AuditDetail): Promise<void> {
    await this.ports.audit
      .record({ event: 'security.changed', actor: { kind: 'host' }, subject, outcome: 'succeeded', detail })
      .catch(() => undefined);
  }
}

function viewOf(pending: Pending): SignInRuleSuggestionView {
  return {
    id: pending.id,
    signIn: pending.signIn,
    surface: pending.surface,
    host: pending.host,
    why: pending.why,
    agenda: pending.agenda,
    raisedAt: new Date(pending.raisedAt).toISOString(),
    expiresAt: new Date(pending.expiresAt).toISOString(),
  };
}
