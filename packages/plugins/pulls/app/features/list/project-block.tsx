/**
 * One project's PRs (r9 E3), used by the PRs screen (one block per project) and by the project page's section (one
 * block, no name): the watch switch, why anything is missing or paused, and the open PRs grouped by repository.
 *
 * What is drawn is bounded twice, and nothing is ever dropped: the first REPOS_OPEN repositories start open and the rest
 * start folded to a header button (a keyboard-reachable toggle), and an open repository shows its first PAGE rows and a
 * button for the rest, so a project with 50 repositories of 100 PRs mounts a few dozen rows, not five thousand. Times come from the caller's one clock.
 */
import { ChevronDown, ChevronRight, PauseCircle } from 'lucide-react';
import { useState } from 'react';
import { budgetSentence, type WatchProjectView } from '../../../contract/index.ts';
import { localTime } from '../pr-page/format.ts';
import { PullRow } from './pull-row.tsx';
import {
  agoLabel,
  EMPTY_WORDS,
  emptyReason,
  type Filter,
  folded,
  groupsOf,
  NEEDS_PAGE,
  PAGE,
  type RepoGroup,
  REPOS_OPEN,
} from './model.ts';
import type { ListClient } from './api.ts';
import { WatchControls } from './watch-controls.tsx';

interface Shared {
  readonly daemon: string;
  readonly nowMs: number;
  readonly onOpen: (to: string) => void;
}

function RepoList({
  group,
  open,
  onToggle,
  project,
  shared,
}: {
  readonly group: RepoGroup;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly project: string;
  readonly shared: Shared;
}) {
  const [limit, setLimit] = useState(PAGE);
  const { shown, more } = folded(group.pulls, limit);
  return (
    <section
      aria-label={`${group.repo.owner}/${group.repo.name}`}
      className="grid gap-xs"
      data-pulls-repo={group.repo.name}
    >
      <h3 className="m-0 min-w-0 text-ui font-semibold text-fg">
        <button
          aria-expanded={open}
          className="flex w-full min-w-0 cursor-pointer flex-wrap items-baseline gap-x-xs border-0 bg-transparent p-0 text-left font-[inherit] text-[inherit] text-fg"
          data-pulls-repo-toggle=""
          onClick={onToggle}
          type="button"
        >
          {open ? (
            <ChevronDown aria-hidden="true" className="mt-[3px] shrink-0 self-start" size={14} />
          ) : (
            <ChevronRight aria-hidden="true" className="mt-[3px] shrink-0 self-start" size={14} />
          )}
          <span className="min-w-0 [overflow-wrap:anywhere]">
            <bdi>
              {group.repo.owner}/{group.repo.name}
            </bdi>
          </span>
          <span className="text-meta font-normal text-muted">
            {group.pulls.length === group.open ? `${group.open} open` : `${group.pulls.length} of ${group.open} open`}
            {' · '}read {agoLabel(shared.nowMs, group.checkedAt)}
          </span>
        </button>
      </h3>
      {group.problem !== undefined && (
        <p className="m-0 text-meta text-warn" role="status">
          The last read of this repository did not work ({group.problem}), so this is what was seen before.
        </p>
      )}
      {open && group.pulls.length > 0 && (
        <ul className="kt-panel m-0 list-none divide-y divide-border-soft p-0">
          {shown.map(pull => (
            <PullRow
              daemon={shared.daemon}
              key={pull.number}
              nowMs={shared.nowMs}
              onOpen={shared.onOpen}
              project={project}
              pull={pull}
            />
          ))}
        </ul>
      )}
      {open && more > 0 && (
        <button className="kt-btn kt-btn--sm w-fit" onClick={() => setLimit(value => value + PAGE)} type="button">
          {more > PAGE ? `Show ${PAGE} more (${more} hidden)` : `Show ${more} more`}
        </button>
      )}
    </section>
  );
}

function NeedsAccount({ view }: { readonly view: WatchProjectView }) {
  const [limit, setLimit] = useState(NEEDS_PAGE);
  const { shown, more } = folded(view.needsAccount, limit);
  if (view.needsAccount.length === 0) return null;
  return (
    <div className="grid gap-1 text-meta text-warn" data-pulls-needs-account="" role="status">
      <p className="m-0">Connect a GitHub account to this project to read:</p>
      <ul className="m-0 grid list-none gap-1 p-0">
        {shown.map(repo => (
          <li className="mono text-fg [overflow-wrap:anywhere]" key={`${repo.owner}/${repo.name}`}>
            <bdi>
              {repo.owner}/{repo.name}
            </bdi>
          </li>
        ))}
      </ul>
      {more > 0 && (
        <button
          className="kt-btn kt-btn--sm w-fit"
          onClick={() => setLimit(value => value + NEEDS_PAGE * 4)}
          type="button"
        >
          and {more} more
        </button>
      )}
    </div>
  );
}

export interface ProjectBlockProps extends Shared {
  readonly client: ListClient;
  readonly view: WatchProjectView;
  readonly filter: Filter;
  /** The project's own record says its folder holds no repository (see `emptyReason`). */
  readonly noRepo: boolean;
  readonly onChanged: () => void;
}

export function ProjectBlock({ client, view, filter, noRepo, onChanged, ...shared }: ProjectBlockProps) {
  const groups = groupsOf(view, filter);
  const reason = emptyReason(view, groups, filter, noRepo);
  // What the owner opened or folded by hand, by repository: the first REPOS_OPEN repositories start open and the rest
  // start folded, so a project with 50 repositories draws 50 headers and a bounded number of rows, never thousands.
  const [chosen, setChosen] = useState<ReadonlyMap<string, boolean>>(new Map());
  const listed = groups.filter(group => group.pulls.length > 0 || group.problem !== undefined);
  return (
    <div className="grid gap-sm" data-pulls-project={view.project}>
      <WatchControls client={client} onChanged={onChanged} view={view} />
      {view.watch && view.pausedUntil !== undefined && (
        <p
          className="m-0 flex items-start gap-xs rounded-control border border-border-strong bg-surface-2 p-xs text-meta text-warn"
          data-pulls-paused=""
          role="status"
        >
          <PauseCircle aria-hidden="true" className="mt-px shrink-0" size={16} />
          <span>{budgetSentence(localTime(view.pausedUntil))}. The list below is what was seen before.</span>
        </p>
      )}
      {view.watch && <NeedsAccount view={view} />}
      {reason !== undefined && (
        <p className="m-0 text-meta text-muted" data-pulls-empty={reason}>
          {EMPTY_WORDS[reason]}
        </p>
      )}
      {view.watch &&
        listed.map((group, index) => {
          const key = `${group.repo.owner}/${group.repo.name}`;
          const open = chosen.get(key) ?? index < REPOS_OPEN;
          return (
            <RepoList
              group={group}
              key={key}
              onToggle={() => setChosen(previous => new Map(previous).set(key, !open))}
              open={open}
              project={view.project}
              shared={shared}
            />
          );
        })}
    </div>
  );
}
