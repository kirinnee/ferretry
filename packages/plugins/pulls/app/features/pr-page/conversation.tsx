import { Badge } from '@ferretry/app/ui';
import type { ReactNode } from 'react';
import type { PullComment, PullDetail, PullPage, PullReview } from '../../../contract/index.ts';
import { timeline } from '../../lib/timeline.ts';
import { OpenComment, QuoteScope } from '../compose/index.ts';
import { initial, localTime, VERDICT_WORDS } from './format.ts';
import { SafeProse } from './safe-prose.tsx';

function Who({ login }: { readonly login: string }) {
  // No avatar address is ever drawn: a picture from GitHub's servers would be a request made for a stranger.
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-2 text-2xs font-semibold text-muted"
    >
      {initial(login)}
    </span>
  );
}

function Entry({
  login,
  when,
  url,
  verb,
  children,
}: {
  readonly login: string;
  readonly when: string | undefined;
  readonly url: string;
  readonly verb: string;
  readonly children: ReactNode;
}) {
  return (
    <article className="kt-panel grid gap-xs p-panel" data-pull-entry="">
      <header className="flex items-start gap-xs text-meta text-muted">
        <Who login={login} />
        <p className="m-0 min-w-0 break-words">
          <strong className="font-medium text-fg">
            <bdi>{login}</bdi>
          </strong>{' '}
          {verb}
          {when !== undefined && (
            <>
              {' · '}
              <a href={url} rel="noopener noreferrer" target="_blank">
                {localTime(when)}
              </a>
            </>
          )}
        </p>
      </header>
      {children}
    </article>
  );
}

function CommentEntry({ comment }: { readonly comment: PullComment }) {
  return (
    <Entry login={comment.author.login} url={comment.url} verb="commented" when={comment.createdAt}>
      <SafeProse sourceUrl={comment.url} text={comment.body} />
    </Entry>
  );
}

function ReviewEntry({ review }: { readonly review: PullReview }) {
  return (
    <Entry login={review.author.login} url={review.url} verb={VERDICT_WORDS[review.verdict]} when={review.submittedAt}>
      <div>
        <Badge
          data-pull-verdict={review.verdict}
          tone={review.verdict === 'approved' ? 'ok' : review.verdict === 'changes_requested' ? 'err' : 'pend'}
        >
          {VERDICT_WORDS[review.verdict]}
        </Badge>
      </div>
      {review.body !== '' && <SafeProse sourceUrl={review.url} text={review.body} />}
    </Entry>
  );
}

/** The description, then every comment and review in the order they happened. */
export function Conversation({ page }: { readonly page: PullPage }) {
  const pull: PullDetail = page.pull;
  const entries = timeline(page.comments, page.reviews);
  return (
    <QuoteScope>
      <div className="grid gap-panel" data-pull-conversation="">
        <Entry login={pull.author.login} url={pull.url} verb="opened this" when={pull.createdAt}>
          {pull.body.trim() === '' ? (
            <p className="m-0 text-meta text-faint">No description provided.</p>
          ) : (
            <SafeProse sourceUrl={pull.url} text={pull.body} />
          )}
        </Entry>
        {entries.map(entry =>
          entry.kind === 'comment' ? (
            <CommentEntry comment={entry.comment} key={`c${entry.comment.id}`} />
          ) : (
            <ReviewEntry key={`r${entry.review.id}`} review={entry.review} />
          ),
        )}
        <OpenComment />
        {page.truncated && (
          <p className="m-0 text-meta text-warn" role="status">
            This page shows the first {page.comments.length} comments and {page.reviews.length} reviews.{' '}
            <a href={pull.url} rel="noopener noreferrer" target="_blank">
              Read the rest on GitHub
            </a>
            .
          </p>
        )}
      </div>
    </QuoteScope>
  );
}
