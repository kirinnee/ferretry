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

import type { ProjectsConnectAccount, RegisterProjectRequest } from '../../contract/index.ts';
import { ChoiceCards } from '@ferretry/app';
import { FolderOpen, GitBranch, Plus, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import type { RecentProjectOption } from '../lib/discoveries.ts';
import type { ProjectsSlice } from '../lib/projects-store.ts';
import { CreateProjectFlow } from '../features/create-project/create-project-flow.tsx';
import type { CreateDraft } from '../features/create-project/create-project-model.ts';
import type { ProjectsClient } from '../lib/client.ts';
import { activeProjectFerrets, type FerretRow, projectFerrets } from '../lib/ferrets.ts';
import { AddProjectForm } from './add-project-form.tsx';
import { ProjectCard } from './project-card.tsx';
import { ProjectDiscoveries } from './project-discoveries.tsx';

import { Loading } from '@ferretry/app/ui';
import {
  confirmDiscoveryRequest,
  emptyProjectRegistrationDraft,
  type ProjectRegistrationDraft,
  type ProjectRegistrationStatus,
} from '../lib/registration-model.ts';

interface ProjectsHubProps {
  readonly slice: ProjectsSlice;
  /** The authoritative unregistered-path projection; `null` = ferrets unread. */
  readonly discoveries: readonly RecentProjectOption[] | null;
  readonly ferretsError: string | null;
  /** The ferret list the page read, for each card's "N ferrets"; `null`/absent = unread, so no count is claimed. */
  readonly ferrets?: readonly FerretRow[] | null;
  /** The daemon this registry belongs to: where a card's "Start a ferret here" goes. Without it the card has no start button. */
  readonly daemon?: string;
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
  /**
   * In-app navigation for that route. Without it the row is still a real
   * `<a href>` — the deep link resolves — but a primary click leaves through the
   * document, remounting every store and discarding the hub's own draft. The
   * router is not reached for here on purpose: the hub is rendered by suites and
   * harness frames that have none.
   */
  readonly onNavigate?: (to: string) => void;
  readonly now: number;
  /**
   * The daemon's client. Given, "Add project" opens the Create-a-project flow (explorer, GitHub accounts, keys); without
   * it the plain form below is drawn, which is what the suites and harness frames that have no daemon mount.
   */
  readonly client?: ProjectsClient;
  /** Git accounts' connect card for the flow, when this machine has it. */
  readonly connectAccount?: ProjectsConnectAccount;
  /** Whether the add form starts open (a caller that came to add a project: the first-run stepper's "Create a project"). */
  readonly initiallyOpen?: boolean;
}

const FORM_ID = 'add-project-form';

/** The empty state's two ways in: each opens the create stepper on its own first page. */
const FIRST_PROJECT = [
  {
    id: 'folder',
    title: 'A folder on this machine',
    line: 'Use a folder that is already here, or make a new one.',
    icon: <FolderOpen size={18} aria-hidden="true" />,
  },
  {
    id: 'clone',
    title: 'Clone a repository',
    line: 'Download a repository into a folder you pick.',
    icon: <GitBranch size={18} aria-hidden="true" />,
  },
] as const;

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
      className="flex flex-wrap items-start gap-sm rounded-panel border border-ok-border bg-ok-bg px-panel py-2"
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
  ferretsError,
  ferrets,
  daemon,
  status,
  onRegister,
  onDismiss,
  projectHref,
  onNavigate,
  now,
  client,
  connectAccount,
  initiallyOpen = false,
}: ProjectsHubProps) {
  const [draft, setDraft] = useState<ProjectRegistrationDraft>(emptyProjectRegistrationDraft);
  const [open, setOpen] = useState(initiallyOpen);
  const [source, setSource] = useState<CreateDraft['source']>('folder');
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

  const heading = open && client !== undefined ? 'h2' : 'h1';
  const Heading = heading;
  const startCreate = (next: CreateDraft['source']): void => {
    setSource(next);
    setOpen(true);
  };

  return (
    // Its own scroller: the page host gives it a fixed height and clips, so a phone could not reach the
    // discoveries below the fold.
    <section className="h-full min-h-0 overflow-y-auto p-panel" aria-labelledby="projects-heading">
      <div className="mx-auto grid w-full max-w-[960px] content-start gap-panel">
        <header className="flex flex-wrap items-start justify-between gap-md">
          <div className="grid min-w-0 gap-xs">
            <Heading className="m-0 font-display text-display font-bold tracking-display" id="projects-heading">
              Projects
            </Heading>
            <p className="m-0 max-w-prose text-ui leading-base text-muted">
              The folders this machine knows by name. A folder a ferret used stays a discovery until you confirm it.
            </p>
          </div>
          <button
            type="button"
            className="kt-btn min-h-control shrink-0"
            data-variant={open ? undefined : 'primary'}
            aria-expanded={open}
            aria-controls={FORM_ID}
            onClick={() => (open ? setOpen(false) : startCreate('folder'))}
          >
            <Plus size={14} aria-hidden="true" />
            Add project
          </button>
        </header>
        {open && (
          <div id={FORM_ID} className="max-w-[640px]">
            {client === undefined ? (
              <AddProjectForm
                draft={draft}
                onDraftChange={setDraft}
                onSubmit={submit}
                onCancel={() => setOpen(false)}
                status={status}
              />
            ) : (
              <CreateProjectFlow
                client={client}
                initialSource={source}
                {...(connectAccount === undefined ? {} : { connectAccount })}
                status={status}
                onRegister={onRegister}
                onClose={() => setOpen(false)}
                {...(projectHref === undefined ? {} : { projectHref })}
                {...(onNavigate === undefined ? {} : { onNavigate })}
              />
            )}
          </div>
        )}

        <RegisteredNotice status={status} onDismiss={onDismiss} />

        {slice.status === 'error' && (
          <p className="m-0 flex items-start gap-sm text-ui text-err" role="alert">
            <TriangleAlert className="mt-0.5 shrink-0" size={16} aria-hidden="true" />
            Could not read this daemon’s project registry: {slice.error}
          </p>
        )}

        {unread && loading ? (
          <Loading kind="page" label="Loading registered projects…" />
        ) : (
          <section className="grid gap-sm" aria-labelledby="registered-projects-heading">
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
              <div className="grid gap-sm" data-registered-state="empty">
                <p className="m-0 text-meta leading-base text-faint">No projects registered yet. Start with one:</p>
                {client === undefined ? null : (
                  <ChoiceCards
                    label="Add your first project"
                    options={FIRST_PROJECT}
                    value={null}
                    onChange={id => startCreate(id === 'clone' ? 'clone' : 'folder')}
                  />
                )}
              </div>
            ) : (
              <ul className="fy-pcards" data-project-cards="">
                {projects.map(project => (
                  <ProjectCard
                    activeFerrets={
                      ferrets === null || ferrets === undefined
                        ? 0
                        : activeProjectFerrets(projectFerrets(project.path, ferrets)).length
                    }
                    daemon={daemon}
                    href={project.id === undefined || projectHref === undefined ? undefined : projectHref(project.id)}
                    key={project.id ?? project.path}
                    onNavigate={onNavigate}
                    project={project}
                  />
                ))}
              </ul>
            )}
          </section>
        )}

        <ProjectDiscoveries
          discoveries={discoveries}
          ferretsError={ferretsError}
          status={status}
          onConfirm={path => submit(confirmDiscoveryRequest(path))}
          now={now}
        />
      </div>{' '}
    </section>
  );
}
