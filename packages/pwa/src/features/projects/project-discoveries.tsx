/**
 * DISCOVERIES, AND THE CONFIRMATION THAT IS THE ONLY WAY THEY BECOME PROJECTS.
 *
 * The registry has no scan and never will: `FileProjectCatalog` says in its own
 * header that a folder observed in a session is a discovery until the caller
 * explicitly confirms it, and the folder picker's Recent chip already promises a
 * reader that choosing one registers nothing. This surface is the missing other
 * half of that promise — the place where somebody can say yes — and it is
 * deliberately one button per row rather than a "confirm all": a bulk action is
 * an automatic scan with a human-shaped delay in front of it.
 *
 * IT DOES NOT DECIDE WHAT A DISCOVERY IS. `recentProjectPaths` derives the paths
 * from the session list and `projectPickerOptions` folds away anything already
 * covered by a registered root, using the same longest-prefix rule session
 * grouping uses. This component renders that projection and adds no second rule,
 * so the hub and the new-session picker can never disagree about which folders
 * are unregistered.
 *
 * NULL IS NOT EMPTY, HERE TOO. "Recent" is a claim about sessions, so an unread
 * session list produces `null` and this says the list has not been read — not
 * "every folder is registered", which is what an empty list means and is a
 * completely different fact.
 */

import { Check, FolderClock, LoaderCircle, TriangleAlert } from 'lucide-react';
import type { RecentProjectOption } from '../../components/daemon-picker-model.ts';
import { relativeTime } from '../../lib/session-screens.ts';
import {
  DISCOVERY_PROMISE,
  type ProjectRegistrationStatus,
  registrationPendingFor,
} from './project-registration-model.ts';

interface ProjectDiscoveriesProps {
  /** `null` = this daemon's session list has not been read, so nothing is known. */
  readonly discoveries: readonly RecentProjectOption[] | null;
  /** Why the session list could not be read, when that is what happened. */
  readonly sessionsError: string | null;
  readonly status: ProjectRegistrationStatus | null;
  readonly onConfirm: (path: string) => void;
  /** Passed in rather than read, so a row's age is a fact of the render. */
  readonly now: number;
}

const HEADING_ID = 'project-discoveries-heading';

export function ProjectDiscoveries({ discoveries, sessionsError, status, onConfirm, now }: ProjectDiscoveriesProps) {
  const busy = status?.phase === 'submitting';
  const refusal = status?.phase === 'refused' && status.request.kind === 'confirmed-discovery' ? status.message : null;

  return (
    <section className="kt-panel grid gap-sm p-panel" aria-labelledby={HEADING_ID} data-project-discoveries="">
      <header className="grid gap-xs">
        <h2 className="m-0 flex items-center gap-xs text-title font-semibold text-fg" id={HEADING_ID}>
          <FolderClock className="text-muted" size={16} aria-hidden="true" />
          Discovered from sessions
          {discoveries !== null && discoveries.length > 0 && (
            <span className="rounded-control bg-surface-2 px-1.5 py-0.5 text-meta font-medium text-muted">
              {discoveries.length}
            </span>
          )}
        </h2>
        <p className="m-0 max-w-prose text-meta leading-base text-muted">{DISCOVERY_PROMISE}</p>
      </header>

      {refusal !== null && (
        <p className="m-0 flex items-start gap-xs text-meta text-err" role="alert">
          <TriangleAlert className="mt-0.5 shrink-0" size={14} aria-hidden="true" />
          <span>This daemon refused the confirmation: {refusal}</span>
        </p>
      )}

      {discoveries === null ? (
        <p className="m-0 text-meta leading-base text-faint" data-project-discoveries-state="unread">
          {sessionsError === null
            ? 'This daemon’s session list has not been read yet, so Ferretry cannot say which folders are unregistered.'
            : `This daemon’s session list could not be read (${sessionsError}), so Ferretry cannot say which folders are unregistered.`}
        </p>
      ) : discoveries.length === 0 ? (
        <p className="m-0 text-meta leading-base text-faint" data-project-discoveries-state="none">
          Every folder a session on this daemon has worked in is already covered by a registered project.
        </p>
      ) : (
        <ul className="m-0 grid list-none gap-xs p-0">
          {discoveries.map(option => {
            const pending = registrationPendingFor(status, option.path);
            return (
              <li
                className="flex min-w-0 flex-wrap items-center gap-sm rounded-control border border-border-soft bg-surface-2 px-control-x py-2"
                data-project-discovery={option.path}
                key={option.key}
              >
                <div className="min-w-0 flex-1">
                  <p className="m-0 text-ui font-medium text-fg">{option.name}</p>
                  <p className="mono m-0 break-all text-meta leading-tight text-muted">{option.path}</p>
                </div>
                <span className="shrink-0 text-meta text-faint">
                  last used {relativeTime(option.lastActivity, now)}
                </span>
                <button
                  type="button"
                  className="kt-btn min-h-control shrink-0"
                  disabled={busy}
                  onClick={() => onConfirm(option.path)}
                  aria-label={`Confirm ${option.path} as a project`}
                >
                  {pending ? (
                    <LoaderCircle className="animate-spin motion-reduce:animate-none" size={14} aria-hidden="true" />
                  ) : (
                    <Check size={14} aria-hidden="true" />
                  )}
                  {pending ? 'Confirming…' : 'Confirm project'}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
