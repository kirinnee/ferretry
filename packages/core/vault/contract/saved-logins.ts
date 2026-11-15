import { defineHook } from '@ferretry/kernel/contract';
import { z } from 'zod';

/**
 * SAVED LOGINS, as the Vault sees them (docs/input-requests.md). The Vault owns how an input card is drawn and delivered
 * (the offers, "Save as", the lock, the one guarded write); ACCOUNTS owns the accounts, the sign-ins and their sealed values.
 * So the dependency is inverted, as for secure copies: the Vault declares the hook below, Accounts PROVIDES it, and the
 * Vault never imports Accounts. No provider bound (Accounts is off): nothing is saved, every value is typed (fail closed).
 *
 * THE VALUE CROSSES THIS SEAM ONCE, in {@link SavedLoginsProvider.fill}: called at the write, after every check that can
 * refuse without typing, and its answer goes only to the target's `type`. Every other member answers facts, ids and
 * sentences. What the Vault is told is parsed at the Vault's boundary against its own strict schemas (`unknown` here), so
 * a provider that sent a field a ferret may not see would be refused rather than shown.
 */
export interface SavedLoginsProvider {
  /**
   * Every account and every sign-in, as the owner's listing shows them: names, places, methods and the facts the daemon
   * saw; never a value. Rejects when the store cannot tell.
   */
  listing(): Promise<unknown>;
  /**
   * THE USE BOUNDARY: the value one field of an entry types (its username, its password, or the one-time code (role `totp`) for `nowMs` made
   * from the key `options.factor` names, else from its first key in offer order). Rejects for a missing one.
   */
  fill(
    id: string,
    role: 'username' | 'password' | 'totp',
    nowMs: number,
    options?: { readonly factor?: string },
  ): Promise<string>;
  /**
   * "Save as": keeps typed values in ONE account in ONE change under the store-wide lock. `mode` (the owner's "New account"
   * or "Update") is checked under that lock; `pageUsername` is who the page is signing in, as the ferret typed it.
   */
  save(
    id: string,
    label: string,
    match: string | undefined,
    fields: { readonly username?: string; readonly password?: string },
    mode?: 'new' | 'update',
    pageUsername?: string,
  ): Promise<void>;
  /**
   * Who is asking, for the order of a sign-in card: the calling session's board project and folder and the owner's
   * defaults. Answered from what the daemon knows of the session; nothing in it makes a sign-in a match.
   */
  choice(sessionId: string): Promise<unknown>;
  /** What the daemon saw after a submit, kept as a fact of that sign-in (`seen` is the Vault's `LoginObservation`). */
  observeSignIn(id: string, seen: unknown): Promise<void>;
  /** What a one-time code the daemon made from this 2FA key came to. A key that is gone is ignored. */
  checkedByUse(account: string, factor: string, worked: boolean): Promise<void>;
}

/** The one key `input.saved` is provided under. */
export const SAVED_LOGINS_KEY = 'saved' as const;

/** Provided by Accounts and nobody else (`takers`): the accounts and the values they seal are Accounts'. */
export const InputSavedLogins = defineHook('input.saved', {
  mode: 'provide',
  key: z.literal(SAVED_LOGINS_KEY),
  value: z.custom<SavedLoginsProvider>(),
  takers: ['accounts'],
});
