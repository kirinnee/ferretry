import { jsonObject, type JsonValue } from '../../../lib/json.ts';
import { resolveSessionReference, type CallsignReference } from '../../../lib/names/policy.ts';
import type { ClockPort } from '../../../lib/ports.ts';
import { tryParseSessionId, type SessionId } from '../../../lib/session-id.ts';
import {
  signalStatusOf,
  type SignalRepository,
  type SignalTarget,
  type SignalTransition,
} from '../../../lib/session/signal/types.ts';
import type { DaemonStorage } from '../../storage/session-storage.ts';

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The same narrowing in the storage layer's own JSON vocabulary, so a rewritten document stays
 *  something the store can serialize rather than becoming `unknown`. */
function jsonRecord(value: JsonValue): Record<string, JsonValue> {
  return { ...(jsonObject(value) ?? {}) };
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** The declared wait as it sits on the document, dropped entirely when its start instant is missing. */
function declaredWait(value: unknown): SignalTarget['waiting'] {
  const wait = record(value);
  const since = text(wait.since);
  if (since === undefined) return undefined;
  return {
    since,
    ...(text(wait.until) === undefined ? {} : { until: text(wait.until) }),
    ...(text(wait.condition) === undefined ? {} : { condition: text(wait.condition) }),
    ...(text(wait.peer) === undefined ? {} : { peer: text(wait.peer) }),
    ...(text(wait.peerName) === undefined ? {} : { peerName: text(wait.peerName) }),
  };
}

/** A wait, back in the JSON vocabulary, with every absent field omitted rather than nulled. */
function waitDocument(wait: NonNullable<SignalTarget['waiting']>): Record<string, JsonValue> {
  return {
    since: wait.since,
    ...(wait.until === undefined ? {} : { until: wait.until }),
    ...(wait.condition === undefined ? {} : { condition: wait.condition }),
    ...(wait.peer === undefined ? {} : { peer: wait.peer }),
    ...(wait.peerName === undefined ? {} : { peerName: wait.peerName }),
  };
}

/**
 * The signal domain's view of the durable session record.
 *
 * A record whose status will not parse yields NO target rather than a guessed one, for the reason the
 * resume repository gives: a signal retires panes and writes terminal verdicts, so acting on a record
 * it could not read is exactly the mistake that costs an operator a live agent.
 *
 * CLEARED MEANS ABSENT, NOT `null`. This writes the same document `SessionStateSchema` governs, and
 * that schema declares `waiting` as an optional OBJECT — a `null` makes the document stop satisfying
 * the protocol, and every surface that parses before serving then drops the session it just saw. The
 * resume repository learned this the expensive way with `needsHumanKind`.
 */
export class StorageSignalRepository implements SignalRepository {
  constructor(
    private readonly storage: DaemonStorage,
    private readonly clock: ClockPort,
  ) {}

  async read(id: SessionId): Promise<SignalTarget | undefined> {
    const [config, state] = await Promise.all([this.storage.readConfig(id), this.storage.readState(id)]);
    if (config === undefined || state === undefined) return undefined;
    return this.target(id, record(config), record(state));
  }

  /**
   * The session a peer reference names, over the callsign resolution the names domain already owns.
   *
   * An exact id wins outright; otherwise the most recently claimed live callsign does. Reading the
   * configurations is the only way to do it — the session index carries no callsign — and the cost is
   * one read per session on a path taken once per declared wait.
   */
  async resolvePeer(reference: string): Promise<SignalTarget | undefined> {
    const references: CallsignReference[] = [];
    const configs = new Map<SessionId, Record<string, unknown>>();
    for (const indexed of this.storage.listSessions()) {
      const config = record(await this.storage.readConfig(indexed.id).catch(() => undefined));
      configs.set(indexed.id, config);
      const claimedAt = Date.parse(text(config.createdAt) ?? '');
      references.push({
        id: indexed.id,
        ...(text(config.teammate) === undefined ? {} : { callsign: text(config.teammate) }),
        claimedAtMs: Number.isFinite(claimedAt) ? claimedAt : 0,
      });
    }
    const resolved = tryParseSessionId(resolveSessionReference(reference, references, Date.parse(this.clock.now())));
    if (resolved === undefined || !configs.has(resolved)) return undefined;
    return await this.read(resolved);
  }

  async transition(id: SessionId, change: SignalTransition): Promise<SignalTarget> {
    const stamp = this.clock.now();
    const updated = await this.storage.updateState(id, current => {
      const next: Record<string, JsonValue> = {
        ...jsonRecord(current),
        ...(change.status === undefined ? {} : { status: change.status }),
        ...(change.health === undefined ? {} : { health: change.health }),
        ...(change.reason === undefined ? {} : { reason: change.reason }),
        ...(change.finishedAt === undefined ? {} : { finishedAt: change.finishedAt }),
        ...(change.promptReady === undefined ? {} : { promptReady: change.promptReady }),
        ...(change.waitingCreditSeconds === undefined ? {} : { waitingCreditSeconds: change.waitingCreditSeconds }),
        ...(change.waiting === undefined || change.waiting === 'clear'
          ? {}
          : { waiting: waitDocument(change.waiting) }),
      };
      if (change.waiting === 'clear') delete next.waiting;
      if (change.reanchorActivity) {
        delete next.nudgedAt;
        next.lastActivityAt = stamp;
        next.lastTranscriptAt = stamp;
        next.lastPaneAt = stamp;
      }
      return next;
    });
    // Appended after the state is durable, so a journal entry can never describe a change that was
    // not written — the reverse leaves a record claiming a transition the session never made.
    await this.storage.append(id, change.event, {
      ...(change.reason === undefined ? {} : { reason: change.reason }),
      ...(change.data ?? {}),
    });
    const config = await this.storage.readConfig(id);
    const target = this.target(id, record(config), record(updated));
    if (target === undefined) throw new Error(`session ${id} is unreadable after a signal transition`);
    return target;
  }

  private target(
    id: SessionId,
    config: Record<string, unknown>,
    state: Record<string, unknown>,
  ): SignalTarget | undefined {
    const status = signalStatusOf(state.status);
    const mode = config.mode === 'interactive' ? 'interactive' : config.mode === 'auto' ? 'auto' : undefined;
    if (status === undefined || mode === undefined) return undefined;
    return {
      id,
      status,
      mode,
      // The STATE's turn wins for the reason the resume repository records: both documents carry one,
      // and only the state's moves. A `done` marker certifies the turn the session is actually on.
      turn: count(state.turn) ?? count(config.turn) ?? 0,
      ...(text(config.teammate) === undefined ? {} : { teammate: text(config.teammate) }),
      ...(declaredWait(state.waiting) === undefined ? {} : { waiting: declaredWait(state.waiting) }),
      ...(count(state.waitingCreditSeconds) === undefined
        ? {}
        : { waitingCreditSeconds: count(state.waitingCreditSeconds) }),
    };
  }
}
