import type {
  AgendaId,
  AuditActor,
  CopyCapture,
  CopyCommandReport,
  CopyMeta,
  CopyName,
  CopyPlan,
  CopyPlanItem,
  InputAgentView,
  InputRaise,
  SurfaceKind,
  SurfaceOpener,
} from '@ferretry/protocol';

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
  /** A popup: the page that opened it. */
  readonly openerId?: string;
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
  /**
   * The card of a request pending on this surface, if any. With `typing` (terminal.send and browser.type only), a card
   * of one-time codes only is left out: the agent may type a code itself, so such a card does not keep it from typing.
   */
  pendingOn(
    sessionId: string,
    target: { readonly kind: SurfaceKind; readonly key: string },
    options?: { readonly typing?: boolean },
  ): AgendaId | undefined;
  /** Runs `work` as one turn in the session, so a send or close and a raise or secure write never interleave. */
  exclusive<T>(sessionId: string, work: () => Promise<T>): Promise<T>;
  /**
   * A page the daemon just typed a secret into: when its hold ends and the documents the values went into, or
   * nothing when it is not held. `names` are every way the page is known. Absent where no page is ever held.
   */
  pageHeld?(
    sessionId: string,
    names: readonly (string | undefined)[],
  ): { readonly until: number; readonly documents: readonly string[] } | undefined;
  /** The document a session's page shows now, or nothing when it cannot be told. */
  pageDocument?(sessionId: string, key: string): Promise<string | undefined>;
}

/**
 * What the agent tools ask of secure copy (docs/secure-copy.md): capture a value under a name, list the session's
 * copies, discard one. It throws `SecureCopyError` for a refusal. Nothing it returns carries a value.
 */
export interface AgentCopyPort {
  capture(
    sessionId: string,
    request: CopyCapture,
    context?: {
      /** The page's documents the agent has read, asked after the copy's read. */
      readonly seen?: () => readonly string[];
      /** Run inside the page's queue before the read: a takeover or a hold that landed meanwhile refuses it. */
      readonly guard?: (page: { document(): Promise<string | undefined> }) => Promise<void>;
    },
  ): Promise<{ readonly copy: CopyMeta; readonly command?: CopyCommandReport }>;
  list(sessionId: string): readonly CopyMeta[];
  discard(sessionId: string, name: CopyName): CopyMeta;
}

/**
 * What secure copy knows about pages, by document (`PageCopyRecords`): the documents a value was copied from,
 * which are not pictured while a page still shows one, and the documents the agent has read.
 */
export interface AgentCopyPagesPort {
  documents(sessionId: string, names: readonly (string | undefined)[]): readonly string[];
  saw(sessionId: string, names: readonly (string | undefined)[], navigationId: string): void;
  seen(sessionId: string, names: readonly (string | undefined)[]): readonly string[];
}

/** What `secure.preapprove` asks: raise one card listing the pastes the agent plans. Nothing in it is a value. */
export interface AgentPlanPort {
  propose(sessionId: string, items: readonly CopyPlanItem[], expiresInSeconds?: number): Promise<CopyPlan>;
}
