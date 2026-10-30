import type {
  AgendaConfirms,
  AgendaId,
  AgendaItem,
  AgendaResponse,
  AgendaSnapshot,
  AgendaSource,
  ResolvedAgendaItem,
  TaskRef,
} from '@ferretry/protocol';
import {
  type AgendaActor,
  type AgendaChange,
  type AgendaFailure,
  type AgendaLedger,
  type AgendaMutation,
  agentConfinedTo,
  applyAgendaCommandToSession,
  agendaSnapshot,
  type DaemonAgendaCause,
  type EditAgendaPatch,
  emptyAgendaLedger,
  type RaiseAgendaRequest,
} from './state-machine.ts';

/** The heading of an item the daemon raised without wording one: plain words, never an id. */
const DAEMON_TITLES: Readonly<Record<DaemonAgendaCause, string>> = {
  'source-reconciliation': 'Needs you',
  'warden-escalation': 'A ferret needs a human',
  system: 'Needs you',
  'harness-prompt': 'The ferret is waiting on you',
  'input-request': 'Needs a secret',
};

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

export interface AgendaClock {
  now(): string;
}

/** The adapter must serialize each callback with every other callback for the same session. */
export interface AgendaLedgerRepository {
  read(sessionId: string): Promise<AgendaLedger | null>;
  transact(sessionId: string, apply: (current: AgendaLedger | null) => AgendaMutation): Promise<AgendaMutation>;
}

/**
 * Proof that a board owner exists in this daemon's session registry.
 *
 * A missing agenda ledger is a legitimate empty board only when the session
 * itself is known. Keeping this separate from the ledger repository prevents a
 * typo or forged path from creating a phantom session directory.
 */
export interface AgendaSessionDirectory {
  has(sessionId: string): Promise<boolean>;
}

/** Told only after a newly created item has durably committed. Total: implementations never reject. */
export interface AgendaRaisedObserver {
  raised(sessionId: string, item: AgendaItem, snapshot: AgendaSnapshot): Promise<void>;
}

/**
 * Where a mutation came from: the board itself (a route, the CLI, the warden), or a person's chat message
 * that referenced the item — whose own words already reached the ferret, so nothing re-tells it.
 */
export type AgendaVia = 'board' | 'conversation';

/** One committed change to a board, as a change observer is told it. */
export interface AgendaBoardChange {
  readonly change: Exclude<AgendaChange, 'unchanged'>;
  readonly actor: AgendaActor;
  readonly via: AgendaVia;
  readonly snapshot: AgendaSnapshot;
  /** The item, on every change that leaves it open. */
  readonly item?: AgendaItem;
  /** The item as it was closed, on answered, resolved and dismissed changes. */
  readonly addressed?: ResolvedAgendaItem;
}

/** Told after every mutation that changed a board has durably committed. Total: implementations never reject. */
export interface AgendaChangeObserver {
  changed(sessionId: string, change: AgendaBoardChange): Promise<void>;
}

/**
 * The card a session works on (`config.focusTask`, board-design.md §3.3). An agenda add that names no card
 * belongs to the raising session's focus card (§2.6), so an ask is never raised without its work. Total in
 * spirit: a lookup that fails leaves the item without a card rather than refusing it.
 */
export interface AgendaFocusSource {
  focusOf(sessionId: string): Promise<TaskRef | null>;
}

/** No session has a focus card: every item keeps only the card it was raised with. */
export const NO_AGENDA_FOCUS: AgendaFocusSource = { focusOf: async () => null };

export type AgendaQueryResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: AgendaFailure };

export function isAgendaSessionId(value: string): boolean {
  return SESSION_ID.test(value);
}

export class AgendaService {
  constructor(
    private readonly repository: AgendaLedgerRepository,
    private readonly clock: AgendaClock,
    private readonly sessions: AgendaSessionDirectory,
    private readonly observer: AgendaRaisedObserver,
    private readonly changes: AgendaChangeObserver = { changed: async () => undefined },
    private readonly focus: AgendaFocusSource = NO_AGENDA_FOCUS,
  ) {}

  async list(sessionId: string): Promise<AgendaQueryResult<AgendaSnapshot>> {
    const unauthorized = await this.authorize(sessionId);
    if (unauthorized !== null) return { ok: false, error: unauthorized };
    const current = await this.repository.read(sessionId);
    return {
      ok: true,
      value: agendaSnapshot(current ?? emptyAgendaLedger(sessionId, this.clock.now())),
    };
  }

  async count(sessionId: string): Promise<AgendaQueryResult<number>> {
    const listed = await this.list(sessionId);
    return listed.ok ? { ok: true, value: listed.value.count } : listed;
  }

  async raise(sessionId: string, request: RaiseAgendaRequest, actor: AgendaActor): Promise<AgendaMutation> {
    const titled =
      actor.kind === 'daemon' && request.title === undefined
        ? { ...request, title: DAEMON_TITLES[actor.cause] }
        : request;
    const carded = titled.task === undefined ? await this.withFocusCard(sessionId, titled) : titled;
    return this.apply(sessionId, { action: 'raise', actor, request: carded, at: this.clock.now() });
  }

  /** An add that names no card takes the raising session's focus card, when it has one (§2.6). */
  private async withFocusCard(sessionId: string, request: RaiseAgendaRequest): Promise<RaiseAgendaRequest> {
    if (invalidSession(sessionId) !== null) return request;
    const task = await this.focus.focusOf(sessionId).catch(() => null);
    return task === null ? request : { ...request, task };
  }

  async answer(
    sessionId: string,
    id: AgendaId,
    response: AgendaResponse,
    actor: AgendaActor,
    note?: string | null,
    via: AgendaVia = 'board',
  ): Promise<AgendaMutation> {
    return this.apply(sessionId, { action: 'answer', actor, id, response, note, at: this.clock.now() }, via);
  }

  async edit(sessionId: string, id: AgendaId, patch: EditAgendaPatch, actor: AgendaActor): Promise<AgendaMutation> {
    return this.apply(sessionId, { action: 'edit', actor, id, patch, at: this.clock.now() });
  }

  /** Tick (or untick) one step of an open item; never resolves it, pushes or tells the ferret. */
  async progress(
    sessionId: string,
    id: AgendaId,
    step: number,
    done: boolean,
    actor: AgendaActor,
  ): Promise<AgendaMutation> {
    return this.apply(sessionId, { action: 'progress', actor, id, step, done, at: this.clock.now() });
  }

  /** The owner asks the raising ferret for more information: the item stays open, waiting on the ferret. */
  async needsInfo(sessionId: string, id: AgendaId, actor: AgendaActor, note?: string | null): Promise<AgendaMutation> {
    return this.apply(sessionId, { action: 'needs-info', actor, id, note, at: this.clock.now() });
  }

  /** The owner wants to talk an item through before answering: it stays open, in discussion with the ferret. */
  async discuss(sessionId: string, id: AgendaId, actor: AgendaActor, note?: string | null): Promise<AgendaMutation> {
    return this.apply(sessionId, { action: 'discuss', actor, id, note, at: this.clock.now() });
  }

  /** The owner's chat message named this item: it closes as `replied`, their words kept; nobody is pushed. */
  async reply(sessionId: string, id: AgendaId, actor: AgendaActor, note?: string | null): Promise<AgendaMutation> {
    return this.apply(sessionId, { action: 'reply', actor, id, note, at: this.clock.now() }, 'conversation');
  }

  /**
   * An item leaves discussion for the owner's queue. The raising ferret, the owner or the daemon's timer may
   * say so; surfacing an item already in the queue is no change.
   */
  async surface(sessionId: string, id: AgendaId, actor: AgendaActor, why?: string | null): Promise<AgendaMutation> {
    return this.apply(sessionId, { action: 'surface', actor, id, why, at: this.clock.now() });
  }

  async resolve(
    sessionId: string,
    id: AgendaId,
    actor: AgendaActor,
    note?: string | null,
    via: AgendaVia = 'board',
  ): Promise<AgendaMutation> {
    return this.apply(sessionId, { action: 'resolve', actor, id, note, at: this.clock.now() }, via);
  }

  async dismiss(sessionId: string, id: AgendaId, actor: AgendaActor, note?: string | null): Promise<AgendaMutation> {
    return this.apply(sessionId, { action: 'dismiss', actor, id, note, at: this.clock.now() });
  }

  /**
   * The owner's action on an item never reached its ferret: the item is the owner's again, as an open card
   * saying so (docs/agenda.md § Delivery). `request` names the request for more information or to discuss
   * it that was not delivered; absent for an answer. Daemon-only: the delivery path is the one witness.
   */
  async undelivered(sessionId: string, id: AgendaId, reason: string, request?: number): Promise<AgendaMutation> {
    return this.apply(sessionId, {
      action: 'undelivered',
      actor: { kind: 'daemon', cause: 'system' },
      id,
      reason,
      ...(request === undefined ? {} : { request }),
      at: this.clock.now(),
    });
  }

  /**
   * The held change a confirmation names moved on: the item names the new one, restated, and is the owner's
   * again (docs/agenda.md § Confirming a configuration change). Daemon-only: the config files are the witness.
   */
  async restateConfirms(
    sessionId: string,
    id: AgendaId,
    confirms: AgendaConfirms,
    premise: string,
  ): Promise<AgendaMutation> {
    return this.apply(sessionId, {
      action: 'restate-confirms',
      actor: { kind: 'daemon', cause: 'system' },
      id,
      confirms,
      premise,
      at: this.clock.now(),
    });
  }

  /** Trusted source reconciliation; transport-facing composition must never expose this directly. */
  async resolveSource(
    sessionId: string,
    source: AgendaSource,
    sourceRef: string,
    actor: AgendaActor,
    note?: string | null,
  ): Promise<AgendaMutation> {
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
    command: Parameters<typeof applyAgendaCommandToSession>[2],
    via: AgendaVia = 'board',
  ): Promise<AgendaMutation> {
    const unauthorized = await this.authorize(sessionId, command.actor);
    if (unauthorized !== null) return { ok: false, error: unauthorized };
    const mutation = await this.repository.transact(sessionId, current =>
      applyAgendaCommandToSession(current, sessionId, command),
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

  private async authorize(sessionId: string, actor?: AgendaActor): Promise<AgendaFailure | null> {
    const invalid = invalidSession(sessionId);
    if (invalid !== null) return invalid;
    if (actor !== undefined && !agentConfinedTo(actor, sessionId)) {
      return { code: 'forbidden', message: 'an agent may change the agenda only in its own session' };
    }
    return (await this.sessions.has(sessionId)) ? null : { code: 'not-found', message: `no such session ${sessionId}` };
  }
}

function invalidSession(sessionId: string): AgendaFailure | null {
  return isAgendaSessionId(sessionId)
    ? null
    : { code: 'invalid', message: `not a valid agenda session id: ${sessionId}` };
}
