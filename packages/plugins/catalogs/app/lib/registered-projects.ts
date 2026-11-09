/**
 * The projects registered on THIS machine, as the install sheets offer them (the folder an item installs into): Projects'
 * own list (`GET /v1/projects`, read through the client the shell built this half with), reduced to a name and a folder.
 * A list that cannot be read offers none, and the sheet then says it has no project to offer.
 */
import { ProjectListSchema } from '@ferretry/plugin-projects/contract';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { useEffect, useState } from 'react';

export interface OfferedProject {
  readonly name: string;
  readonly path: string;
}

const NONE: readonly OfferedProject[] = [];

export const readRegisteredProjects = async (client: Pick<PluginClient, 'call'>): Promise<readonly OfferedProject[]> =>
  ProjectListSchema.parse(await client.call('GET /v1/projects')).map(project => ({
    name: project.name,
    path: project.path,
  }));

export function useRegisteredProjects(client: Pick<PluginClient, 'call'>): readonly OfferedProject[] {
  const [projects, setProjects] = useState<readonly OfferedProject[]>(NONE);
  useEffect(() => {
    let live = true;
    readRegisteredProjects(client).then(
      list => {
        if (live) setProjects(list);
      },
      () => {
        if (live) setProjects(NONE);
      },
    );
    return () => {
      live = false;
    };
  }, [client]);
  return projects;
}
