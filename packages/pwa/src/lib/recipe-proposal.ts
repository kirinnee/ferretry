/**
 * A ferret's SUGGESTED SIGN-IN RECIPE, AS DECISIONS (docs/input-requests.md, "A recipe proposal on its card").
 *
 * What the card draws and says, as pure functions: the steps of the proposed recipe against the one it replaces, the
 * sentence a refusal becomes, and how the proposal is found in the secrets-gated accounts listing. A recipe holds no
 * value, so nothing here touches one. The ferret's words are never mixed with the daemon's own observations.
 */

import {
  type AccountList,
  type AgendaItem,
  LOGIN_RECIPE_MAX_LENGTH,
  type LoginRecipeProposal,
  type Place,
  placeKeys,
  type SignInSummary,
  recipeDiff,
} from '@ferretry/protocol';

export const RECIPE_STALE_WORDS =
  'The recipe changed after this was suggested, so nothing was saved. Read the current steps again before you decide.';
export const RECIPE_OBSOLETE_WORDS =
  'The recipe changed after this was suggested, so these steps can no longer be approved. Decline them and ask the ferret to suggest again, or edit the recipe in Settings.';
export const RECIPE_APPROVES_WORDS =
  'A recipe never holds a password or a code. Approving only changes the steps Ferretry follows.';
export const RECIPE_SAW_NOTE = 'Its own checks while signing in, not the ferret’s words.';

/** One step of the proposed recipe, as the card lists it. A removed step has no number: it is not a step any more. */
export interface RecipeStep {
  readonly kind: 'kept' | 'added' | 'removed';
  readonly text: string;
  readonly number?: number;
}

export interface RecipeChange {
  readonly steps: readonly RecipeStep[];
  readonly added: number;
  readonly removed: number;
}

const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+/u;

/** The proposed recipe against the one it was made from: numbered where it will be, struck where it goes. */
export function recipeChange(base: string | undefined, recipe: string): RecipeChange {
  const steps: RecipeStep[] = [];
  let number = 0;
  let added = 0;
  let removed = 0;
  for (const line of recipeDiff(base, recipe)) {
    if (line.text.trim() === '') continue;
    // The card numbers the steps itself, so a Markdown list marker would number them twice.
    const text = line.text.replace(LIST_MARKER, '').trim();
    if (line.op === '-') {
      removed += 1;
      steps.push({ kind: 'removed', text });
      continue;
    }
    number += 1;
    if (line.op === '+') added += 1;
    steps.push({ kind: line.op === '+' ? 'added' : 'kept', text, number });
  }
  return { steps, added, removed };
}

/** "v3 → proposed · 2 added, 1 removed". */
export function changeWords(version: number | undefined, change: Pick<RecipeChange, 'added' | 'removed'>): string {
  const counts = [
    ...(change.added > 0 ? [`${String(change.added)} added`] : []),
    ...(change.removed > 0 ? [`${String(change.removed)} removed`] : []),
  ];
  const from = version === undefined ? 'No recipe yet' : `v${String(version)}`;
  return `${from} → proposed · ${counts.length === 0 ? 'no change' : counts.join(', ')}`;
}

/** The place in a few words: what the recipe is for, without "on" or "for". */
export function placeName(place: Place): string {
  if (place.kind === 'terminal') return placeKeys(place).join(', ');
  return (place.domains.length > 0 ? place.domains : place.match).join(', ');
}

export interface FoundRecipeProposal {
  readonly signIn: SignInSummary;
  readonly proposal: LoginRecipeProposal;
  readonly place: string;
}

/** The sign-in an agenda item's ref names and the proposal it holds; nothing when either is gone. */
export function findRecipeProposal(
  accounts: AccountList,
  ref: NonNullable<AgendaItem['recipeProposal']>,
): FoundRecipeProposal | undefined {
  const signIn = accounts.signIns.find(each => each.id === ref.signIn);
  const proposal = signIn?.proposals?.find(each => each.id === ref.id);
  if (signIn === undefined || proposal === undefined) return undefined;
  return { signIn, proposal, place: placeName(signIn.place) };
}

/** The words the card closes with, which the chat shows above the composer. */
export const doneWords = (decision: 'approve' | 'decline', place: string): string =>
  decision === 'approve' ? `Recipe for ${place} approved.` : 'Declined.';

const isStale = (cause: unknown): boolean =>
  typeof cause === 'object' &&
  cause !== null &&
  (('code' in cause && cause.code === 'stale_proposal') || ('status' in cause && cause.status === 409));

/** Whether the daemon refused because the recipe moved after the proposal; the host reads again then. */
export const isStaleProposal = isStale;

export function decisionFailureWords(cause: unknown): string {
  if (isStale(cause)) return RECIPE_STALE_WORDS;
  return cause instanceof Error ? cause.message : String(cause);
}

/** Why the owner's own version cannot be sent yet, or nothing. The daemon checks the text again either way. */
export function recipeEditProblem(text: string): string | undefined {
  if (text.trim() === '') return 'Write the steps first.';
  if (text.length > LOGIN_RECIPE_MAX_LENGTH)
    return `That is too long for a recipe (${String(LOGIN_RECIPE_MAX_LENGTH)} characters at most).`;
  return undefined;
}

/** The daemon now holds a different recipe from the one the proposal was made from: no approval of it can be saved. */
export const baseIsObsolete = (found: FoundRecipeProposal): boolean => found.proposal.base !== found.signIn.recipe;
