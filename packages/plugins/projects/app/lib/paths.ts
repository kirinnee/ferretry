import { ProjectIdSchema } from '../../contract/index.ts';

/**
 * The app's addresses for this plugin's two screens (`projects`, `project`): a project is entered only through its
 * daemon's durable paired id and its registered UUID, never an address or a folder somebody typed.
 */
export const isProjectId = (value: string): boolean => ProjectIdSchema.safeParse(value).success;

export const projectsPath = (daemon: string): string => `/d/${encodeURIComponent(daemon)}/projects`;

export const projectPath = (daemon: string, projectId: string): string => {
  const value = projectId.trim();
  if (value === '') throw new Error('projectId must not be empty');
  // A path, a name or a folder somebody typed all reach here as a non-empty string. Refusing them at the builder is
  // what stops a link that LOOKS like a project address from being minted at all.
  if (!isProjectId(value)) throw new Error('projectId must be a registered project UUID');
  return `${projectsPath(daemon)}/${encodeURIComponent(value)}`;
};

/**
 * A ferret's page, for the "Open" a project's ferret list offers. The Ferrets screen is that plugin's to name; this is
 * the one address Projects needs from it (`/d/<daemon>/ferrets/<id>`, today's `/d/<daemon>/sessions/<id>`).
 */
export const ferretPath = (daemon: string, ferretId: string): string =>
  `/d/${encodeURIComponent(daemon)}/ferrets/${encodeURIComponent(ferretId)}`;

/**
 * Where a project's lanes are edited. The lane editor draws Board's data and is Board's screen; this is the one address
 * Projects needs from it (`/d/<daemon>/board/<project>`), the project's own board.
 */
export const projectBoardPath = (daemon: string, projectId: string): string =>
  `/d/${encodeURIComponent(daemon)}/board/${encodeURIComponent(projectId)}`;

/**
 * Where "Lanes ✎" goes: the project's own board with its lane editor open. Board opens the editor only when the
 * address says `?lanes=1` (Board's `projectLanesPath`); without it the button would land on the board itself.
 */
export const projectLanesPath = (daemon: string, projectId: string): string =>
  `${projectBoardPath(daemon, projectId)}?lanes=1`;
