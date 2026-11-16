/**
 * WHAT A PHONE APPROVAL ASKS OF THE REST OF THE MACHINE (docs/input-requests.md, "Approve on your phone"), as ports the
 * composition binds: the Vault's looks at a page and a terminal, the card (Asks), the buzz (Access), the security log
 * (Gate) and Accounts' own saved sign-ins. Every one is total: a look that cannot be made is "nothing", a push or a
 * log that fails never ends an approval, and a port that is not bound fails the approval closed.
 */
import type { ObserveResult, PushNumberRead } from '@ferretry/core-vault/contract';
import type { LoginObservation, PhoneApproval, SignInId } from '../../../contract/routes/index.ts';
import type { InputActor, SavedListing } from '../vault-inputs.ts';

/** The page as an approval needs it: one look for the number, in the page's own queue. */
export interface PhoneApprovalPagePort {
  /**
   * The ferret's page `key` now: its id and what the browser read there, from a provider's own challenge view only.
   * Nothing when there is no such page, or the browser cannot read a number at all.
   */
  look(ferret: string, key: string): Promise<{ readonly pageId: string; readonly read: PushNumberRead } | undefined>;
}

/** The terminal as an approval needs it: what the input bridge observes there (its prompt line and program). */
export interface PhoneApprovalTerminalPort {
  observe(ferret: string, key: string): Promise<ObserveResult>;
}

/** The card on the owner's agenda: an ask carrying the approval's ref, worded by the daemon. */
export interface PhoneApprovalCard {
  readonly approvalId: string;
  readonly title: string;
  readonly subject: string;
  readonly why: string;
  readonly context: string;
  readonly howToResolve: string;
}

/** Why a card is closed: the owner's "Not me", the clock, the session, or the approval's own move-on. */
export type PhoneApprovalClose = 'answered' | 'expired' | 'withdrawn' | 'source-gone';

export interface PhoneApprovalAsksPort {
  raise(ferret: string, card: PhoneApprovalCard): Promise<{ ok: true; id: string } | { ok: false; message: string }>;
  /** Resolve the card as the daemon's own act; never throws for a card that is already gone. */
  close(ferret: string, id: string, reason: PhoneApprovalClose): Promise<void>;
  /** The open cards of every ferret that present an approval: a restart closes them, since no approval outlives one. */
  open(): Promise<readonly { readonly ferret: string; readonly id: string }[]>;
}

/** The phone's buzz for a card: one at the raise and one per new number, under the tag `pa-<id>`. Total. */
export interface PhoneApprovalPushPort {
  push(
    ferret: string,
    askId: string,
    approval: { readonly id: string; readonly body: string; readonly sequence: number; readonly secondsLeft: number },
  ): Promise<void>;
  /** Takes the approval's push down on every device: it lasts no longer than its card (I208). Total. */
  clear(ferret: string, approvalId: string): Promise<void>;
}

export type PhoneApprovalAuditEvent = 'phone-approval.raised' | 'phone-approval.refused' | 'phone-approval.settled';

/** The security log: the approval's own fields (never its number), and who acted. */
export interface PhoneApprovalAudit {
  record(entry: {
    readonly event: PhoneApprovalAuditEvent;
    readonly actor: InputActor | { readonly kind: 'agent' } | { readonly kind: 'daemon' };
    readonly approval: PhoneApproval;
    /** The sign-in moved on, but the ferret acted on that kind of surface meanwhile: no fact was kept. */
    readonly steered?: boolean;
  }): Promise<void>;
}

/** Tells a ferret something in its own terminal (Asks' `tell`, which only the Vault is handed). Optional. */
export interface PhoneApprovalNotifier {
  tell(ferret: string, message: string): Promise<void>;
}

/** Whether the ferret could have steered a surface of this kind since `since` (`VaultApi.tainted`). */
export interface PhoneApprovalObserver {
  tainted(ferret: string, kind: 'browser' | 'terminal', since: number): boolean;
}

/** The sign-in fact `secondFactor: 'push'` is kept at Accounts' own directory (`AccountDirectory.observeSignIn`). */
export interface PhoneApprovalFacts {
  observeSignIn(id: SignInId, seen: LoginObservation): Promise<void>;
}

/** Saved accounts, by their non-secret listing: which sign-in this is. */
export interface PhoneApprovalLogins {
  listing(): Promise<SavedListing>;
}

export interface PhoneApprovalClock {
  now(): number;
}

export interface PhoneApprovalTimers {
  after(milliseconds: number): Promise<void>;
}
