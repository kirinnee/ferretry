/**
 * "WHERE IT WORKS" ON THE NEW FERRET PAGE: the panel Projects puts in Ferrets' `ferrets.new-ferret-project` slot. A clear
 * Folder | Project choice (the app's shared SegmentedChoice): Folder is the finder project setup uses (plus one-tap recent folders), Project is a searchable
 * dropdown of the registered projects where GitHub can be linked. It opens on Project when there are projects (or the
 * folder in the field is one), else on Folder, and reserves its height while the registry is unread so nothing jumps.
 *
 * It only proposes a folder through the slot's `onPick`; the page's own start (and the daemon's fence) decides.
 */
import { useAppHook } from '@ferretry/app';
import { SegmentedChoice, type SegmentedChoiceOption } from '@ferretry/app/ui';
import { isNewFerretProjectSlotProps } from '@ferretry/core-ferrets/contract';
import type { AppComponent, PanelProps } from '@ferretry/kernel/manifest';
import { useState } from 'react';
import { isProjectsConnectAccount, type ProjectInfo, PROJECTS_CONNECT_ACCOUNT_HOOK } from '../../contract/index.ts';
import { useProjectsSlice } from '../hooks/use-projects.ts';
import type { ProjectsClient } from '../lib/client.ts';
import type { ProjectsStore } from '../lib/projects-store.ts';
import { projectsStoreFor } from './context.ts';
import { WhereFolder } from './new-ferret-where-folder.tsx';
import { WhereProject } from './new-ferret-where-project.tsx';

type Kind = 'folder' | 'project';

const CHOICES: readonly SegmentedChoiceOption<Kind>[] = [
  { value: 'project', label: 'Project' },
  { value: 'folder', label: 'Folder' },
];

/** What to show before the person chooses: the project a folder already is, else a folder, else Project if any exist. */
const defaultKind = (value: string, projects: readonly ProjectInfo[]): Kind => {
  if (value !== '') return projects.some(project => project.path === value) ? 'project' : 'folder';
  return projects.length > 0 ? 'project' : 'folder';
};

function NewFerretWhere({
  client,
  store,
  daemon,
  id,
  value,
  recent,
  onPick,
}: {
  readonly client: ProjectsClient;
  readonly store: ProjectsStore;
  readonly daemon: string;
  readonly id: string;
  readonly value: string;
  readonly recent: readonly string[];
  readonly onPick: (folder: string) => void;
}) {
  const { projects, status } = useProjectsSlice(store);
  // Git accounts' own "Connect a GitHub account" card, the one the create flow mounts; absent when that plugin is off.
  const provided = useAppHook(daemon, PROJECTS_CONNECT_ACCOUNT_HOOK);
  const connectAccount = isProjectsConnectAccount(provided) ? provided : undefined;
  const [chosen, setChosen] = useState<Kind | null>(null);
  const unread = projects === null && (status === 'idle' || status === 'loading');
  const known = projects ?? [];
  const kind = chosen ?? defaultKind(value, known);
  return (
    <div className="grid gap-2" data-new-ferret-where="">
      <SegmentedChoice
        data-new-ferret-where-switch=""
        label="Where it works"
        onChange={setChosen}
        options={CHOICES}
        value={kind}
      />
      {unread ? (
        <div className="min-h-[44px] text-ui text-muted" data-new-ferret-where-reading="" role="status">
          Reading your projects…
        </div>
      ) : kind === 'folder' ? (
        <WhereFolder client={client} id={id} onPick={onPick} recent={recent} value={value} />
      ) : (
        <WhereProject
          client={client}
          connectAccount={connectAccount}
          id={id}
          onPick={onPick}
          projects={known}
          store={store}
          value={value}
        />
      )}
    </div>
  );
}

/** The panel, built once per daemon client over the registry store the hub and the project page share. */
export const createNewFerretProjectsPanel = (client: ProjectsClient): AppComponent<PanelProps> => {
  const store = projectsStoreFor(client);
  return function NewFerretProjectsPanel(props: PanelProps) {
    return isNewFerretProjectSlotProps(props) ? (
      <NewFerretWhere
        client={client}
        daemon={props.daemon}
        id={props.id}
        onPick={props.onPick}
        recent={props.recent}
        store={store}
        value={props.value}
      />
    ) : null;
  };
};
