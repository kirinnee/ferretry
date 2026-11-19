import type { WatchEvent } from '../../../contract/index.ts';
import { repoSegment } from '../../../contract/repo-segment.ts';
import type { WatchEventLine } from './events.ts';

/** One push, as Access takes it. Words only: never GitHub text beyond the PR's title, never a token. */
export interface PullBuzz {
  readonly tag: string;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly eventKey: string;
  readonly kind: 'pr' | 'ci';
}

const HEAD: Readonly<Record<WatchEvent, string>> = {
  ciFailed: 'CI failed on',
  reviewRequested: 'Review requested on',
  changesRequested: 'Changes requested on',
  approved: 'Approved:',
  ciPassed: 'CI passed on',
  comment: 'New comment on',
  closed: 'Closed:',
};
const TITLE_CAP = 200;
const BODY_CAP = 200;
// A stranger's title may carry control and format characters (bidi overrides, a bell, newlines).
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

export const cleanTitle = (title: string): string => title.replace(UNSAFE, ' ').replace(/\s+/gu, ' ').trim();

/**
 * The push for one event. The line says what happened and which PR (`#12`); the body is the PR's TITLE, cleaned and cut,
 * and nothing else GitHub wrote. The tag is the PR's, so a newer line replaces the older one; the page it opens is the
 * PR's page under the project.
 */
export function buzzOf(project: string, line: WatchEventLine): PullBuzz {
  const { repo, number } = line.pull;
  const head = line.event === 'closed' && line.merged === true ? 'Merged:' : HEAD[line.event];
  const slug = `${repo.owner}/${repo.name}`;
  return {
    tag: `pr-${repo.owner}:${repo.name}-${number}`,
    title: `${head} #${number}`.slice(0, TITLE_CAP),
    body: cleanTitle(line.pull.title).slice(0, BODY_CAP) || slug,
    url: `/pulls/${encodeURIComponent(project)}/${repoSegment(repo)}/${number}`,
    eventKey: `pulls:${project}:${line.key}`.slice(0, 400),
    kind: line.event === 'ciFailed' || line.event === 'ciPassed' ? 'ci' : 'pr',
  };
}
