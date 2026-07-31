import { jsonObject, type JsonValue } from '../../../lib/json.ts';
import { tryParseSessionId, type SessionId } from '../../../lib/session-id.ts';
import {
  ResumableSessionStatusSchema,
  type ResumeRepository,
  type ResumeTarget,
  type ResumeTransition,
} from '../../../lib/session/resume/types.ts';
import type { DaemonStorage } from '../../storage/session-storage.ts';

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The same narrowing, in the storage layer's own JSON vocabulary, so a document this repository
 *  rewrites stays a value the store can serialize rather than becoming `unknown`. */
function jsonRecord(value: JsonValue): Record<string, JsonValue> {
  return { ...(jsonObject(value) ?? {}) };
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Resume's view of the durable session record.
 *
 * A record whose status will not parse yields NO target rather than a guessed one. Resume kills
 * panes and replaces terminals, so acting on a record it could not read is exactly the class of
 * mistake that costs an operator a live agent — a refusal to act is always the recoverable error.
 */
export class StorageResumeRepository implements ResumeRepository {
  constructor(private readonly storage: DaemonStorage) {}

  async read(id: SessionId): Promise<ResumeTarget | undefined> {
    const [config, state] = await Promise.all([this.storage.readConfig(id), this.storage.readState(id)]);
    if (config === undefined || state === undefined) return undefined;
    return this.target(id, record(config), record(state));
  }

  async list(): Promise<readonly ResumeTarget[]> {
    const targets: ResumeTarget[] = [];
    for (const indexed of this.storage.listSessions()) {
      const target = await this.read(indexed.id).catch(() => undefined);
      if (target) targets.push(target);
    }
    return targets;
  }

  async transition(id: SessionId, change: ResumeTransition): Promise<ResumeTarget> {
    const updated = await this.storage.updateState(id, current => {
      const next: Record<string, JsonValue> = {
        ...jsonRecord(current),
        ...(change.status === undefined ? {} : { status: change.status }),
        ...(change.turn === undefined ? {} : { turn: change.turn }),
        ...(change.retryAttempt === undefined ? {} : { retryAttempt: change.retryAttempt }),
        ...(change.reason === undefined ? {} : { reason: change.reason }),
      };
      // CLEARED MEANS ABSENT, NOT `null`, and the difference is not cosmetic. This repository writes
      // the same state document `SessionStateSchema` governs, and that schema declares
      // `needsHumanKind` as an optional STRING — so a `null` makes the document stop satisfying the
      // protocol, and every surface that parses it before serving (the session read, the fleet list,
      // analytics) then drops the session rather than reporting one it cannot vouch for. An
      // operator's own revive would have made the session it revived disappear.
      if (change.clearPendingQuestion) delete next.pendingQuestion;
      // BOTH halves of the quarantine. `needsHuman` is the reason a person was asked for and
      // `needsHumanKind` is which kind of attention it was; clearing only the kind would leave the
      // session displayed as still waiting for somebody who has already answered.
      if (change.clearNeedsHuman) {
        delete next.needsHuman;
        delete next.needsHumanKind;
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
    if (!target) throw new Error(`session ${id} is unreadable after a resume transition`);
    return target;
  }

  private target(
    id: SessionId,
    config: Record<string, unknown>,
    state: Record<string, unknown>,
  ): ResumeTarget | undefined {
    const status = ResumableSessionStatusSchema.safeParse(state.status);
    const mode = config.mode === 'interactive' ? 'interactive' : config.mode === 'auto' ? 'auto' : undefined;
    const cwd = text(config.cwd);
    if (!status.success || mode === undefined || cwd === undefined || tryParseSessionId(id) === undefined)
      return undefined;
    const question = record(state.pendingQuestion);
    const toolUseId = text(question.toolUseId);
    return {
      id,
      status: status.data,
      mode,
      cwd,
      ...(text(config.label) === undefined ? {} : { label: text(config.label) }),
      /**
       * THE STATE'S TURN WINS, and reading the configuration first was a defect that destroyed work.
       *
       * Both documents carry a `turn`: the start writes it into both, and after that only the STATE
       * moves — `transition({ turn })` is how a revive records the document it just handed over, and
       * nothing ever rewrites the configuration's copy. Preferring the configuration therefore froze
       * every session at the turn it was created on, so `planResume` planned `turn + 1` from that
       * frozen number and the SECOND revive of a session wrote `turns/turn-002.md` again — over the
       * first revive's assignment, which the agent may not have read yet.
       *
       * The configuration remains the fallback for a session whose state document predates the field.
       */
      turn: count(state.turn) ?? count(config.turn) ?? 0,
      ...(count(state.retryAttempt) === undefined ? {} : { retryAttempt: count(state.retryAttempt) }),
      ...(toolUseId === undefined ? {} : { pendingQuestion: { toolUseId } }),
      ...(text(state.needsHumanKind) === undefined ? {} : { needsHumanKind: text(state.needsHumanKind) }),
      ...(count(record(config.retry).transientAttempts) === undefined
        ? {}
        : { transientRetryBudget: count(record(config.retry).transientAttempts) }),
    };
  }
}
