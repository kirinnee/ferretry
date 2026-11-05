/**
 * THE RECIPE CARD ON THE AGENDA (`recipeProposal` on an item): what the owner is asked to approve, read from the
 * daemon's owner-only accounts read (`GET /v1/accounts`, masked there), never from the card's own words. Agenda
 * text is every ferret's to read, so the card names only the place; the account and the whole diff come from here.
 *
 * Pure and total: the host reads, this decides what the card may offer.
 */

import type {
  AccountList,
  AccountSummary,
  AgendaRecipeProposalRef,
  LoginRecipeProposal,
  SignInSummary,
} from '@ferretry/protocol';
import { grantRefusalNotice } from './grants.ts';

export type RecipeProposalView =
  /** The proposal is waiting and was made against the recipe as it stands: Approve and Decline. */
  | {
      readonly kind: 'ready';
      readonly account: AccountSummary | undefined;
      readonly signIn: SignInSummary;
      readonly proposal: LoginRecipeProposal;
    }
  /** The recipe changed after the ferret suggested this: the daemon would refuse an approval, so only Decline. */
  | {
      readonly kind: 'stale';
      readonly account: AccountSummary | undefined;
      readonly signIn: SignInSummary;
      readonly proposal: LoginRecipeProposal;
    }
  /** No such proposal waits any more: answered, pushed out by a newer one, or the sign-in is gone. */
  | { readonly kind: 'gone' };

/** What the card offers for this pointer, as the accounts read stands. */
export function recipeProposalView(list: AccountList, ref: AgendaRecipeProposalRef): RecipeProposalView {
  const signIn = list.signIns.find(each => each.id === ref.signIn);
  const proposal = signIn?.proposals?.find(each => each.id === ref.proposal);
  if (signIn === undefined || proposal === undefined) return { kind: 'gone' };
  const account = list.accounts.find(each => each.id === signIn.account);
  return { kind: proposal.base === signIn.recipe ? 'ready' : 'stale', account, signIn, proposal };
}

export const RECIPE_APPROVED_WORDS = 'Approved. Ferrets follow the new steps when they sign in here.';
export const RECIPE_DECLINED_WORDS = 'Declined. The recipe stays as it was.';
export const RECIPE_GONE_WORDS = 'This suggestion is no longer waiting: it was answered, or a newer one replaced it.';
export const RECIPE_STALE_WORDS =
  'The recipe changed after the ferret suggested this, so it can no longer be approved. Decline it, or ask the ferret to suggest again.';
export const RECIPE_UNREAD_WORDS =
  'Ferretry could not read this suggestion, so it cannot be answered here. Answer it in Settings › Accounts.';
export const RECIPE_APPROVE_MEANS = 'Approving makes these the steps every ferret follows when it signs in here.';

export const RECIPE_REFUSED_WHERE =
  'Answer it in Settings › Accounts on the machine, or run `fy account site recipe …` there.';

/**
 * What the owner may do next after the daemon would not take a decision.
 * - `retry`: a transient failure (network, timeout, 5xx, a busy machine): both buttons stay, pressing one again is right.
 * - `decline-only`: the recipe moved under the owner, so only Decline can still go through.
 * - `refused`: this device is not allowed to answer (401/403 or a grant refusal): Approve and Decline travel the same
 *   route and would be refused alike, so neither is drawn live, and the words say where to answer instead.
 * - `gone`: the daemon no longer knows the proposal.
 */
export type RecipeDecideFailure =
  | { readonly kind: 'retry'; readonly words: string }
  | { readonly kind: 'decline-only'; readonly words: string }
  | { readonly kind: 'refused'; readonly words: string }
  | { readonly kind: 'gone'; readonly words: string };

const fieldOf = (cause: unknown, key: 'code' | 'status'): unknown =>
  typeof cause === 'object' && cause !== null && key in cause ? (cause as Record<string, unknown>)[key] : undefined;

const REFUSAL_CODES: ReadonlySet<string> = new Set(['forbidden', 'not_permitted', 'unauthorized', 'owner_only']);

/** Sorts a failed decision by what the owner can do about it; the daemon's own sentence is kept when it gave one. */
export function classifyRecipeDecideFailure(cause: unknown): RecipeDecideFailure {
  const code = fieldOf(cause, 'code');
  if (code === 'stale_proposal') return { kind: 'decline-only', words: RECIPE_STALE_WORDS };
  if (code === 'unknown_proposal') return { kind: 'gone', words: RECIPE_GONE_WORDS };
  const message = cause instanceof Error ? cause.message.trim() : '';
  const status = fieldOf(cause, 'status');
  if (
    status === 401 ||
    status === 403 ||
    (typeof code === 'string' && REFUSAL_CODES.has(code)) ||
    grantRefusalNotice(cause) !== null
  ) {
    const said = message === '' ? 'This device may not answer this.' : message;
    return { kind: 'refused', words: `${said} ${RECIPE_REFUSED_WHERE}` };
  }
  return {
    kind: 'retry',
    words: message === '' ? 'That did not go through. Try again, or answer it in Settings › Accounts.' : message,
  };
}
