/**
 * REVIEWING A SUGGESTED GUIDE: the decisions the review makes, as pure functions of the suggestion the
 * builder wrote and the rows the person ticked. The diff and the per-use-case merge are the protocol's own
 * (`diffGuide`, `mergeGuide`), shared with `fy guide suggest`, so the app and the CLI review a draft by the
 * same rules; this file only turns ticks into the request that writes it.
 *
 * Nothing here writes anything: a suggestion is applied only by the request this builds, and only when a
 * person presses Accept.
 */

import {
  changingIds,
  diffGuide,
  type GuideRouting,
  type GuideUseCase,
  type GuideUseCaseDiff,
  mergeGuide,
  type PackGuideAcceptRequest,
  type PackGuideNote,
  type PackGuideSuggestion,
  routingChanged,
} from '@ferretry/protocol';

/** A suggestion laid against the guide it would replace. */
export interface GuideReview {
  readonly rows: readonly GuideUseCaseDiff[];
  /** The ids a tick can accept: every row that is not `same`. */
  readonly changing: readonly string[];
  /** Whether the suggested routing guidance differs from the one in effect. */
  readonly routingDiffers: boolean;
}

export function reviewOf(suggestion: PackGuideSuggestion): GuideReview {
  const rows = diffGuide(suggestion.current.useCases, suggestion.useCases);
  return {
    rows,
    changing: changingIds(rows),
    routingDiffers: routingChanged(suggestion.current.routing, suggestion.routing),
  };
}

/** What is ticked: use cases by id, and whether the routing guidance is. */
export interface GuideTicks {
  readonly accepted: ReadonlySet<string>;
  readonly routing: boolean;
}

/** Everything that changes, ticked: what the review opens with and what "Accept all" sends. */
export const allTicks = (review: GuideReview): GuideTicks => ({
  accepted: new Set(review.changing),
  routing: review.routingDiffers,
});

/** Whether a tick would accept something: the buttons that apply a selection stay off until one does. */
export const anyTicked = (review: GuideReview, ticks: GuideTicks): boolean =>
  review.changing.some(id => ticks.accepted.has(id)) || (review.routingDiffers && ticks.routing);

/** Whether the ticks leave any change out. */
export const isPartial = (review: GuideReview, ticks: GuideTicks): boolean =>
  review.changing.some(id => !ticks.accepted.has(id)) || (review.routingDiffers && !ticks.routing);

/** The guide the ticks mean: the accepted use cases merged into the current ones, and the routing if ticked. */
export function ticked(
  suggestion: PackGuideSuggestion,
  review: GuideReview,
  ticks: GuideTicks,
): { readonly useCases: readonly GuideUseCase[]; readonly routing?: GuideRouting } {
  return {
    useCases: mergeGuide(suggestion.current.useCases, suggestion.useCases, ticks.accepted),
    ...(review.routingDiffers && ticks.routing ? { routing: suggestion.routing } : {}),
  };
}

/** The request that writes the ticked guide, `partial` only when something that changes was left out. */
export function acceptRequest(
  suggestion: PackGuideSuggestion,
  review: GuideReview,
  ticks: GuideTicks,
): PackGuideAcceptRequest {
  const guide = ticked(suggestion, review, ticks);
  return {
    ...guide,
    useCases: [...guide.useCases],
    suggested: suggestion.suggested,
    ...(isPartial(review, ticks) ? { partial: true } : {}),
  };
}

/** Who drafted it, on what, and when: "Suggested by gpt-6-astra on codex-main, 2026-10-22 14:30:00". */
export const suggestedLine = (suggested: PackGuideSuggestion['suggested'], at: string): string =>
  `Suggested by ${suggested.by} on ${suggested.via}, ${at}`;

/** One note from the check, in a plain sentence led by what it was about. */
export const noteSubject = (note: PackGuideNote): string => {
  const model =
    note.model === undefined ? '' : note.provider === undefined ? note.model : `${note.provider}/${note.model}`;
  return [note.useCase === undefined ? '' : `Use case ${note.useCase}`, model].filter(part => part !== '').join(' · ');
};
