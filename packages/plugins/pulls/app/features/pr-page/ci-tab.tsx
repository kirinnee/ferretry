import { Badge } from '@ferretry/app/ui';
import type { BadgeTone } from '@ferretry/app/ui';
import type { CiStatus, PullChecks, PullDetail } from '../../../contract/index.ts';
import { CI_WORDS } from './format.ts';

const TONE: Readonly<Record<CiStatus, BadgeTone>> = {
  queued: 'pend',
  running: 'warn',
  passed: 'ok',
  failed: 'err',
  cancelled: 'pend',
  skipped: 'pend',
};
const WORDS: Readonly<Record<CiStatus, string>> = {
  queued: 'Queued',
  running: 'Running',
  passed: 'Passed',
  failed: 'Failed',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
};

/** The head commit's checks: one line of counts, then each check with its state. Runs, jobs and timing come later. */
export function CiTab({ pull, checks }: { readonly pull: PullDetail; readonly checks: PullChecks }) {
  return (
    <section aria-label="CI" className="kt-panel grid gap-sm p-panel" data-pull-ci-tab="">
      <p className="m-0 text-ui text-fg" data-pull-ci-summary={checks.state}>
        {CI_WORDS[checks.state]}
        {checks.total === 0
          ? '.'
          : `: ${checks.passed} passed, ${checks.failed} failed, ${checks.running} running, ${checks.queued} queued of ${checks.total}.`}
      </p>
      {checks.items.length > 0 && (
        <ul className="m-0 grid list-none gap-xs p-0">
          {checks.items.map((check, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: check names repeat across workflows; the list keeps its order
            <li className="flex min-w-0 items-center justify-between gap-sm" data-pull-check={check.status} key={index}>
              <span className="min-w-0 truncate text-ui text-fg">
                {check.url === undefined ? (
                  check.name
                ) : (
                  <a href={check.url} rel="noopener noreferrer" target="_blank">
                    {check.name}
                  </a>
                )}
              </span>
              <Badge tone={TONE[check.status]}>{WORDS[check.status]}</Badge>
            </li>
          ))}
        </ul>
      )}
      <p className="m-0 text-meta text-muted">
        <a href={`${pull.url}/checks`} rel="noopener noreferrer" target="_blank">
          Open the checks on GitHub
        </a>
      </p>
    </section>
  );
}
