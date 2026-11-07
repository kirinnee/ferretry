/**
 * A directory held OPEN, in the shape a capability that only speaks paths can use (today's
 * `lib/worktrees/ports.ts` `PinnedWorkingDirectory`, copied). Install it, start the child, and release WITHOUT
 * awaiting in between: a bracket that spans an await is visible to every other request in flight and is a bug in
 * the caller, not a tunable.
 */
export interface PinnedWorkingDirectory {
  /** Where the pin resolves to right now. Diagnostics and messages only — never reopened. */
  readonly describe: string;
  /** Installs the held directory and returns its undo, both synchronous. */
  install(): () => void;
}
