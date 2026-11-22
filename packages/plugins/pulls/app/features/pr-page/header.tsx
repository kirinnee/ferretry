import { Badge, ExternalLink } from '@ferretry/app/ui';
import type { BadgeTone } from '@ferretry/app/ui';
import type { CiState, PullDetail } from '../../../contract/index.ts';
import { VisibleText } from '../diff/visible-text.tsx';
import { CI_WORDS, localTime, REVIEW_WORDS, STATE_WORDS } from './format.ts';

const MERGE_VERB: Readonly<Record<PullDetail['state'], string>> = {
  open: 'wants to merge',
  closed: 'wanted to merge',
  merged: 'merged',
};
const STATE_TONE: Readonly<Record<PullDetail['state'], BadgeTone>> = { open: 'ok', closed: 'err', merged: 'accent' };
const CI_TONE: Readonly<Record<CiState, BadgeTone>> = {
  none: 'pend',
  queued: 'pend',
  running: 'warn',
  passing: 'ok',
  failing: 'err',
  cancelled: 'pend',
};

/** The title, the state in words, who and when, the branches, and one line each for review and CI. */
export function PullHeader({ pull }: { readonly pull: PullDetail }) {
  const repo = `${pull.repo.owner}/${pull.repo.name}`;
  return (
    <header className="grid gap-xs border-b border-border-strong pb-panel" data-pull-header="">
      <p className="m-0 text-meta font-semibold uppercase tracking-wide text-muted">{repo}</p>
      <h1 className="m-0 break-words font-display text-display font-bold tracking-display">
        <VisibleText text={pull.title} /> <span className="font-normal text-muted">#{pull.number}</span>
      </h1>
      <div className="flex flex-wrap items-center gap-xs">
        <Badge
          data-pull-state={pull.state}
          tone={pull.draft && pull.state === 'open' ? 'pend' : STATE_TONE[pull.state]}
        >
          {pull.draft && pull.state === 'open' ? 'Draft' : STATE_WORDS[pull.state]}
        </Badge>
        <Badge
          data-pull-review={pull.review}
          tone={pull.review === 'changes_requested' ? 'err' : pull.review === 'approved' ? 'ok' : 'pend'}
        >
          {REVIEW_WORDS[pull.review]}
        </Badge>
        <Badge data-pull-ci={pull.ci} tone={CI_TONE[pull.ci]}>
          {CI_WORDS[pull.ci]}
        </Badge>
      </div>
      <p className="m-0 text-meta text-muted">
        <strong className="font-medium text-fg">
          <bdi>{pull.author.login}</bdi>
        </strong>{' '}
        {MERGE_VERB[pull.state]} <code>{pull.headRef}</code> into <code>{pull.baseRef}</code>
      </p>
      <p className="m-0 text-meta text-muted">
        Opened {localTime(pull.createdAt)} · updated {localTime(pull.updatedAt)}
        {pull.mergedAt === undefined ? '' : ` · merged ${localTime(pull.mergedAt)}`}
        {pull.mergedAt === undefined && pull.closedAt !== undefined ? ` · closed ${localTime(pull.closedAt)}` : ''}
      </p>
      <p className="m-0 text-meta text-muted">
        {pull.commits} {pull.commits === 1 ? 'commit' : 'commits'} · {pull.changedFiles}{' '}
        {pull.changedFiles === 1 ? 'file' : 'files'} · <span className="text-ok">+{pull.additions}</span>{' '}
        <span className="text-err">−{pull.deletions}</span>
        {pull.state !== 'open' || pull.requestedReviewers.length === 0
          ? ''
          : ` · review requested from ${pull.requestedReviewers.join(', ')}`}
      </p>
      <p className="m-0 text-meta">
        <ExternalLink href={pull.url}>Open on GitHub</ExternalLink>
      </p>
    </header>
  );
}
