/**
 * THE PROVENANCE RAIL — where a registered folder came from, where it IS, and
 * whether Git is attached to it, read as one joined statement instead of three
 * loose lines.
 *
 * A registry row is only useful if a reader can tell two folders apart, and the
 * facts that do that are exactly the ones the daemon durably records: the
 * deliberate act that created the record, the canonical resolved root, when it
 * arrived, and the Git common directory when there is one. Drawing them on a
 * single rail is the point — a cloned checkout and a folder somebody pointed at
 * have the same `name` and the same `path` shape, and the difference between them
 * is provenance.
 *
 * THE PATH IS NEVER TRUNCATED. An operator comparing `/work/repo` with
 * `/work/repo-worktrees/feature` needs the tail, which is exactly the part an
 * ellipsis eats; a long path wraps instead. The Git directory wraps for the same
 * reason — it is the only thing that distinguishes a worktree from its own
 * repository.
 *
 * A MISSING FACT IS OMITTED, NEVER GUESSED. The grouping shape allows a row
 * carrying only a name and a path (a fixture, a folder a reader typed), and
 * "existing folder" is a claim about a deliberate act such a row has no evidence
 * for. No `source` means no chip. Git is the exception and says so in as many
 * words, because "not a Git repository" is a fact worth stating rather than an
 * empty space.
 *
 * The rail itself is decorative and marked so: the `<dl>` is what a screen reader
 * walks, one term per fact.
 */

import { FolderGit2 } from 'lucide-react';
import type { ReactNode } from 'react';
import type { FleetProject } from '../../lib/fleet-grouping.ts';
import { projectSourceLabel } from './project-registration-model.ts';

const TERM_CLASS = 'm-0 text-label font-semibold uppercase tracking-label text-faint';
const VALUE_CLASS = 'm-0 min-w-0 break-all text-meta leading-tight text-fg-soft';

/** One fact on the rail: its tick, its term, its value. */
function RailFact({
  term,
  children,
  mono = false,
}: {
  readonly term: string;
  readonly children: ReactNode;
  readonly mono?: boolean;
}) {
  return (
    <div className="relative grid grid-cols-[4.25rem_minmax(0,1fr)] items-baseline gap-x-sm gap-y-0 py-0.5 pl-md">
      {/* The tick joining this fact to the rail. Decorative: the <dt> carries the
          meaning, and the offset is positive so no negative inset is needed. */}
      <span aria-hidden="true" className="absolute left-0 top-[0.6em] h-px w-sm bg-border-strong" />
      <dt className={TERM_CLASS}>{term}</dt>
      <dd className={mono ? `mono ${VALUE_CLASS}` : VALUE_CLASS}>{children}</dd>
    </div>
  );
}

export function ProjectProvenance({ project }: { readonly project: FleetProject }) {
  const source = projectSourceLabel(project.source);
  return (
    /* `relative` is load-bearing rather than tidy: the rail and its ticks are
       absolutely positioned, and inside a statically positioned scrollport an
       absolute box escapes to the fixed shell instead of being clipped here. */
    <div className="relative" data-project-provenance={project.path}>
      <span aria-hidden="true" className="absolute bottom-1 left-0 top-1 w-px bg-border-strong" />
      <dl className="m-0 grid gap-0">
        {source !== null && (
          <RailFact term="Source">
            <span
              className="inline-block rounded-control border border-border-strong bg-surface px-1.5 py-0.5 text-meta font-medium text-fg-soft"
              data-project-source={project.source}
            >
              {source}
            </span>
          </RailFact>
        )}
        <RailFact term="Path" mono={true}>
          {project.path}
        </RailFact>
        {project.createdAt !== undefined && <RailFact term="Added">{project.createdAt.slice(0, 10)}</RailFact>}
        <RailFact term="Git" mono={project.git !== undefined}>
          {project.git === undefined ? (
            <span className="text-faint">not a Git repository</span>
          ) : (
            <span className="inline-flex min-w-0 items-baseline gap-1">
              <FolderGit2 className="translate-y-0.5 shrink-0 text-muted" size={12} aria-hidden="true" />
              {project.git.commonDirectory}
            </span>
          )}
        </RailFact>
      </dl>
    </div>
  );
}
