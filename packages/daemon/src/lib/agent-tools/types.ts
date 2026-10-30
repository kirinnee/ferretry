import type { AgendaId, AuditActor, InputAgentView, InputRaise, SurfaceKind, SurfaceOpener } from '@ferretry/protocol';

/**
 * WHO IS CALLING A TOOL — derived by the route, never stated by the caller.
 *
 * `agent` is a session that proved which one it is with the credential the daemon minted into its own
 * environment (see `AgentIdentityResolver`). Its session is that credential's session and nothing
 * else: no body field, header or path segment can point it at another one. `person` is somebody using
 * the CLI or the app against a session they named, already authorized by the route's grants.
 */
export type AgentToolCaller =
  | {
      readonly kind: 'agent';
      readonly sessionId: string;
      /** The session's display name (`Hadi`), for "Hadi is typing here". */
      readonly name?: string;
    }
  | {
      readonly kind: 'person';
      readonly sessionId: string;
      readonly actor: AuditActor;
      /** Who the terminal or page a person opens is recorded as opened by; absent when nothing can be attested. */
      readonly openedBy?: SurfaceOpener;
    };

/** A session, as the credential that proves it was minted for. */
export interface AgentIdentity {
  readonly sessionId: string;
  readonly name?: string;
}

/** Turns a presented session credential into the session it was minted for, or nothing. */
export interface AgentIdentityResolver {
  resolve(capability: string): Promise<AgentIdentity | undefined>;
}

/** One control event, as the session's journal hands it back. */
export interface RecordedSurfaceEvent {
  readonly type: string;
  readonly data: unknown;
}

/**
 * Where control changes are published — the session's own journal, which `/v1/events` streams — and
 * read back from, so a takeover or a hand-over outlives a daemon restart.
 */
export interface SurfaceEventSink {
  publish(sessionId: string, type: string, data: unknown): Promise<void>;
  /** This session's earlier `surface.*` events, oldest first. */
  history(sessionId: string): Promise<readonly RecordedSurfaceEvent[]>;
}

export interface AgentToolClock {
  now(): number;
}

/** One surface, resolved from the name or id a call used. */
export interface ResolvedSurface {
  readonly surface: SurfaceKind;
  readonly id: string;
  readonly name?: string;
  /** Who opened it, when the daemon can attest that. */
  readonly openedBy?: SurfaceOpener;
  /** A browser page in its own throwaway context. */
  readonly incognito?: true;
}

/**
 * What the agent tools ask of the input-request service (docs/input-requests.md): raise a request, wait on
 * one, and say whether a surface has one pending. It throws `InputRequestError` for a refusal. Nothing it
 * takes or returns carries a value.
 */
export interface AgentInputPort {
  raise(sessionId: string, raise: InputRaise): Promise<InputAgentView>;
  /** Waits up to `waitMs` for the request to reach a final state, then says where it stands. */
  agentView(sessionId: string, id: AgendaId, waitMs: number): Promise<InputAgentView>;
  /** The card of a request pending on this surface, if any. */
  pendingOn(sessionId: string, target: { readonly kind: SurfaceKind; readonly key: string }): AgendaId | undefined;
  /** Runs `work` as one turn in the session, so a send or close and a raise or secure write never interleave. */
  exclusive<T>(sessionId: string, work: () => Promise<T>): Promise<T>;
}
