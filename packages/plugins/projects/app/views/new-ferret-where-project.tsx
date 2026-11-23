/**
 * "PROJECT" ON THE WHERE-IT-WORKS FIELD: a searchable dropdown of the registered projects (a bottom sheet on a phone).
 * A row picks the project's folder; its "Link GitHub" opens the same account-links editor project pages use, with the
 * same passkey step-up, and picks nothing.
 */
import { Check, ChevronDown, FolderOpen } from 'lucide-react';
import { useState } from 'react';
import type { ProjectInfo, ProjectsConnectAccount } from '../../contract/index.ts';
import { ProjectAccountLinks } from '../features/create-project/account-links.tsx';
import type { ProjectsClient } from '../lib/client.ts';
import { projectLine } from '../lib/project-line.ts';
import type { ProjectsStore } from '../lib/projects-store.ts';
import { WhereSurface } from './new-ferret-where-surface.tsx';

const matches = (project: ProjectInfo, words: readonly string[]): boolean => {
  const text = `${project.name}\n${project.path}\n${projectLine(project)}`.toLowerCase();
  return words.every(word => text.includes(word));
};

export interface WhereProjectProps {
  readonly client: ProjectsClient;
  readonly store: ProjectsStore;
  readonly projects: readonly ProjectInfo[];
  /** Git accounts' connect card on this machine, when it has one (the same one the create flow mounts). */
  readonly connectAccount: ProjectsConnectAccount | undefined;
  readonly id: string;
  readonly value: string;
  readonly onPick: (folder: string) => void;
}

export function WhereProject({ client, store, projects, connectAccount, id, value, onPick }: WhereProjectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [linking, setLinking] = useState<string | null>(null);
  const selected = projects.find(project => project.path === value);
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
  const shown = projects.filter(project => matches(project, words));
  const close = (): void => {
    setOpen(false);
    setQuery('');
    setLinking(null);
  };
  return (
    <div data-new-ferret-where-project="">
      <button
        aria-expanded={open}
        aria-haspopup="dialog"
        className="kt-input flex min-h-[44px] w-full items-center justify-between gap-sm text-left"
        data-where-project-trigger=""
        id={id}
        onClick={() => (open ? close() : setOpen(true))}
        type="button"
      >
        <span className="grid min-w-0">
          <span className={selected === undefined ? 'truncate text-muted' : 'truncate font-medium text-fg'}>
            {selected?.name ?? 'Choose a project'}
          </span>
          {selected === undefined ? null : (
            <span className="truncate text-meta text-muted">{projectLine(selected)}</span>
          )}
        </span>
        <ChevronDown aria-hidden="true" className="shrink-0 text-faint" size={16} />
      </button>
      <WhereSurface onClose={close} open={open} title="Choose a project">
        <div className="grid gap-2">
          <input
            aria-label="Search projects"
            className="kt-input w-full"
            data-where-initial-focus=""
            data-where-project-search=""
            onChange={event => setQuery(event.target.value)}
            placeholder="Search projects"
            type="search"
            value={query}
          />
          {shown.length === 0 ? (
            <p className="m-0 text-ui text-muted" data-where-project-none="" role="status">
              {projects.length === 0 ? 'No projects yet. Use Folder, or add a project first.' : 'No project matches.'}
            </p>
          ) : (
            <ul className="m-0 grid list-none gap-1.5 p-0">
              {shown.map(project => {
                const linked = (project.accounts ?? []).length > 0;
                return (
                  <li className="m-0" data-where-project-row={project.id} key={project.id}>
                    <div className="grid gap-1.5 rounded-control border border-border-strong bg-surface p-1">
                      <button
                        aria-pressed={project.path === value}
                        className="flex min-h-[44px] w-full min-w-0 items-center gap-sm rounded-control px-2 text-left hover:bg-surface-2"
                        onClick={() => {
                          onPick(project.path);
                          close();
                        }}
                        title={project.path}
                        type="button"
                      >
                        <FolderOpen aria-hidden="true" className="shrink-0 text-muted" size={16} />
                        <span className="grid min-w-0 flex-1">
                          <span className="truncate text-ui font-medium text-fg">{project.name}</span>
                          <span className="truncate text-meta text-muted">{projectLine(project)}</span>
                        </span>
                        {project.path === value ? (
                          <Check aria-hidden="true" className="shrink-0 text-fg" size={16} />
                        ) : null}
                      </button>
                      <div className="px-2">
                        <button
                          aria-expanded={linking === project.id}
                          className="min-h-[36px] text-meta font-medium text-muted underline hover:text-fg sm:min-h-[28px]"
                          data-where-link-github={project.id}
                          onClick={() => setLinking(current => (current === project.id ? null : project.id))}
                          type="button"
                        >
                          {linked ? 'GitHub accounts' : 'Link GitHub'}
                        </button>
                        {linking === project.id ? (
                          <div className="mt-1" data-where-link-panel={project.id}>
                            <ProjectAccountLinks
                              client={client}
                              connect={{ provided: connectAccount }}
                              edit={{ projectId: project.id, onSaved: () => void store.refresh().catch(() => {}) }}
                              project={project}
                              startEditing={!linked}
                            />
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </WhereSurface>
    </div>
  );
}
