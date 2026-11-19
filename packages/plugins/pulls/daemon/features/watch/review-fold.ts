import type { RawReview } from './github-shapes.ts';

export type ReviewWord = 'none' | 'review_required' | 'approved' | 'changes_requested';

/**
 * Where reviewing stands: each reviewer's LATEST verdict counts (a comment-only review changes nobody's standing; a
 * dismissal clears it). Any open "changes requested" wins over approvals; with no verdict, a PR that still has somebody
 * asked to review is `review_required`.
 */
export function foldReviews(reviews: readonly RawReview[], requested: number): ReviewWord {
  const latest = new Map<string, 'APPROVED' | 'CHANGES_REQUESTED' | undefined>();
  const ordered = [...reviews].sort((a, b) => (a.submitted_at ?? '').localeCompare(b.submitted_at ?? ''));
  for (const review of ordered) {
    const who = review.user?.login;
    if (who === undefined) continue;
    if (review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED') latest.set(who, review.state);
    else if (review.state === 'DISMISSED') latest.set(who, undefined);
  }
  const verdicts = [...latest.values()];
  if (verdicts.includes('CHANGES_REQUESTED')) return 'changes_requested';
  if (verdicts.includes('APPROVED')) return 'approved';
  return requested > 0 ? 'review_required' : 'none';
}
