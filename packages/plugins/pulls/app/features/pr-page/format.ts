import type { CiState, PullDetail, PullReview } from '../../../contract/index.ts';

/** A time in the device's own timezone and language. */
export const localTime = (instant: string): string => {
  const at = new Date(instant);
  return Number.isNaN(at.getTime())
    ? instant
    : at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

export const STATE_WORDS: Readonly<Record<PullDetail['state'], string>> = {
  open: 'Open',
  closed: 'Closed',
  merged: 'Merged',
};

export const REVIEW_WORDS: Readonly<Record<PullDetail['review'], string>> = {
  none: 'No review',
  review_required: 'Review required',
  approved: 'Approved',
  changes_requested: 'Changes requested',
};

export const VERDICT_WORDS: Readonly<Record<PullReview['verdict'], string>> = {
  approved: 'approved',
  changes_requested: 'requested changes',
  commented: 'reviewed',
  dismissed: 'review dismissed',
  pending: 'pending',
};

export const CI_WORDS: Readonly<Record<CiState, string>> = {
  none: 'No checks',
  queued: 'Checks queued',
  running: 'Checks running',
  passing: 'Checks passing',
  failing: 'Checks failing',
  cancelled: 'Checks cancelled',
};

export const initial = (login: string): string => (login.replace(/^[^A-Za-z0-9]+/u, '')[0] ?? '?').toUpperCase();
