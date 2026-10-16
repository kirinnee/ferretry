import type { AuditActor, SurfaceKind, SurfaceOpener } from '@ferretry/protocol';

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
      /** Who the terminal a person opens is recorded as opened by; absent when nothing can be attested. */
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

/** What an agent may control, as the machine's settings say (`What agents may control`). */
export type AgentControlKind = 'terminal' | 'browser' | 'files';

/**
 * The machine's "What agents may control" switches, read per call so a change applies to the next
 * action without a restart. Owned by the machine-settings store; this domain only asks.
 */
export interface AgentControlPolicy {
  allows(kind: AgentControlKind): Promise<boolean>;
}

/** Where control changes are published: the session's own journal, which `/v1/events` streams. */
export interface SurfaceEventSink {
  publish(sessionId: string, type: string, data: unknown): Promise<void>;
}

export interface AgentToolClock {
  now(): number;
}

/** One surface, resolved from the name or id a call used. */
export interface ResolvedSurface {
  readonly surface: SurfaceKind;
  readonly id: string;
  readonly name?: string;
}
