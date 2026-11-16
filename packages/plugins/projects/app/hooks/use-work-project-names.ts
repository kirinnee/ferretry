/**
 * The names of a machine's projects, joined only while `active` so a surface that cannot search adds no request.
 */
import { useEffect, useState } from 'react';
import type { ProjectsClient } from '../lib/client.ts';
import { readWorkProjectNames } from '../lib/work-project-names.ts';

const NO_NAMES: ReadonlyMap<string, string> = new Map();

export function useWorkProjectNames(client: ProjectsClient | undefined, active: boolean): ReadonlyMap<string, string> {
  const [names, setNames] = useState<ReadonlyMap<string, string>>(NO_NAMES);
  useEffect(() => {
    if (client === undefined || !active) return;
    let current = true;
    void readWorkProjectNames(client)
      .then(read => {
        if (current) setNames(read);
      })
      .catch(() => {
        if (current) setNames(NO_NAMES);
      });
    return () => {
      current = false;
    };
  }, [client, active]);
  return names;
}
