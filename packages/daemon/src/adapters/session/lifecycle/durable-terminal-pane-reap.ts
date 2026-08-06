import {
  createSessionPaths,
  type FileSystemPort,
  type FoundationPaths,
  hasSafeTerminalPaneIdentity,
  parseSessionId,
  type SessionId,
  type SessionLifecycleRecord,
  type TmuxController,
} from '../../../lib/index.ts';
import type {
  DurableTerminalSession,
  ObservedTerminalPane,
  RegisteredTerminalPane,
  TerminalReapTarget,
} from '../../../lib/session/reap.ts';
import type { ExactTerminalReaper, RegisteredPaneObserver } from '../../../lib/session/reap-service.ts';
import type { DaemonStorage } from '../../storage/session-storage.ts';

function fields(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function startTicks(text: string): number | undefined {
  const close = text.lastIndexOf(')');
  if (close < 1) return undefined;
  const fields = text
    .slice(close + 1)
    .trim()
    .split(/\s+/u);
  if (fields.length < 20) return undefined;
  const value = Number(fields[19]);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

async function processStartTicks(pid: number): Promise<number | undefined> {
  try {
    return startTicks(await Bun.file(`/proc/${pid}/stat`).text());
  } catch {
    return undefined;
  }
}

function durableRegistration(text: string, daemonId: string, sessionId: string): RegisteredTerminalPane | undefined {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch (error) {
    throw new Error(`session ${sessionId} has an unreadable terminal pane registration`, { cause: error });
  }
  const value = fields(decoded);
  if (value === undefined || typeof value.daemonId !== 'string' || typeof value.sessionId !== 'string')
    throw new Error(`session ${sessionId} has a malformed terminal pane registration`);
  // A copied or foreign record is not authority for this daemon/directory. Preserve the reap
  // store's existing refusal semantics by ignoring it rather than treating it as a candidate.
  if (value.daemonId !== daemonId || value.sessionId !== sessionId) return undefined;
  if (
    typeof value.tmuxSession !== 'string' ||
    typeof value.paneId !== 'string' ||
    typeof value.pid !== 'number' ||
    typeof value.processStartTicks !== 'number'
  )
    throw new Error(`session ${sessionId} has an incomplete terminal pane registration`);
  const registration: RegisteredTerminalPane = {
    daemonId: value.daemonId,
    sessionId: value.sessionId,
    tmuxSession: value.tmuxSession,
    paneId: value.paneId,
    pid: value.pid,
    processStartTicks: value.processStartTicks,
  };
  if (!hasSafeTerminalPaneIdentity(registration))
    throw new Error(`session ${sessionId} has an invalid terminal pane registration`);
  return registration;
}

/** Writes an identity only after tmux has created the daemon-owned pane. */
export class DurableTerminalPaneRegistrar {
  constructor(
    private readonly daemonId: string,
    private readonly tmux: TmuxController,
    private readonly files: FileSystemPort,
    private readonly paths: FoundationPaths,
  ) {}

  async register(record: SessionLifecycleRecord): Promise<void> {
    await this.registerSession(record.config.id, record.config.tmuxSession);
  }

  /** Replaces the durable identity after a resume launches a new incarnation of the same pane. */
  async registerSession(sessionId: SessionId, tmuxSession: string): Promise<void> {
    const identity = await this.tmux.paneIdentity(tmuxSession);
    if (identity === undefined) throw new Error('tmux did not prove the launched pane identity');
    const ticks = await processStartTicks(identity.pid);
    if (ticks === undefined) throw new Error('the launched pane process has no stable incarnation identity');
    const registration: RegisteredTerminalPane = {
      daemonId: this.daemonId,
      sessionId,
      tmuxSession,
      paneId: identity.paneId,
      pid: identity.pid,
      processStartTicks: ticks,
    };
    await this.files.writeTextAtomic(
      createSessionPaths(this.paths, sessionId).terminalPane,
      `${JSON.stringify(registration)}\n`,
    );
  }
}

/** One registration that exists on disk and could not be read as one. */
export interface DamagedTerminalPaneRegistration {
  readonly sessionId: string;
  /** The refusal itself, so a caller reports the reason rather than inventing one. */
  readonly error: unknown;
}

/** Every registration this daemon owns, and every one it could not read. */
export interface TerminalPaneRegistrationScan {
  readonly registrations: readonly RegisteredTerminalPane[];
  readonly damaged: readonly DamagedTerminalPaneRegistration[];
}

/** Reads registrations only from each durable session directory, never from a tmux name listing. */
export class DurableTerminalPaneStore {
  constructor(
    private readonly storage: DaemonStorage,
    private readonly files: FileSystemPort,
    private readonly paths: FoundationPaths,
  ) {}

  /**
   * Every registration, with the unreadable ones NAMED rather than thrown or dropped.
   *
   * Two callers want opposite things from one damaged document and both are right. A reap that
   * cannot read the whole ledger must not sweep at all — it kills processes, and a partial view is
   * how it would kill the wrong one — so `registrations` still refuses. A settings surface that
   * reports resource limits must not go dark because one file was hand-edited; it wants the panes
   * it CAN prove plus a warning naming the ones it cannot. This is the one read both are composed
   * from, so the two can never come to disagree about what is on disk.
   */
  async scan(daemonId: string): Promise<TerminalPaneRegistrationScan> {
    const registrations: RegisteredTerminalPane[] = [];
    const damaged: DamagedTerminalPaneRegistration[] = [];
    for (const id of await this.storage.sessionIdsOnDisk()) {
      const text = await this.files.readText(createSessionPaths(this.paths, id).terminalPane);
      if (text === undefined) continue;
      try {
        const value = durableRegistration(text, daemonId, id);
        if (value !== undefined) registrations.push(value);
      } catch (error) {
        damaged.push({ sessionId: id, error });
      }
    }
    return { registrations, damaged };
  }

  /** The reap's view: a ledger with any damage in it is not a ledger a sweep may act on. */
  async registrations(daemonId: string): Promise<readonly RegisteredTerminalPane[]> {
    const scanned = await this.scan(daemonId);
    const damaged = scanned.damaged[0];
    if (damaged !== undefined) throw damaged.error;
    return scanned.registrations;
  }

  /**
   * The durable state of each session that has a registration.
   *
   * Read from the tolerant scan: a session whose registration cannot be read has no state to
   * contribute, and refusing the whole listing for it would take down the resource-limit surface
   * that reads this. The reap is unaffected — it asks for `registrations` in the same breath, and
   * that still refuses.
   */
  async sessions(daemonId: string): Promise<readonly DurableTerminalSession[]> {
    const values: DurableTerminalSession[] = [];
    for (const registration of (await this.scan(daemonId)).registrations) {
      const state = fields(await this.storage.readState(parseSessionId(registration.sessionId)));
      const status = state?.status;
      const finishedAt = state?.finishedAt;
      if (typeof status === 'string')
        values.push({
          daemonId,
          sessionId: registration.sessionId,
          status,
          ...(typeof finishedAt === 'string' ? { finishedAt } : {}),
        });
    }
    return values;
  }
}

export class ExactTmuxPaneReaper implements RegisteredPaneObserver, ExactTerminalReaper {
  constructor(private readonly tmux: TmuxController) {}
  async observe(registration: RegisteredTerminalPane): Promise<ObservedTerminalPane | undefined> {
    const identity = await this.tmux.paneIdentity(registration.tmuxSession);
    if (identity === undefined) return undefined;
    const ticks = await processStartTicks(identity.pid);
    return ticks === undefined
      ? undefined
      : { tmuxSession: registration.tmuxSession, paneId: identity.paneId, pid: identity.pid, processStartTicks: ticks };
  }
  async reap(target: TerminalReapTarget): Promise<void> {
    const observed = await this.observe(target);
    if (
      observed === undefined ||
      observed.paneId !== target.paneId ||
      observed.pid !== target.pid ||
      observed.processStartTicks !== target.processStartTicks
    )
      return;
    await this.tmux.killPaneExact(target.paneId);
  }
}
