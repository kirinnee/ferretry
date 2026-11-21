/**
 * The PRs & CI screen (r9 E3): every project, its open PRs grouped by repository, and the watch switch per project.
 *
 * One read of the daemon's snapshot feeds the whole screen; a failed refresh keeps the last good list and says so. The
 * filter chips carry the counts of what they would show. Projects past the first PROJECT_PAGE fold behind a button.
 */
import { Loading, useNow } from '@ferretry/app/ui';
import { useState } from 'react';
import type { ListClient } from './api.ts';
import { countsOf, FILTER_WORDS, FILTERS, type Filter, folded, orderProjects, PROJECT_PAGE } from './model.ts';
import { useScreenHref } from '@ferretry/app';
import { ProjectBlock } from './project-block.tsx';
import { type Reading, useOverview } from './use-overview.ts';

export interface PullsListProps {
  readonly client: ListClient;
  readonly daemon: string;
  /** Where a tap on a PR goes (the shell's router in the app, anything in a harness). */
  readonly onNavigate: (to: string) => void;
  /** A fixed instant (a test, a screenshot); the real screen reads the app's one clock. */
  readonly nowMs?: number;
}

const shortId = (id: string): string => id.slice(0, 8);

export function PullsList({ client, daemon, onNavigate, nowMs }: PullsListProps) {
  const { reading, reload, refresh } = useOverview(client);
  const now = useNow(nowMs);
  const [filter, setFilter] = useState<Filter>('mine');
  const [limit, setLimit] = useState(PROJECT_PAGE);
  return (
    <main
      className="mx-auto grid h-full min-h-0 w-full max-w-3xl content-start gap-panel overflow-y-auto p-panel"
      data-pulls-list=""
    >
      <header className="grid gap-xs">
        <h1 className="m-0 font-display text-display font-bold tracking-display">PRs &amp; CI</h1>
        <p className="m-0 text-meta text-muted">
          Open pull requests for your projects, read with the GitHub account connected to each one.
        </p>
      </header>
      <Body
        client={client}
        daemon={daemon}
        filter={filter}
        limit={limit}
        more={() => setLimit(value => value + PROJECT_PAGE)}
        nowMs={now}
        onFilter={setFilter}
        onOpen={onNavigate}
        reading={reading}
        reload={reload}
        refresh={refresh}
      />
    </main>
  );
}

interface BodyProps {
  readonly client: ListClient;
  readonly daemon: string;
  readonly reading: Reading;
  readonly filter: Filter;
  readonly limit: number;
  readonly nowMs: number;
  readonly onFilter: (filter: Filter) => void;
  readonly onOpen: (to: string) => void;
  readonly more: () => void;
  readonly reload: () => void;
  readonly refresh: () => void;
}

function Body({ client, daemon, reading, filter, limit, nowMs, onFilter, onOpen, more, reload, refresh }: BodyProps) {
  const hrefOf = useScreenHref();
  if (reading.status === 'loading') return <Loading kind="page" compact label="Reading your pull requests…" />;
  if (reading.status === 'failed')
    return (
      <div className="kt-panel grid gap-xs p-panel" role="alert">
        <p className="m-0 text-ui text-err">Could not read your pull requests: {reading.message}</p>
        <button className="kt-btn kt-btn--sm w-fit" onClick={reload} type="button">
          Try again
        </button>
      </div>
    );
  const { overview, projects } = reading;
  const nameOf = (project: string): string => projects.get(project)?.name ?? shortId(project);
  if (overview.projects.length === 0)
    return (
      <p className="kt-panel m-0 p-panel text-ui text-muted" data-pulls-empty="no-projects">
        No projects yet. Add a project, connect its GitHub account, and its pull requests show up here.
      </p>
    );
  const counts = countsOf(overview.projects);
  const { shown, more: hidden } = folded(orderProjects(overview.projects, nameOf), limit);
  return (
    <>
      <div aria-label="Show" className="flex min-w-0 flex-wrap gap-xs" data-pulls-filters="" role="toolbar">
        {FILTERS.map(key => (
          <button
            aria-pressed={key === filter}
            className="kt-tab !px-xs min-w-0 gap-1"
            data-pulls-filter={key}
            key={key}
            onClick={() => onFilter(key)}
            type="button"
          >
            <span className="truncate">{FILTER_WORDS[key]}</span>
            <span className="mono shrink-0 text-2xs text-faint">{counts[key]}</span>
          </button>
        ))}
      </div>
      {reading.stale !== undefined && (
        <p className="m-0 text-meta text-warn" role="status">
          Could not refresh ({reading.stale}). This is the last list that was read.
        </p>
      )}
      {shown.map(view => (
        <section
          aria-label={nameOf(view.project)}
          className="kt-panel grid gap-sm p-panel"
          data-pulls-section={view.project}
          key={view.project}
        >
          <h2 className="m-0 min-w-0 text-title font-semibold text-fg [overflow-wrap:anywhere]">
            <bdi>{nameOf(view.project)}</bdi>
          </h2>
          <ProjectBlock
            accountsHref={hrefOf(daemon, 'projects', 'project', { id: view.project })}
            client={client}
            daemon={daemon}
            filter={filter}
            noRepo={projects.get(view.project)?.noRepo === true}
            nowMs={nowMs}
            onChanged={refresh}
            onOpen={onOpen}
            view={view}
          />
        </section>
      ))}
      {hidden > 0 && (
        <button className="kt-btn w-fit" onClick={more} type="button">
          {hidden > PROJECT_PAGE
            ? `Show ${PROJECT_PAGE} more projects (${hidden} hidden)`
            : `Show ${hidden} more ${hidden === 1 ? 'project' : 'projects'}`}
        </button>
      )}
    </>
  );
}
