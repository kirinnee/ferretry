/**
 * What a recipe-proposal ask card draws, decided from the owner-only account list and nothing else (docs/input-requests.md,
 * "Login recipes"). The ask names a sign-in and a proposal by id; the account, the place, the ferret's reason and the whole
 * change are read from the daemon's masked answer, never from the ask's text. The card has no control a ferret could steer:
 * "Approve" sends the PIN of the proposal it drew, so what is approved is exactly what was shown.
 */

import type { AccountList, SignInId } from '../../contract/routes/index.ts';
import { accountTitle, placeTitle } from './accounts-screen.ts';

export const RECIPE_CARD_WORDS = {
  stale:
    'The recipe changed after the ferret suggested this, so it can only be declined. Ask the ferret again, or edit the recipe yourself in Settings › Accounts.',
  gone: 'This suggestion was already answered or replaced.',
  unreadable:
    'Ferretry could not show this change. Review it in Settings › Accounts, on the sign-in it names, or answer it with fy.',
  approved: 'Approved: this is now the recipe.',
  declined: 'Declined: the recipe is as it was.',
} as const;

export type RecipeCardModel =
  | { readonly kind: 'gone' }
  | { readonly kind: 'unreadable' }
  | {
      /** `stale`: the recipe moved on since the proposal, so only a decline is offered. */
      readonly kind: 'ready' | 'stale';
      readonly signIn: SignInId;
      readonly proposal: string;
      readonly who: string;
      readonly place: string;
      readonly why: string;
      readonly base: string | undefined;
      readonly recipe: string;
      readonly pin: string;
    };

/** The card for one proposal, or why there is none. A damaged list, or a proposal with no pin, is never approvable. */
export function recipeCardModel(list: AccountList, signIn: SignInId, proposal: string): RecipeCardModel {
  if (list.health === 'damaged') return { kind: 'unreadable' };
  const found = list.signIns.find(each => each.id === signIn);
  if (found === undefined) return { kind: 'gone' };
  const waiting = found.proposals?.find(each => each.id === proposal);
  if (waiting === undefined) return { kind: 'gone' };
  const account = list.accounts.find(each => each.id === found.account);
  if (account === undefined || waiting.pin === undefined) return { kind: 'unreadable' };
  return {
    kind: found.recipe === waiting.base ? 'ready' : 'stale',
    signIn,
    proposal,
    who: accountTitle(account),
    place: placeTitle(found.place),
    why: waiting.why,
    base: waiting.base,
    recipe: waiting.recipe,
    pin: waiting.pin,
  };
}
