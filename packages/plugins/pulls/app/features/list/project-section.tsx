/**
 * The PRs section on a project's own page (r9 E3, the first implementation of Projects' insights hook): this project's
 * watch switch and open PRs, the same block the PRs screen draws, so the two can never disagree.
 */
import { Loading, useNow } from '@ferretry/app/ui';
import { useState } from 'react';
import type { ListClient } from './api.ts';
import { type Filter, FILTER_WORDS, FILTERS } from './model.ts';
import { ProjectBlock } from './project-block.tsx';
import { useOverview } from './use-overview.ts';

export interface ProjectPullsProps {
  readonly client: ListClient;
  readonly daemon: string;
  readonly project: string;
  readonly onNavigate: (to: string) => void;
  readonly nowMs?: number;
}

export function ProjectPulls({ client, daemon, project, onNavigate, nowMs }: ProjectPullsProps) {
  const { reading, refresh } = useOverview(client);
  const now = useNow(nowMs);
  const [filter, setFilter] = useState<Filter>('all');
  if (reading.status === 'loading') return <Loading kind="bar" label="Reading this project’s pull requests…" />;
  if (reading.status === 'failed')
    return (
      <p className="m-0 text-meta text-warn" role="status">
        Could not read pull requests: {reading.message}
      </p>
    );
  const view = reading.overview.projects.find(each => each.project === project);
  if (view === undefined)
    return (
      <p className="m-0 text-meta text-muted" data-pulls-empty="unknown-project">
        This daemon does not list this project yet.
      </p>
    );
  return (
    <div className="grid gap-sm">
      <div aria-label="Show" className="flex min-w-0 flex-wrap gap-xs" role="toolbar">
        {FILTERS.map(key => (
          <button
            aria-pressed={key === filter}
            className="kt-tab !px-xs min-w-0"
            data-pulls-filter={key}
            key={key}
            onClick={() => setFilter(key)}
            type="button"
          >
            {FILTER_WORDS[key]}
          </button>
        ))}
      </div>
      {reading.stale !== undefined && (
        <p className="m-0 text-meta text-warn" role="status">
          Could not refresh ({reading.stale}). This is the last list that was read.
        </p>
      )}
      <ProjectBlock
        client={client}
        daemon={daemon}
        filter={filter}
        noRepo={reading.projects.get(project)?.noRepo === true}
        nowMs={now}
        onChanged={refresh}
        onOpen={onNavigate}
        view={view}
      />
    </div>
  );
}
