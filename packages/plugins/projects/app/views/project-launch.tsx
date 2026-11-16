import type { ProjectInfo } from '../../contract/index.ts';
import { Play, TriangleAlert } from 'lucide-react';
import { useState } from 'react';

import { projectLaunchRequest } from '../lib/ferrets.ts';

interface ProjectLaunchProps {
  readonly project: ProjectInfo;
  readonly onLaunch: (request: ReturnType<typeof projectLaunchRequest>) => Promise<void>;
}

/**
 * Starts only a top-level interactive ferret. A project supplies its folder; the
 * reader still chooses the runtime, which Ferrets requires for a start and
 * which this page cannot guess.
 */
export function ProjectLaunch({ project, onLaunch }: ProjectLaunchProps) {
  const [open, setOpen] = useState(false);
  const [runtime, setRuntime] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const launch = async (): Promise<void> => {
    if (submitting || runtime.trim() === '') return;
    setSubmitting(true);
    setError(null);
    try {
      await onLaunch(projectLaunchRequest(runtime, project.path));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      setSubmitting(false);
    }
  };

  return (
    <div className="grid shrink-0 gap-xs">
      <button
        type="button"
        className="kt-btn min-h-control"
        data-variant="primary"
        aria-expanded={open}
        aria-controls="project-launch-runtime"
        onClick={() => setOpen(current => !current)}
      >
        <Play size={14} aria-hidden="true" />
        Start a ferret
      </button>
      {open && (
        <div
          className="grid gap-xs rounded-control border border-border-strong bg-surface-2 p-control"
          id="project-launch-runtime"
        >
          <label className="grid gap-1 text-meta font-medium text-fg" htmlFor="project-launch-runtime-name">
            Runtime
            <input
              className="kt-input min-h-control w-full mono"
              id="project-launch-runtime-name"
              value={runtime}
              placeholder="claude-code"
              onChange={event => setRuntime(event.target.value)}
            />
          </label>
          <p className="m-0 mono break-all text-2xs text-muted">Top-level interactive ferret in {project.path}</p>
          {error && (
            <p className="m-0 flex items-start gap-xs text-meta text-err" role="alert">
              <TriangleAlert className="mt-0.5 shrink-0" size={14} aria-hidden="true" />
              Could not start the ferret: {error}
            </p>
          )}
          <button
            type="button"
            className="kt-btn kt-btn--sm justify-center"
            data-variant="primary"
            disabled={runtime.trim() === '' || submitting}
            onClick={() => void launch()}
          >
            {submitting ? 'Launching…' : error ? 'Retry launch' : 'Start interactive ferret'}
          </button>
        </div>
      )}
    </div>
  );
}
