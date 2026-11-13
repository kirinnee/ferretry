import { z } from 'zod';
import type { ProjectsClient } from './client.ts';
import { normalizeProjectPath } from './folders.ts';

/**
 * WHAT THIS HALF READS OF FERRETS. Projects needs nothing from Ferrets (§2.3), so this is not a dependency: the project
 * page shows the ferrets working in a project and starts one there, through Ferrets' own routes by key, and reads only
 * these fields of the list. A daemon with Ferrets off answers a refusal the page states, and the rest still draws.
 * (Today's `GET /v1/sessions` and `POST /v1/sessions` are these routes after the §1.4 rename.)
 */
const FERRETS_LIST_ROUTE = 'GET /v1/ferrets';
const FERRETS_START_ROUTE = 'POST /v1/ferrets';

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

/** The ferret a start made. */
const StartedFerretSchema = z.looseObject({ id: z.string().min(1) });

/** The owner's start of a top-level interactive ferret in one project's folder; a blank runtime never leaves the app. */
const LaunchRequestSchema = z.strictObject({
  runtime: z.string().trim().min(1),
  folder: z.string().min(1),
  /** Today's project start is the owner's terminal: interactive, never an autonomous ferret with no prompt. */
  mode: z.literal('interactive'),
});
export type LaunchRequest = z.infer<typeof LaunchRequestSchema>;

export const projectLaunchRequest = (runtime: string, folder: string): LaunchRequest =>
  LaunchRequestSchema.parse({ runtime, folder, mode: 'interactive' });

export const startFerret = async (client: ProjectsClient, request: LaunchRequest) =>
  StartedFerretSchema.parse(await client.call(FERRETS_START_ROUTE, { body: request }));

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
