/**
 * The runtimes on THIS machine, as Add skills needs them to pick a ferret's place: Runtimes' own catalog
 * (`GET /v1/runtimes`, read through the client the shell built this half with), reduced to the id and profile an
 * install names and the wrapper a ferret is known by. A list that cannot be read (Runtimes off, a refusal) offers none,
 * and the page then asks for the place in the install sheet, as it does for a ferret outside every project.
 */
import type { PluginClient } from '@ferretry/kernel/manifest';
import { RuntimeCatalogSchema } from '@ferretry/plugin-runtimes/contract';
import { useEffect, useState } from 'react';
import type { RuntimeChoice } from '../features/add-skills/add-skills-model.ts';

const NONE: readonly RuntimeChoice[] = [];

export const readRuntimeChoices = async (client: Pick<PluginClient, 'call'>): Promise<readonly RuntimeChoice[]> =>
  RuntimeCatalogSchema.parse(await client.call<unknown>('GET /v1/runtimes')).runtimes.map(runtime => ({
    id: runtime.id,
    wrapper: runtime.wrapper,
    profile: runtime.profile,
    harness: runtime.harness,
  }));

export function useRuntimeChoices(client: Pick<PluginClient, 'call'>): readonly RuntimeChoice[] {
  const [runtimes, setRuntimes] = useState<readonly RuntimeChoice[]>(NONE);
  useEffect(() => {
    let live = true;
    readRuntimeChoices(client).then(
      list => {
        if (live) setRuntimes(list);
      },
      () => {
        if (live) setRuntimes(NONE);
      },
    );
    return () => {
      live = false;
    };
  }, [client]);
  return runtimes;
}
