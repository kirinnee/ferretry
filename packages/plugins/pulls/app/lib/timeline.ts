import type { PullComment, PullReview } from '../../contract/index.ts';

/** One entry of the conversation: a comment, or a review (its verdict and the text sent with it). */
export type TimelineEntry =
  | { readonly kind: 'comment'; readonly at: string; readonly comment: PullComment }
  | { readonly kind: 'review'; readonly at: string; readonly review: PullReview };

/** Comments and reviews as one list, oldest first (ties keep comments before reviews, and each list's own order). */
export function timeline(comments: readonly PullComment[], reviews: readonly PullReview[]): readonly TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...comments.map(comment => ({ kind: 'comment' as const, at: comment.createdAt, comment })),
    ...reviews.map(review => ({ kind: 'review' as const, at: review.submittedAt ?? '', review })),
  ];
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => a.entry.at.localeCompare(b.entry.at) || a.index - b.index)
    .map(({ entry }) => entry);
}
