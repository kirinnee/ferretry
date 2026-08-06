/**
 * THE PROJECTS HUB — one daemon's registry, and every way to add to it.
 *
 * Presentational on purpose. It holds the draft and whether the form is open,
 * reads no store and knows no transport, so the screenshot harness and the unit
 * tier drive exactly the component production mounts rather than an approximation
 * of it. `projects-page.tsx` is the thin half that binds the stores to it.
 *
 * ONE DOMINANT ACTION. The registry is what a returning reader came for, so it is
 * what loads first and the form is a disclosure above it rather than a wall in
 * front of it. Confirming a discovery is a second, quieter action that never
 * needs the form at all — the whole point of a discovery is that its path is
 * already known.
 *
 * THREE READINGS OF THE REGISTRY, NEVER TWO. `null` projects with a settled
 * status is unread, `[]` is a daemon that registers nothing, and an error is a
 * read that failed — and a failed refresh keeps the folders it already had on
 * screen with the failure stated beside them, because a blanked list reads as
 * "this daemon registers nothing" and that is a different, wrong answer. A failed
 * READ also does not disable writing: the form and the discovery list work
 * whether or not the list beside them could be re-read.
 *
 * THE DRAFT IS CLEARED BY A SUCCESS AND BY NOTHING ELSE. Not by a refusal, not by
 * switching modes, not by collapsing the form. `onRegister` answers `false` for a
 * refusal, and that is the whole protocol between this component and its caller.
 */

import type { RegisterProjectRequest } from '@ferretry/protocol';
import { FolderOpen, Plus, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import type { RecentProjectOption } from '../../components/daemon-picker-model.ts';
import type { DaemonProjectsSlice } from '../../lib/projects-store.ts';
import { AddProjectForm } from './add-project-form.tsx';
import { ProjectDiscoveries } from './project-discoveries.tsx';
import { ProjectProvenance } from './project-provenance.tsx';
import {
  confirmDiscoveryRequest,
  emptyProjectRegistrationDraft,
  type ProjectRegistrationDraft,
  type ProjectRegistrationStatus,
} from './project-registration-model.ts';

interface ProjectsHubProps {
  readonly slice: DaemonProjectsSlice;
  /** The authoritative unregistered-path projection; `null` = sessions unread. */
  readonly discoveries: readonly RecentProjectOption[] | null;
  readonly sessionsError: string | null;
  readonly status: ProjectRegistrationStatus | null;
  /**
   * Sends one request and answers whether the daemon accepted it. `true` is the
   * only thing that clears the draft, and this never rejects — a refusal is a
   * state the reader is shown, not an exception a render has to survive.
   */
  readonly onRegister: (request: RegisterProjectRequest) => Promise<boolean>;
  /** Clears a settled status, so a notice cannot outlive the thing it describes. */
  readonly onDismiss: () => void;
  /** The daemon-scoped UUID route for a registered project. */
  readonly projectHref?: (projectId: string) => string;
  readonly now: number;
}

const FORM_ID = 'add-project-form';

/** What just happened, said in a way a reader can act on. */
function RegisteredNotice({
  status,
  onDismiss,
}: {
  readonly status: ProjectRegistrationStatus | null;
  readonly onDismiss: () => void;
}) {
  if (status?.phase !== 'registered') return null;
  return (
    <div
      className="flex flex-wrap items-start gap-sm rounded-control border border-ok-border bg-ok-bg px-control-x py-2"
      data-project-registered={status.project.id}
      role="status"
    >
      <div className="min-w-0 flex-1">
        <p className="m-0 text-ui font-medium text-fg">
          {status.alreadyRegistered ? 'Already registered' : 'Registered'} — {status.project.name}
        </p>
        <p className="mono m-0 break-all text-meta leading-tight text-muted">{status.project.path}</p>
        {status.alreadyRegistered && (
          <p className="m-0 mt-0.5 text-meta leading-base text-muted">
            This daemon already held this folder, so nothing was created and the original record was returned.
          </p>
        )}
      </div>
      <button type="button" className="kt-btn kt-btn--sm shrink-0" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}

export function ProjectsHub({
  slice,
  discoveries,
  sessionsError,
  status,
  onRegister,
  onDismiss,
  projectHref,
  now,
}: ProjectsHubProps) {
  const [draft, setDraft] = useState<ProjectRegistrationDraft>(emptyProjectRegistrationDraft);
  const [open, setOpen] = useState(false);
  const projects = slice.projects;
  const unread = projects === null;
  const loading = slice.status === 'idle' || slice.status === 'loading';

  const submit = (request: RegisterProjectRequest): void => {
    void onRegister(request).then(accepted => {
      if (!accepted) return;
      setDraft(emptyProjectRegistrationDraft);
      setOpen(false);
    });
  };

  return (
    <section className="grid gap-panel p-panel" aria-labelledby="projects-heading">
      <div className="kt-panel grid gap-panel p-panel">
        <div className="flex flex-wrap items-start justify-between gap-md">
          <div className="grid min-w-0 gap-xs">
            <p className="m-0 text-meta font-semibold uppercase tracking-wide text-muted">Workspace registry</p>
            <h1 className="m-0 font-display text-display font-bold tracking-display" id="projects-heading">
              Projects
            </h1>
            <p className="m-0 max-w-prose text-ui leading-base text-muted">
              Folders this daemon has deliberately registered. A folder a session used is a discovery until you confirm
              it.
            </p>
          </div>
          <button
            type="button"
            className="kt-btn min-h-control shrink-0"
            data-variant={open ? undefined : 'primary'}
            aria-expanded={open}
            aria-controls={FORM_ID}
            onClick={() => setOpen(current => !current)}
          >
            <Plus size={14} aria-hidden="true" />
            Add project
          </button>
        </div>
        {open && (
          <div id={FORM_ID}>
            <AddProjectForm
              draft={draft}
              onDraftChange={setDraft}
              onSubmit={submit}
              onCancel={() => setOpen(false)}
              status={status}
            />
          </div>
        )}
      </div>

      <RegisteredNotice status={status} onDismiss={onDismiss} />

      {slice.status === 'error' && (
        <p className="kt-panel m-0 flex items-start gap-sm p-panel text-ui text-err" role="alert">
          <TriangleAlert className="mt-0.5 shrink-0" size={16} aria-hidden="true" />
          Could not read this daemon’s project registry: {slice.error}
        </p>
      )}

      {unread && loading ? (
        <p className="kt-panel m-0 p-panel text-ui text-muted" aria-busy="true">
          Loading registered projects…
        </p>
      ) : (
        <section className="kt-panel grid gap-sm p-panel" aria-labelledby="registered-projects-heading">
          <h2
            className="m-0 flex items-center gap-xs text-title font-semibold text-fg"
            id="registered-projects-heading"
          >
            <FolderOpen className="text-muted" size={16} aria-hidden="true" />
            Registered
            {!unread && projects.length > 0 && (
              <span className="rounded-control bg-surface-2 px-1.5 py-0.5 text-meta font-medium text-muted">
                {projects.length}
              </span>
            )}
          </h2>
          {unread ? (
            <p className="m-0 text-meta leading-base text-faint" data-registered-state="unread">
              Ferretry has not read this registry, so it cannot say what is in it.
            </p>
          ) : projects.length === 0 ? (
            <p className="m-0 text-meta leading-base text-faint" data-registered-state="empty">
              No projects registered. Add an existing folder, create one, clone a repository, or confirm a discovery
              below.
            </p>
          ) : (
            <ul className="m-0 grid list-none gap-xs p-0">
              {projects.map(project => (
                <li
                  className="grid min-w-0 gap-1 rounded-control border border-border-soft bg-surface-2 px-control-x py-2"
                  data-registered-project={project.path}
                  key={project.id ?? project.path}
                >
                  {project.id === undefined || projectHref === undefined ? (
                    <h3 className="m-0 text-ui font-semibold text-fg">{project.name}</h3>
                  ) : (
                    <h3 className="m-0">
                      <a
                        href={projectHref(project.id)}
                        className="inline-flex min-h-control items-center text-left text-ui font-semibold text-fg underline-offset-4 hover:text-accent hover:underline"
                      >
                        {project.name}
                      </a>
                    </h3>
                  )}
                  <ProjectProvenance project={project} />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <ProjectDiscoveries
        discoveries={discoveries}
        sessionsError={sessionsError}
        status={status}
        onConfirm={path => submit(confirmDiscoveryRequest(path))}
        now={now}
      />
    </section>
  );
}
