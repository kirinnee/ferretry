/** The project's own page (Projects' address for it), where the PR page goes back to. */
export const projectPagePath = (daemon: string, project: string): string =>
  `/d/${encodeURIComponent(daemon)}/projects/${encodeURIComponent(project)}`;
