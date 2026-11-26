/**
 * DISCOVERIES, AND THE CONFIRMATION THAT IS THE ONLY WAY THEY BECOME PROJECTS.
 *
 * The registry has no scan and never will: `FileProjectCatalog` says in its own
 * header that a folder observed in a ferret is a discovery until the caller
 * explicitly confirms it, and the folder picker's Recent chip already promises a
 * reader that choosing one registers nothing. This surface is the missing other
 * half of that promise — the place where somebody can say yes — and it is
 * deliberately one button per row rather than a "confirm all": a bulk action is
 * an automatic scan with a human-shaped delay in front of it.
 *
 * IT DOES NOT DECIDE WHAT A DISCOVERY IS. `discoveriesFrom` derives the paths
 * from the ferret list and folds away anything already
 * covered by a registered root, using the same longest-prefix rule every
 * project lookup uses. This component renders that projection and adds no second rule,
 * so the hub and the new-ferret picker can never disagree about which folders
 * are unregistered.
 *
 * NULL IS NOT EMPTY, HERE TOO. "Recent" is a claim about ferrets, so an unread
 * ferret list produces `null` and this says the list has not been read — not
 * "every folder is registered", which is what an empty list means and is a
 * completely different fact.
 */

import { Spinner } from '@ferretry/app/ui';
import { Check, ChevronRight, TriangleAlert } from 'lucide-react';
import type { RecentProjectOption } from '../lib/discoveries.ts';
import { relativeTime } from '../lib/folders.ts';
import { type ProjectRegistrationStatus, registrationPendingFor } from '../lib/registration-model.ts';

interface ProjectDiscoveriesProps {
  /** `null` = this daemon's ferret list has not been read, so nothing is known. */
  readonly discoveries: readonly RecentProjectOption[] | null;
  /** Why the ferret list could not be read, when that is what happened. */
  readonly ferretsError: string | null;
  readonly status: ProjectRegistrationStatus | null;
  readonly onConfirm: (path: string) => void;
  /** Passed in rather than read, so a row's age is a fact of the render. */
  readonly now: number;
}

const HEADING_ID = 'project-discoveries-heading';

export function ProjectDiscoveries({ discoveries, ferretsError, status, onConfirm, now }: ProjectDiscoveriesProps) {
  const busy = status?.phase === 'submitting';
  const refusal = status?.phase === 'refused' && status.request.kind === 'confirmed-discovery' ? status.message : null;

  // Nothing to say is nothing drawn: "every folder is covered" is not news. An UNREAD list is different (it is not "none"),
  // so that one stays as a quiet line.
  if (discoveries !== null && discoveries.length === 0) return null;

  const refused =
    refusal === null ? null : (
      <p className="m-0 flex items-start gap-xs text-meta text-err" role="alert">
        <TriangleAlert className="mt-0.5 shrink-0" size={14} aria-hidden="true" />
        <span>This daemon refused the confirmation: {refusal}</span>
      </p>
    );

  if (discoveries === null)
    return (
      <section className="grid gap-sm" aria-labelledby={HEADING_ID} data-project-discoveries-state="unread">
        <h2 className="sr-only" id={HEADING_ID}>
          Discovered from ferrets
        </h2>
        {refused}
        <p className="m-0 text-meta leading-base text-faint">
          {ferretsError === null
            ? 'This daemon’s ferret list has not been read yet, so Ferretry cannot say which folders are unregistered.'
            : `This daemon’s ferret list could not be read (${ferretsError}), so Ferretry cannot say which folders are unregistered.`}
        </p>
      </section>
    );

  return (
    <div className="grid gap-sm">
      {refused}
      {/* Closed by default and ONE line: these are folders a ferret used that nobody registered, and registering none
          of them on its own is the point (confirming one is what enrols it), so it never competes with the cards above. */}
      <details className="group grid gap-sm" data-project-discoveries="">
        <summary
          className="flex min-h-control cursor-pointer list-none items-center gap-xs text-meta font-medium text-muted hover:text-fg [&::-webkit-details-marker]:hidden"
          id={HEADING_ID}
        >
          <ChevronRight className="shrink-0 transition-transform group-open:rotate-90" size={14} aria-hidden="true" />
          <span className="min-w-0 truncate">Folders ferrets used, not yet projects ({discoveries.length})</span>
        </summary>
        <ul className="m-0 grid list-none gap-sm p-0">
          {discoveries.map(option => {
            const pending = registrationPendingFor(status, option.path);
            return (
              <li
                className="flex min-w-0 flex-wrap items-center gap-sm rounded-panel border border-border-soft bg-surface px-panel py-2"
                data-project-discovery={option.path}
                key={option.key}
              >
                {/* `basis-64`: the name and path wrap the row before they shrink, never to one fragment a line. */}
                <div className="min-w-0 grow basis-64">
                  <p className="m-0 text-ui font-medium text-fg">{option.name}</p>
                  <p className="mono m-0 break-all text-meta leading-tight text-muted">{option.path}</p>
                  <p className="m-0 text-meta text-faint">last used {relativeTime(option.lastActivity, now)}</p>
                </div>

                <button
                  type="button"
                  className="kt-btn min-h-control shrink-0"
                  disabled={busy}
                  onClick={() => onConfirm(option.path)}
                  aria-label={`Confirm ${option.path} as a project`}
                >
                  {pending ? <Spinner size={14} wait /> : <Check size={14} aria-hidden="true" />}
                  {pending ? 'Confirming…' : 'Confirm project'}
                </button>
              </li>
            );
          })}
        </ul>
      </details>
    </div>
  );
}
