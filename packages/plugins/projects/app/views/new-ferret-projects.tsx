/**
 * "Your projects" on the New ferret page: the panel Projects puts in Ferrets' `ferrets.new-ferret-project` slot, ABOVE the
 * Folder box. One row per registered project; a click fills the Folder field with that project's folder and marks the row.
 * It draws nothing while the registry is unread, fails or is empty, so the Folder box is never pushed down for nothing.
 *
 * It only proposes a folder through the slot's `onPick`; the page's own start (and the daemon's fence) decides.
 */
import { isNewFerretProjectSlotProps } from '@ferretry/core-ferrets/contract';
import type { AppComponent, PanelProps } from '@ferretry/kernel/manifest';
import { Check, FolderOpen } from 'lucide-react';
import { useState } from 'react';
import type { ProjectInfo } from '../../contract/index.ts';
import { useProjectsSlice } from '../hooks/use-projects.ts';
import type { ProjectsClient } from '../lib/client.ts';
import { projectLine } from '../lib/project-line.ts';
import type { ProjectsStore } from '../lib/projects-store.ts';
import { projectsStoreFor } from './context.ts';

/** Rows shown before "More…". */
const FIRST_ROWS = 5;

function ProjectRow({
  project,
  selected,
  onPick,
}: {
  readonly project: ProjectInfo;
  readonly selected: boolean;
  readonly onPick: (folder: string) => void;
}) {
  return (
    <li className="m-0 list-none">
      <button
        aria-pressed={selected}
        className="flex min-h-[44px] w-full min-w-0 items-center gap-sm rounded-control border border-border-strong bg-surface px-control-x py-1 text-left hover:border-border aria-pressed:border-fg"
        data-new-ferret-project-row={project.id}
        onClick={() => onPick(project.path)}
        title={project.path}
        type="button"
      >
        <FolderOpen aria-hidden="true" className="shrink-0 text-muted" size={16} />
        <span className="grid min-w-0 flex-1">
          <span className="truncate text-ui font-medium text-fg">{project.name}</span>
          <span className="truncate text-meta text-muted">{projectLine(project)}</span>
        </span>
        {selected ? <Check aria-hidden="true" className="shrink-0 text-fg" size={16} /> : null}
      </button>
    </li>
  );
}

function NewFerretProjects({
  store,
  value,
  onPick,
}: {
  readonly store: ProjectsStore;
  readonly value: string;
  readonly onPick: (folder: string) => void;
}) {
  const { projects } = useProjectsSlice(store);
  const [all, setAll] = useState(false);
  if (projects === null || projects.length === 0) return null;
  const shown = all ? projects : projects.slice(0, FIRST_ROWS);
  return (
    <section aria-label="Your projects" className="mb-2 grid gap-1.5" data-new-ferret-projects="">
      <h3 className="m-0 text-meta font-semibold text-muted">Your projects</h3>
      <ul className="m-0 grid gap-1.5 p-0">
        {shown.map(project => (
          <ProjectRow key={project.id} onPick={onPick} project={project} selected={value === project.path} />
        ))}
      </ul>
      {projects.length > FIRST_ROWS ? (
        <button
          className="w-fit text-meta text-muted hover:text-fg"
          onClick={() => setAll(current => !current)}
          type="button"
        >
          {all ? 'Fewer' : `More… (${projects.length - FIRST_ROWS})`}
        </button>
      ) : null}
    </section>
  );
}

/** The panel, built once per daemon client over the registry store the hub and the project page share. */
export const createNewFerretProjectsPanel = (client: ProjectsClient): AppComponent<PanelProps> => {
  const store = projectsStoreFor(client);
  return function NewFerretProjectsPanel(props: PanelProps) {
    return isNewFerretProjectSlotProps(props) ? (
      <NewFerretProjects onPick={props.onPick} store={store} value={props.value} />
    ) : null;
  };
};
