/**
 * Policy entries (docs/grants.md): no new capability. Reading a project's PRs reads its private code (diffs), so it is
 * `filesystem.use`; the watch settings are `filesystem.configure`; posting as the person is `secrets.use` (E7: the
 * account is used on their behalf). E1 files no route; later units use these.
 */
import type { AuditDeclaration, CapabilityDemand, GuardDeclaration } from '@ferretry/kernel/contract';
import { cap } from '@ferretry/core-gate/contract';

export const PULLS_CAPS = {
  read: cap('filesystem', 'use'),
  configure: cap('filesystem', 'configure'),
  post: cap('secrets', 'use'),
} as const satisfies Readonly<Record<string, CapabilityDemand>>;

/** Ids and counts only: never a title, a body or a comment's text. */
export const PULLS_AUDIT = {
  commentPosted: 'pulls.comment.posted',
  /** E2: a project's watch or notify choice changed. The project id and which keys only. */
  watchChanged: 'pulls.watch.changed',
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

/** E2: the status read changes nothing. */
export const PULLS_AUDIT_SKIP = {
  read: { skip: 'a read: it changes nothing' },
  /** E7: a post records its own line through Gate (the project, repository, number, kind and comment id: never the text). */
  post: { skip: 'records its own audit line through Gate, with ids only and never the text' },
} as const satisfies Readonly<Record<string, AuditDeclaration>>;

/** What a route's output holds, for the guard (docs/grants.md): GitHub's PR facts, no pane, page or vault text. */
export const PULLS_GUARD = {
  none: 'PR titles, states and CI words of a project’s repositories; no pane, page or vault text, and never a token',
} as const satisfies GuardDeclaration;

/** What a post route's output holds: the new comment's id and address, and the login it was posted as. */
export const PULLS_GUARD_POST = {
  none: 'the id and GitHub address of a comment just posted, or the login of the account it posts as; never a token',
} as const satisfies GuardDeclaration;
