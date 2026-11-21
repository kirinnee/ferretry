import { z } from 'zod';
import type { ProjectsClient } from './client.ts';
import { normalizeProjectPath } from './folders.ts';

/**
 * WHAT THIS HALF READS OF FERRETS. Projects needs nothing from Ferrets (§2.3), so this is not a dependency: the project
 * page shows the ferrets working in a project and reads only these fields of the list. A daemon with Ferrets off answers
 * a refusal the page states, and the rest still draws. (Today's `GET /v1/sessions` is this route after the §1.4 rename.)
 * Starting a ferret is Ferrets' New ferret page alone: the project page links there (`start-href.ts`).

 */
const FERRETS_LIST_ROUTE = 'GET /v1/ferrets';

const FERRET_STATES = ['starting', 'working', 'idle', 'stopped'] as const;

const FerretRowSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string(),
  harness: z.string(),
  folder: z.string(),
  state: z.enum(FERRET_STATES),
  stateAt: z.string(),
});
export type FerretRow = z.infer<typeof FerretRowSchema>;

export const readFerrets = async (client: ProjectsClient): Promise<readonly FerretRow[]> =>
  z.array(FerretRowSchema).parse(await client.call(FERRETS_LIST_ROUTE));

/** The ferrets working in a project's folder, most recently changed first. */
export const projectFerrets = (projectPath: string, ferrets: readonly FerretRow[]): readonly FerretRow[] => {
  const root = normalizeProjectPath(projectPath);
  return ferrets
    .filter(ferret => normalizeProjectPath(ferret.folder) === root)
    .toSorted((left, right) => (Date.parse(right.stateAt) || 0) - (Date.parse(left.stateAt) || 0));
};

/** Active means a ferret that is not stopped. */
export const activeProjectFerrets = (ferrets: readonly FerretRow[]): readonly FerretRow[] =>
  ferrets.filter(ferret => ferret.state !== 'stopped');
