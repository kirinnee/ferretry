/**
 * One open PR on the list (r9 E3): title and number, who wrote it, whether it is a draft, where its review stands, where
 * its CI stands and when it last changed. The whole row opens the PR page in the app; a second link opens it on GitHub.
 *
 * Everything a stranger wrote (a title, a login) is data: it is text, isolated for bidi (`<bdi>`), and breaks anywhere so
 * one unbroken name can never widen the page. The GitHub link is shown only for an `https://github.com` address.
 */
import { useScreenHref } from '@ferretry/app';
import { Badge, ExternalLink, RouteLink } from '@ferretry/app/ui';
import type { BadgeTone } from '@ferretry/app/ui';
import { ExternalLink as ExternalIcon } from 'lucide-react';
import { repoSegment } from '../../../contract/repo-segment.ts';
import type { CiState, WatchedPull } from '../../../contract/index.ts';
import type { CiStatus } from '../../../contract/wire.ts';
import { StatusIcon, STATUS_TEXT } from '../ci-run/ci-status.tsx';
import { localTime, REVIEW_WORDS } from '../pr-page/format.ts';
import { safeGithubUrl } from '../threads/place.ts';
import { agoLabel, CI_ROW_WORDS } from './model.ts';

/** The CI state a row shows, in the status vocabulary the CI pages use (so one icon means one thing everywhere). */
const CI_STATUS: Readonly<Record<CiState, CiStatus | undefined>> = {
  none: undefined,
  queued: 'queued',
  running: 'running',
  passing: 'passed',
  failing: 'failed',
  cancelled: 'cancelled',
};

const REVIEW_TONE: Readonly<Record<WatchedPull['review'], BadgeTone>> = {
  none: 'pend',
  review_required: 'warn',
  approved: 'ok',
  changes_requested: 'err',
};

export interface PullRowProps {
  readonly daemon: string;
  readonly project: string;
  readonly pull: WatchedPull;
  readonly nowMs: number;
  readonly onOpen: (to: string) => void;
}

export function PullRow({ daemon, project, pull, nowMs, onOpen }: PullRowProps) {
  const hrefOf = useScreenHref();
  const to = hrefOf(daemon, 'pulls', 'pull', {
    project,
    repo: repoSegment(pull.repo),
    number: String(pull.number),
  });
  const github = safeGithubUrl(pull.url);
  const ci = CI_STATUS[pull.ci];
  const body = (
    <>
      <span className="min-w-0 flex-1">
        <span className="block min-w-0 text-ui font-medium text-fg [overflow-wrap:anywhere]">
          <bdi>{pull.title}</bdi> <span className="font-normal text-muted">#{pull.number}</span>
        </span>
        <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-xs gap-y-1 text-meta text-muted">
          <span className="[overflow-wrap:anywhere]">
            <bdi>{pull.author.login}</bdi>
          </span>
          {pull.draft && (
            <Badge data-pull-draft="" tone="pend">
              Draft
            </Badge>
          )}
          {pull.review !== 'none' && (
            <Badge data-pull-review={pull.review} tone={REVIEW_TONE[pull.review]}>
              {REVIEW_WORDS[pull.review]}
            </Badge>
          )}
          {pull.requestedMe && (
            <Badge data-pull-asked="" tone="accent">
              Review asked of you
            </Badge>
          )}
          <time dateTime={pull.updatedAt} title={localTime(pull.updatedAt)}>
            updated {agoLabel(nowMs, pull.updatedAt)}
          </time>
        </span>
      </span>
      <span
        className={`inline-flex shrink-0 items-center gap-1 text-meta font-medium ${ci === undefined ? 'text-faint' : STATUS_TEXT[ci]}`}
        data-pull-ci={pull.ci}
      >
        {ci !== undefined && <StatusIcon status={ci} />}
        {CI_ROW_WORDS[pull.ci]}
      </span>
    </>
  );
  // On a phone the CI state sits under the title, so a long title keeps the whole row; from `sm` it sits at the right.
  const row =
    'flex min-h-control min-w-0 flex-1 flex-col items-start gap-xs px-control-x py-row-y text-left no-underline sm:flex-row sm:gap-sm';
  return (
    <li className="flex min-w-0 items-stretch" data-pull-row={pull.number}>
      {to === undefined ? (
        <div className={row}>{body}</div>
      ) : (
        <RouteLink to={to} onNavigate={onOpen} className={`${row} hover:bg-hover-fill`}>
          {body}
        </RouteLink>
      )}
      {github !== undefined && (
        <ExternalLink className="flex shrink-0 items-center px-control-x text-muted hover:text-fg" href={github}>
          <ExternalIcon aria-hidden="true" size={16} />
          <span className="sr-only">Open #{pull.number} on GitHub</span>
        </ExternalLink>
      )}
    </li>
  );
}
