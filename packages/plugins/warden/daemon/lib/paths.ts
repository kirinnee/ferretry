/** Where warden supervision keeps its artefacts, as names inside its own state (`state/warden/`). */
export interface WardenPaths {
  /** The folder reports are listed under; a report's path is `<reports>/<name>`. */
  readonly reports: string;
}

export const WARDEN_PATHS: WardenPaths = { reports: 'reports' };
