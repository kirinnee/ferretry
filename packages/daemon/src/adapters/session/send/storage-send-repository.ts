import { jsonObject, type JsonValue } from '../../../lib/json.ts';
import { resolveSessionReference, type CallsignReference } from '../../../lib/names/policy.ts';
import type { ClockPort } from '../../../lib/ports.ts';
import { tryParseSessionId, type SessionId } from '../../../lib/session-id.ts';
import type { SendRepository, SendTarget, SendTransition } from '../../../lib/session/send/types.ts';
import { signalStatusOf } from '../../../lib/session/signal/types.ts';
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
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** Journal payloads are `unknown` at the port and JSON at the store; anything else is dropped rather
 *  than stringified into something a reader would mistake for a value the daemon meant. */
function journalData(data: Readonly<Record<string, unknown>>): Record<string, JsonValue> {
  const entries: Array<[string, JsonValue]> = [];
  for (const [key, value] of Object.entries(data))
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null)
      entries.push([key, value]);
  return Object.fromEntries(entries);
}

/**
 * The send domain's view of the durable session record.
 *
 * A record whose status will not parse yields NO target rather than a guessed one, for the reason the
 * resume and signal repositories both give: a send types into a live terminal, and acting on a
 * document it could not read is how a message lands somewhere nobody was watching.
 *
 * THE STATE'S TURN WINS. Both documents carry one and only the state's moves — the same defect the
 * resume repository records, and it bites harder here: a send that planned `turn + 1` from a frozen
 * configuration would write over a turn document the agent may not have read yet.
 */
export class StorageSendRepository implements SendRepository {
  constructor(
    private readonly storage: DaemonStorage,
    private readonly clock: ClockPort,
  ) {}

  async read(id: SessionId): Promise<SendTarget | undefined> {
    const [config, state] = await Promise.all([this.storage.readConfig(id), this.storage.readState(id)]);
    if (config === undefined || state === undefined) return undefined;
    return this.target(id, record(config), record(state));
  }

  /**
   * The session an actor reference names, over the callsign resolution the names domain owns.
   *
   * The same resolution the signal domain's peer lookup uses, and deliberately so: a park declared on
   * a callsign must be ended by a send FROM that same callsign, and two different resolutions would
   * eventually disagree about which session that is.
   */
  async resolveSender(reference: string): Promise<SendTarget | undefined> {
    const references: CallsignReference[] = [];
    for (const indexed of this.storage.listSessions()) {
      const config = record(await this.storage.readConfig(indexed.id).catch(() => undefined));
      const claimedAt = Date.parse(text(config.createdAt) ?? '');
      references.push({
        id: indexed.id,
        ...(text(config.teammate) === undefined ? {} : { callsign: text(config.teammate) }),
        claimedAtMs: Number.isFinite(claimedAt) ? claimedAt : 0,
      });
    }
    const resolved = tryParseSessionId(resolveSessionReference(reference, references, Date.parse(this.clock.now())));
    return resolved === undefined ? undefined : await this.read(resolved);
  }

  async journal(id: SessionId, event: string, data: Readonly<Record<string, unknown>>): Promise<void> {
    await this.storage.append(id, event, journalData(data));
  }

  async transition(id: SessionId, change: SendTransition): Promise<SendTarget> {
    const stamp = this.clock.now();
    const updated = await this.storage.updateState(id, current => {
      const next: Record<string, JsonValue> = {
        ...jsonRecord(current),
        ...(change.status === undefined ? {} : { status: change.status }),
        ...(change.health === undefined ? {} : { health: change.health }),
        ...(change.turn === undefined ? {} : { turn: change.turn }),
        ...(change.promptReady === undefined ? {} : { promptReady: change.promptReady }),
        ...(change.reason === undefined ? {} : { reason: change.reason }),
      };
      // CLEARED MEANS ABSENT, NOT `null`: this writes the document `SessionStateSchema` governs, and a
      // `null` in an optional STRING field makes every surface that parses before serving drop the
      // session it just saw. The resume repository learned this the expensive way.
      if (change.reason === undefined) delete next.reason;
      if (change.restartTurnClock) {
        // A new turn is a new liveness episode. The turn clock restarts, the activity ledger is
        // re-anchored, and the previous turn's nudge mark goes — otherwise a stale nudge lets the
        // reflex layer cold-kill a turn that has only just begun.
        next.startedAt = stamp;
        next.lastActivityAt = stamp;
        next.turnCompleted = false;
        delete next.nudgedAt;
      }
      return next;
    });
    // Appended after the state is durable, so a journal entry can never describe a change that was
    // not written — the reverse leaves a record claiming a transition the session never made.
    await this.storage.append(id, change.event, {
      ...(change.reason === undefined ? {} : { reason: change.reason }),
      ...journalData(change.data ?? {}),
    });
    const config = await this.storage.readConfig(id);
    const target = this.target(id, record(config), record(updated));
    if (target === undefined) throw new Error(`session ${id} is unreadable after a send transition`);
    return target;
  }

  private target(
    id: SessionId,
    config: Record<string, unknown>,
    state: Record<string, unknown>,
  ): SendTarget | undefined {
    const status = signalStatusOf(state.status);
    const mode = config.mode === 'interactive' ? 'interactive' : config.mode === 'auto' ? 'auto' : undefined;
    if (status === undefined || mode === undefined) return undefined;
    const question = record(state.pendingQuestion);
    const toolUseId = text(question.toolUseId);
    const wait = record(state.waiting);
    const peer = text(wait.peer);
    return {
      id,
      status,
      mode,
      turn: count(state.turn) ?? count(config.turn) ?? 0,
      ...(text(config.teammate) === undefined ? {} : { teammate: text(config.teammate) }),
      ...(typeof state.promptReady === 'boolean' ? { promptReady: state.promptReady } : {}),
      ...(text(state.needsHumanKind) === undefined ? {} : { needsHumanKind: text(state.needsHumanKind) }),
      ...(toolUseId === undefined ? {} : { pendingQuestion: { toolUseId } }),
      ...(count(config.directSendMaxChars) === undefined
        ? {}
        : { directSendMaxChars: count(config.directSendMaxChars) }),
      ...(peer === undefined
        ? {}
        : { waiting: { peer, ...(text(wait.peerName) === undefined ? {} : { peerName: text(wait.peerName) }) } }),
    };
  }
}
