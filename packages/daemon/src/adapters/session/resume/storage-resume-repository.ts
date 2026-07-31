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
    const updated = await this.storage.updateState(id, current => ({
      ...record(current),
      ...(change.status === undefined ? {} : { status: change.status }),
      ...(change.turn === undefined ? {} : { turn: change.turn }),
      ...(change.retryAttempt === undefined ? {} : { retryAttempt: change.retryAttempt }),
      ...(change.reason === undefined ? {} : { reason: change.reason }),
      ...(change.clearPendingQuestion ? { pendingQuestion: null } : {}),
      ...(change.clearNeedsHuman ? { needsHumanKind: null } : {}),
    }));
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
      turn: count(config.turn) ?? count(state.turn) ?? 0,
      ...(count(state.retryAttempt) === undefined ? {} : { retryAttempt: count(state.retryAttempt) }),
      ...(toolUseId === undefined ? {} : { pendingQuestion: { toolUseId } }),
      ...(text(state.needsHumanKind) === undefined ? {} : { needsHumanKind: text(state.needsHumanKind) }),
      ...(count(record(config.retry).transientAttempts) === undefined
        ? {}
        : { transientRetryBudget: count(record(config.retry).transientAttempts) }),
    };
  }
}
