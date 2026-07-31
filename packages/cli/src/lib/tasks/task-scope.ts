import { refuse } from './errors';

/** Which records a command addresses: one session, or (read-only) the whole fleet. */
export interface TaskScope {
  /** `null` means the fleet-wide aggregate read; every mutation needs a concrete session. */
  readonly sessionId: string | null;
}

export interface TaskScopeInput {
  readonly session?: string | undefined;
  readonly all?: boolean | undefined;
  /** `FY_SESSION_ID` as the daemon exported it into the agent's environment. */
  readonly environmentSessionId?: string | undefined;
}

const trimmed = (value: string | undefined): string | undefined => {
  const candidate = value?.trim();
  return candidate === undefined || candidate.length === 0 ? undefined : candidate;
};

/**
 * `--session` wins over the ambient `FY_SESSION_ID`; `--all` opts into the fleet read instead.
 * An agent that names no session at all is refused here rather than silently writing to whichever
 * session the environment happened to carry.
 */
export function resolveTaskScope(input: TaskScopeInput): TaskScope {
  const session = trimmed(input.session);
  if (input.all === true) {
    if (session !== undefined) refuse('pass --all or --session, not both');
    return { sessionId: null };
  }
  const sessionId = session ?? trimmed(input.environmentSessionId);
  if (sessionId === undefined) {
    refuse('no session id: run inside a session, pass --session <id>, or use `list --all` for the fleet board');
  }
  return { sessionId };
}

/** Narrow a scope to the session a mutation requires, refusing the fleet-wide form. */
export function requireSessionId(scope: TaskScope): string {
  return scope.sessionId ?? refuse('this command writes and therefore needs a session; --all is read-only');
}
