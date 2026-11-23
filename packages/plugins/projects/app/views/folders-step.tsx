/**
 * THE SETUP FLOW'S LAST PAGE, "Add your projects" (the `projects.folders` first-run step): the same folder explorer "Add
 * project" uses, to pick one folder or several, and the same registration (`registerProject`, `existing-folder`) when the
 * footer's Next is pressed (`host.commit`, contract rule 8). The flow draws the title, the footer ("Skip for now" is its Later
 * button) and the loading cover; this page draws only the body.
 *
 * - A machine that already has a project is not asked again: the page passes over (`notNeeded`) before it draws anything.
 * - Next with no folder picked says so in the footer and stays (the way out is Skip for now).
 * - What was registered is left in the step's memory (`openLabel`, `openHref`) so the last page can open it.
 * - Nothing here is about boards: a folder is registered, and the project's own page holds the rest.
 */
import { daemonOfClient } from '@ferretry/app';
import type { StepHost } from '@ferretry/kernel/contract';
import type { AppComponent, PanelProps, PluginClient } from '@ferretry/kernel/manifest';
import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ProjectInfo } from '../../contract/index.ts';
import { FolderPicker } from '../features/folder-explorer/folder-picker.tsx';
import { type ProjectsClient, reasonOf } from '../lib/client.ts';
import { projectPath, projectsPath } from '../lib/paths.ts';
import { fetchProjects, registerProject } from '../lib/projects-api.ts';
import { projectsStoreFor } from './context.ts';

export interface FoldersStepProps {
  readonly step: StepHost | undefined;
  readonly client: ProjectsClient;
  /** The machine the folders are registered on; without it nothing is linked to. */
  readonly daemon: string | undefined;
}

/** The place and the words the last page opens: the one project made, or the list when there are several. */
const openOf = (daemon: string, made: readonly ProjectInfo[]): Record<string, string> => {
  const [only] = made;
  return made.length === 1 && only !== undefined
    ? { openLabel: `Open ${only.name}`, openHref: projectPath(daemon, only.id) }
    : { openLabel: 'Open your projects', openHref: projectsPath(daemon) };
};

export function FoldersStep({ step, client, daemon }: FoldersStepProps) {
  const [picks, setPicks] = useState<readonly string[]>([]);
  const host = useRef(step);
  host.current = step;
  const made = useRef<readonly ProjectInfo[]>([]);

  useEffect(() => {
    let live = true;
    fetchProjects(client).then(
      known => {
        if (!live) return;
        if (known.length > 0) host.current?.notNeeded();
        else host.current?.ready();
      },
      () => live && host.current?.ready(),
    );
    return () => {
      live = false;
    };
  }, [client]);

  // What Next saves: every picked folder, one by one; a refusal keeps the page, with the folders not yet registered still picked.
  useEffect(() => {
    host.current?.commit(async () => {
      if (picks.length === 0) throw new Error('Pick a folder, or choose Skip for now.');
      const left = [...picks];
      for (const path of picks) {
        try {
          made.current = [...made.current, await registerProject(client, { kind: 'existing-folder', path })];
        } catch (cause) {
          setPicks(left);
          throw new Error(`${path}: ${reasonOf(cause)}`);
        }
        left.shift();
      }
      if (daemon !== undefined) host.current?.remember(openOf(daemon, made.current));
      await projectsStoreFor(client)
        .refresh()
        .catch(() => undefined);
    });
  }, [picks, client, daemon]);

  const add = (path: string): void => setPicks(known => (known.includes(path) ? known : [...known, path]));

  return (
    <div className="grid max-w-[660px] gap-md" data-projects-step="folders">
      <p className="m-0 text-ui text-muted">
        Open a folder and press Add this folder, as many times as you like. Each becomes a project; you can link GitHub
        accounts from the project&apos;s own page. Next saves your list.
      </p>
      {picks.length > 0 && (
        <ul className="m-0 grid list-none gap-xs p-0" aria-label="Your folders" data-projects-step-picks="">
          {picks.map(path => (
            <li
              key={path}
              className="flex min-h-[44px] items-center gap-sm rounded-control border border-border-strong bg-surface pl-control-x"
            >
              <span className="mono min-w-0 flex-1 break-all text-meta text-fg">{path}</span>
              <button
                type="button"
                className="inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center text-muted hover:text-fg"
                aria-label={`Remove ${path}`}
                onClick={() => setPicks(known => known.filter(each => each !== path))}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <FolderPicker client={client} onChoose={add} chooseLabel="Add this folder" warnBroad />
    </div>
  );
}

/** The panel Projects places in `onboarding.step`: it draws only for its own step. */
export function createFoldersStep(client: PluginClient): AppComponent<PanelProps> {
  return function FoldersStepPanel(props: PanelProps) {
    return props.subject === 'projects.folders' ? (
      <FoldersStep step={props.step} client={client} daemon={daemonOfClient(client)} />
    ) : null;
  };
}
