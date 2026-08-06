import type { ProjectInfo } from '@ferretry/protocol';
import { Play, TriangleAlert } from 'lucide-react';
import { useState } from 'react';

import { projectLaunchRequest } from './project-launch-model.ts';

interface ProjectLaunchProps {
  readonly project: ProjectInfo;
  readonly onLaunch: (request: ReturnType<typeof projectLaunchRequest>) => Promise<void>;
}

/**
 * Starts only a top-level interactive session. A project supplies its cwd; the
 * reader still chooses the installed agent wrapper, which is required by the
 * existing session contract and cannot be guessed by this page.
 */
export function ProjectLaunch({ project, onLaunch }: ProjectLaunchProps) {
  const [open, setOpen] = useState(false);
  const [agent, setAgent] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const launch = async (): Promise<void> => {
    if (submitting || agent.trim() === '') return;
    setSubmitting(true);
    setError(null);
    try {
      await onLaunch(projectLaunchRequest(agent, project.path));
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
        aria-controls="project-launch-agent"
        onClick={() => setOpen(current => !current)}
      >
        <Play size={14} aria-hidden="true" />
        Launch agent
      </button>
      {open && (
        <div
          className="grid gap-xs rounded-control border border-border-strong bg-surface-2 p-control"
          id="project-launch-agent"
        >
          <label className="grid gap-1 text-meta font-medium text-fg" htmlFor="project-launch-agent-name">
            Agent wrapper
            <input
              className="kt-input min-h-control w-full mono"
              id="project-launch-agent-name"
              value={agent}
              placeholder="claude-auto-loge"
              onChange={event => setAgent(event.target.value)}
            />
          </label>
          <p className="m-0 mono break-all text-2xs text-muted">Top-level interactive session in {project.path}</p>
          {error && (
            <p className="m-0 flex items-start gap-xs text-meta text-err" role="alert">
              <TriangleAlert className="mt-0.5 shrink-0" size={14} aria-hidden="true" />
              Could not launch the agent: {error}
            </p>
          )}
          <button
            type="button"
            className="kt-btn kt-btn--sm justify-center"
            data-variant="primary"
            disabled={agent.trim() === '' || submitting}
            onClick={() => void launch()}
          >
            {submitting ? 'Launching…' : error ? 'Retry launch' : 'Launch interactive agent'}
          </button>
        </div>
      )}
    </div>
  );
}
