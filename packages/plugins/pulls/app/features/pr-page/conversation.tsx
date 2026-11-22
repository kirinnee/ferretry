import { Badge, Button, ExternalLink } from '@ferretry/app/ui';
import { type ReactNode, useMemo, useState } from 'react';
import type { PullComment, PullDetail, PullPage, PullReview } from '../../../contract/index.ts';
import { timeline } from '../../lib/timeline.ts';
import { OpenComment, QuoteScope } from '../compose/index.ts';
import { initial, localTime, VERDICT_WORDS } from './format.ts';
import { trimSpace } from './prose-model.ts';
import { SafeProse } from './safe-prose.tsx';

/**
 * Entries drawn at first, and added by each "Show more". The wire allows 500 comments and 500 reviews of 65,536 characters
 * each, so drawing every entry is a page a hostile PR can hang; a long text inside an entry is collapsed too (`SafeProse`).
 */
export const ENTRY_STEP = 20;

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
              <ExternalLink href={url}>{localTime(when)}</ExternalLink>
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
  const all = useMemo(() => timeline(page.comments, page.reviews), [page.comments, page.reviews]);
  const [limit, setLimit] = useState(ENTRY_STEP);
  const entries = all.slice(0, limit);
  const left = all.length - entries.length;
  return (
    <QuoteScope>
      <div className="grid gap-panel" data-pull-conversation="">
        <Entry login={pull.author.login} url={pull.url} verb="opened this" when={pull.createdAt}>
          {trimSpace(pull.body) === '' ? (
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
        {left > 0 && (
          <p className="m-0" data-pull-more="">
            <Button onClick={() => setLimit(value => value + ENTRY_STEP)} size="sm" type="button">
              Show {Math.min(left, ENTRY_STEP)} more ({left} not shown yet)
            </Button>
          </p>
        )}
        <OpenComment />
        {page.truncated && (
          <p className="m-0 text-meta text-warn" role="status">
            This page shows the first {page.comments.length} comments and {page.reviews.length} reviews.{' '}
            <ExternalLink href={pull.url}>Read the rest on GitHub</ExternalLink>.
          </p>
        )}
      </div>
    </QuoteScope>
  );
}
