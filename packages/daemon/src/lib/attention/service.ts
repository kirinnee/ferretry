import type {
  AttentionId,
  AttentionItem,
  AttentionResponse,
  AttentionSnapshot,
  AttentionSource,
  ResolvedAttentionItem,
} from '@ferretry/protocol';
import {
  type AttentionActor,
  type AttentionChange,
  type AttentionFailure,
  type AttentionLedger,
  type AttentionMutation,
  agentConfinedTo,
  applyAttentionCommandToSession,
  attentionSnapshot,
  type DaemonAttentionCause,
  type EditAttentionPatch,
  emptyAttentionLedger,
  type RaiseAttentionRequest,
} from './state-machine.ts';

/** The heading of an item the daemon raised without wording one: plain words, never an id. */
const DAEMON_TITLES: Readonly<Record<DaemonAttentionCause, string>> = {
  'source-reconciliation': 'Needs you',
  'warden-escalation': 'A ferret needs a human',
  system: 'Needs you',
  'harness-prompt': 'The ferret is waiting on you',
};

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

export interface AttentionClock {
  now(): string;
}

/** The adapter must serialize each callback with every other callback for the same session. */
export interface AttentionLedgerRepository {
  read(sessionId: string): Promise<AttentionLedger | null>;
  transact(
    sessionId: string,
    apply: (current: AttentionLedger | null) => AttentionMutation,
  ): Promise<AttentionMutation>;
}

/**
 * Proof that a board owner exists in this daemon's session registry.
 *
 * A missing attention ledger is a legitimate empty board only when the session
 * itself is known. Keeping this separate from the ledger repository prevents a
 * typo or forged path from creating a phantom session directory.
 */
export interface AttentionSessionDirectory {
  has(sessionId: string): Promise<boolean>;
}

/** Told only after a newly created item has durably committed. Total: implementations never reject. */
export interface AttentionRaisedObserver {
  raised(sessionId: string, item: AttentionItem, snapshot: AttentionSnapshot): Promise<void>;
}

/**
 * Where a mutation came from: the board itself (a route, the CLI, the warden), or a person's chat message
 * that referenced the item — whose own words already reached the ferret, so nothing re-tells it.
 */
export type AttentionVia = 'board' | 'conversation';

/** One committed change to a board, as a change observer is told it. */
export interface AttentionBoardChange {
  readonly change: Exclude<AttentionChange, 'unchanged'>;
  readonly actor: AttentionActor;
  readonly via: AttentionVia;
  readonly snapshot: AttentionSnapshot;
  /** The item, on every change that leaves it open. */
  readonly item?: AttentionItem;
  /** The item as it was closed, on answered, resolved and dismissed changes. */
  readonly addressed?: ResolvedAttentionItem;
}

/** Told after every mutation that changed a board has durably committed. Total: implementations never reject. */
export interface AttentionChangeObserver {
  changed(sessionId: string, change: AttentionBoardChange): Promise<void>;
}

export type AttentionQueryResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: AttentionFailure };

export function isAttentionSessionId(value: string): boolean {
  return SESSION_ID.test(value);
}

export class AttentionService {
  constructor(
    private readonly repository: AttentionLedgerRepository,
    private readonly clock: AttentionClock,
    private readonly sessions: AttentionSessionDirectory,
    private readonly observer: AttentionRaisedObserver,
    private readonly changes: AttentionChangeObserver = { changed: async () => undefined },
  ) {}

  async list(sessionId: string): Promise<AttentionQueryResult<AttentionSnapshot>> {
    const unauthorized = await this.authorize(sessionId);
    if (unauthorized !== null) return { ok: false, error: unauthorized };
    const current = await this.repository.read(sessionId);
    return {
      ok: true,
      value: attentionSnapshot(current ?? emptyAttentionLedger(sessionId, this.clock.now())),
    };
  }

  async count(sessionId: string): Promise<AttentionQueryResult<number>> {
    const listed = await this.list(sessionId);
    return listed.ok ? { ok: true, value: listed.value.count } : listed;
  }

  async raise(sessionId: string, request: RaiseAttentionRequest, actor: AttentionActor): Promise<AttentionMutation> {
    const titled =
      actor.kind === 'daemon' && request.title === undefined
        ? { ...request, title: DAEMON_TITLES[actor.cause] }
        : request;
    return this.apply(sessionId, { action: 'raise', actor, request: titled, at: this.clock.now() });
  }

  async answer(
    sessionId: string,
    id: AttentionId,
    response: AttentionResponse,
    actor: AttentionActor,
    note?: string | null,
    via: AttentionVia = 'board',
  ): Promise<AttentionMutation> {
    return this.apply(sessionId, { action: 'answer', actor, id, response, note, at: this.clock.now() }, via);
  }

  async edit(
    sessionId: string,
    id: AttentionId,
    patch: EditAttentionPatch,
    actor: AttentionActor,
  ): Promise<AttentionMutation> {
    return this.apply(sessionId, { action: 'edit', actor, id, patch, at: this.clock.now() });
  }

  /** Tick (or untick) one step of an open item; never resolves it, pushes or tells the ferret. */
  async progress(
    sessionId: string,
    id: AttentionId,
    step: number,
    done: boolean,
    actor: AttentionActor,
  ): Promise<AttentionMutation> {
    return this.apply(sessionId, { action: 'progress', actor, id, step, done, at: this.clock.now() });
  }

  /** The owner asks the raising ferret for more information: the item stays open, waiting on the ferret. */
  async needsInfo(
    sessionId: string,
    id: AttentionId,
    actor: AttentionActor,
    note?: string | null,
  ): Promise<AttentionMutation> {
    return this.apply(sessionId, { action: 'needs-info', actor, id, note, at: this.clock.now() });
  }

  /** The owner wants to talk an item through before answering: it stays open, in discussion with the ferret. */
  async discuss(
    sessionId: string,
    id: AttentionId,
    actor: AttentionActor,
    note?: string | null,
  ): Promise<AttentionMutation> {
    return this.apply(sessionId, { action: 'discuss', actor, id, note, at: this.clock.now() });
  }

  /** The owner's chat message named this item: it is the ferret's turn now. Nothing resolves; nobody is pushed. */
  async reply(sessionId: string, id: AttentionId, actor: AttentionActor): Promise<AttentionMutation> {
    return this.apply(sessionId, { action: 'reply', actor, id, at: this.clock.now() }, 'conversation');
  }

  /**
   * An item leaves discussion for the owner's queue. The raising ferret, the owner or the daemon's timer may
   * say so; surfacing an item already in the queue is no change.
   */
  async surface(
    sessionId: string,
    id: AttentionId,
    actor: AttentionActor,
    why?: string | null,
  ): Promise<AttentionMutation> {
    return this.apply(sessionId, { action: 'surface', actor, id, why, at: this.clock.now() });
  }

  async resolve(
    sessionId: string,
    id: AttentionId,
    actor: AttentionActor,
    note?: string | null,
    via: AttentionVia = 'board',
  ): Promise<AttentionMutation> {
    return this.apply(sessionId, { action: 'resolve', actor, id, note, at: this.clock.now() }, via);
  }

  async dismiss(
    sessionId: string,
    id: AttentionId,
    actor: AttentionActor,
    note?: string | null,
  ): Promise<AttentionMutation> {
    return this.apply(sessionId, { action: 'dismiss', actor, id, note, at: this.clock.now() });
  }

  /**
   * The owner's action on an item never reached its ferret: the item is the owner's again, as an open card
   * saying so (docs/attention.md § Delivery). `request` names the request for more information or to discuss
   * it that was not delivered; absent for an answer. Daemon-only: the delivery path is the one witness.
   */
  async undelivered(sessionId: string, id: AttentionId, reason: string, request?: number): Promise<AttentionMutation> {
    return this.apply(sessionId, {
      action: 'undelivered',
      actor: { kind: 'daemon', cause: 'system' },
      id,
      reason,
      ...(request === undefined ? {} : { request }),
      at: this.clock.now(),
    });
  }

  /** Trusted source reconciliation; transport-facing composition must never expose this directly. */
  async resolveSource(
    sessionId: string,
    source: AttentionSource,
    sourceRef: string,
    actor: AttentionActor,
    note?: string | null,
  ): Promise<AttentionMutation> {
    return this.apply(sessionId, {
      action: 'resolve-source',
      actor,
      source,
      sourceRef,
      note,
      at: this.clock.now(),
    });
  }

  private async apply(
    sessionId: string,
    command: Parameters<typeof applyAttentionCommandToSession>[2],
    via: AttentionVia = 'board',
  ): Promise<AttentionMutation> {
    const unauthorized = await this.authorize(sessionId, command.actor);
    if (unauthorized !== null) return { ok: false, error: unauthorized };
    const mutation = await this.repository.transact(sessionId, current =>
      applyAttentionCommandToSession(current, sessionId, command),
    );
    if (mutation.ok && mutation.change === 'created' && mutation.item !== undefined) {
      try {
        await this.observer.raised(sessionId, mutation.item, mutation.snapshot);
      } catch {
        // Persistence is primary: presentation can neither revise nor fail the committed mutation.
      }
    }
    if (mutation.ok && mutation.changed && mutation.change !== 'unchanged') {
      try {
        await this.changes.changed(sessionId, {
          change: mutation.change,
          actor: command.actor,
          via,
          snapshot: mutation.snapshot,
          ...(mutation.item === undefined ? {} : { item: mutation.item }),
          ...(mutation.addressed === undefined ? {} : { addressed: mutation.addressed }),
        });
      } catch {
        // The same rule: a projection or a delivery never revises a committed board.
      }
    }
    return mutation;
  }

  private async authorize(sessionId: string, actor?: AttentionActor): Promise<AttentionFailure | null> {
    const invalid = invalidSession(sessionId);
    if (invalid !== null) return invalid;
    if (actor !== undefined && !agentConfinedTo(actor, sessionId)) {
      return { code: 'forbidden', message: 'an agent may change the agenda only in its own session' };
    }
    return (await this.sessions.has(sessionId)) ? null : { code: 'not-found', message: `no such session ${sessionId}` };
  }
}

function invalidSession(sessionId: string): AttentionFailure | null {
  return isAttentionSessionId(sessionId)
    ? null
    : { code: 'invalid', message: `not a valid agenda session id: ${sessionId}` };
}
