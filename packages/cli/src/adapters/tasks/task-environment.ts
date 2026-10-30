/**
 * What the task commands read from the environment the agent was launched with. Only `FY_*` is read —
 * there is no legacy fallback and no state-home probe, because the CLI must not know the daemon's
 * on-disk layout (migration plan §4). Where the daemon *lives* is resolved once in the composition
 * root, so every command group speaks to the same `fyd`.
 */
const present = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
};

/** The session a command writes to when `--session` is absent. */
export function environmentSessionId(environment: Record<string, string | undefined>): string | undefined {
  return present(environment.FY_SESSION_ID);
}
