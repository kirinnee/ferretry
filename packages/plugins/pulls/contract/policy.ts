/**
 * Policy entries (docs/grants.md): no new capability. Reading a project's PRs reads its private code (diffs), so it is
 * `filesystem.use`; the watch settings are `filesystem.configure`; posting as the person is `secrets.use` (E7: the
 * account is used on their behalf). E1 files no route; later units use these.
 */
import type { CapabilityDemand } from '@ferretry/kernel/contract';
import { cap } from '@ferretry/core-gate/contract';

export const PULLS_CAPS = {
  read: cap('filesystem', 'use'),
  configure: cap('filesystem', 'configure'),
  post: cap('secrets', 'use'),
} as const satisfies Readonly<Record<string, CapabilityDemand>>;

/** Ids and counts only: never a title, a body or a comment's text. */
export const PULLS_AUDIT = {
  commentPosted: 'pulls.comment.posted',
} as const;

/** Why a read did not answer. A closed list; none carries GitHub's text. */
export const PULLS_CODES = {
  paused: 'pulls_paused',
  noAccount: 'pulls_no_account',
  notFound: 'pulls_not_found',
  denied: 'pulls_denied',
  github: 'pulls_github_error',
  refused: 'pulls_refused',
} as const;
export type PullsCode = (typeof PULLS_CODES)[keyof typeof PULLS_CODES];
