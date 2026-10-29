import type { ProcessIncarnation } from '@ferretry/protocol';
import { processIncarnationFor } from '@ferretry/protocol/process-incarnation';
import {
  createSessionPaths,
  type FileSystemPort,
  type FoundationPaths,
  harnessExitReason,
  hasSafeTerminalPaneIdentity,
  type PaneIdentity,
  parseSessionId,
  resolveSessionTarget,
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
    private readonly incarnation: ProcessIncarnation = processIncarnationFor(),
  ) {}

  async register(record: SessionLifecycleRecord): Promise<void> {
    await this.registerSession(record.config.id, record.config.tmuxSession);
  }

  /** Replaces the durable identity after a resume launches a new incarnation of the same pane. */
  async registerSession(sessionId: SessionId, tmuxSession: string): Promise<void> {
    const identity = await this.tmux.paneIdentity(tmuxSession);
    if (identity === undefined) throw await this.refusal(tmuxSession, 'tmux did not prove the launched pane identity');
    const ticks = await this.incarnation.startOf(identity.pid);
    if (ticks === undefined)
      throw await this.refusal(tmuxSession, 'the launched pane process has no stable incarnation identity');
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

  /**
   * Why a pane could not be registered, when the identity read is only the symptom.
   *
   * Almost always the harness having already exited. tmux keeps a dead pane on screen, but what it
   * still answers about one differs by release: tmux 3.8 (macOS Homebrew) prints an EMPTY `#{pane_pid}`
   * once it has reaped the process, so the pane id arrives with no pid at all; older releases keep the
   * pid, and then the process start it names cannot be read. Either way the reason a reader can act on
   * is the exit and what the process printed, so the pane is asked once more and its death outranks the
   * identity read. `unproven` stands only for a pane that is still alive.
   */
  private async refusal(tmuxSession: string, unproven: string): Promise<Error> {
    const pane = await this.tmux.state(tmuxSession);
    return new Error(!pane.alive || pane.dead ? harnessExitReason(pane) : unproven);
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
  /**
   * Registration texts by path, with the identity of the file each came from.
   *
   * The reaper scans every session's registration twice a sweep, every five seconds, and on a mostly
   * finished fleet almost none of them changes between sweeps — or exists at all. A scan therefore
   * asks each path for its identity (one `stat`), skips one that names nothing, and reads only a file
   * that is not the one it read last time. {@link registration} never uses this: it must prove what is
   * on disk at the moment of a write.
   */
  private readonly texts = new Map<string, { readonly identity: string; readonly text: string }>();
  /**
   * The scan in flight, shared by every caller that asks while it runs. A sweep asks for the
   * registrations and the sessions in the same breath, and each used to survey every session directory
   * on its own — two identical walks of the whole state home every five seconds.
   */
  private inFlight: { readonly daemonId: string; readonly scan: Promise<TerminalPaneRegistrationScan> } | undefined;

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
    if (this.inFlight?.daemonId === daemonId) return await this.inFlight.scan;
    const scan = this.scanOnce(daemonId);
    const shared = { daemonId, scan };
    this.inFlight = shared;
    try {
      return await scan;
    } finally {
      if (this.inFlight === shared) this.inFlight = undefined;
    }
  }

  private async scanOnce(daemonId: string): Promise<TerminalPaneRegistrationScan> {
    return await this.scanSessions(daemonId, await this.storage.sessionIdsOnDisk());
  }

  /**
   * The same tolerant scan over sessions a caller has already found on disk, for one that walked the
   * session directories for its own reasons and would otherwise pay for a second walk here.
   */
  async scanSessions(daemonId: string, sessionIds: readonly SessionId[]): Promise<TerminalPaneRegistrationScan> {
    const registrations: RegisteredTerminalPane[] = [];
    const damaged: DamagedTerminalPaneRegistration[] = [];
    for (const id of sessionIds) {
      const text = await this.scanned(createSessionPaths(this.paths, id).terminalPane);
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

  /** A registration's text for a scan: from {@link texts} while the file is the one read last. */
  private async scanned(path: string): Promise<string | undefined> {
    const { identity, readTextIdentified } = this.files;
    if (identity === undefined || readTextIdentified === undefined) return await this.files.readText(path);
    const now = await identity.call(this.files, path);
    const cached = this.texts.get(path);
    if (now !== undefined && cached?.identity === now) return cached.text;
    this.texts.delete(path);
    if (now === undefined) return undefined;
    const read = await readTextIdentified.call(this.files, path);
    if (read !== undefined) this.texts.set(path, read);
    return read?.text;
  }

  /**
   * One session's registration, re-read on its own.
   *
   * For a caller that already holds a registration from a scan and must prove, at the moment it
   * writes, that nothing replaced it since — a resume re-registers before it reports `running`.
   * A damaged document throws, as it does for the reap: it proves nothing either way.
   */
  async registration(daemonId: string, sessionId: SessionId): Promise<RegisteredTerminalPane | undefined> {
    const text = await this.files.readText(createSessionPaths(this.paths, sessionId).terminalPane);
    return text === undefined ? undefined : durableRegistration(text, daemonId, sessionId);
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

/**
 * Observes registered panes and kills one only when it still is exactly the registered incarnation.
 *
 * ONE LISTING PER SWEEP. A sweep asks about all of its registrations at once, and each used to be its
 * own `display-message`; they now share a single `list-panes -a` read for the moment they were asked.
 * The listing never finds a target — every lookup is BY a registration's own session name, resolved the
 * way `-t <session>` resolves it — so no unregistered pane can become a candidate through it. It is
 * dropped as soon as it settles, which is what keeps the kill's re-check a fresh look rather than the
 * sweep's.
 */
export class ExactTmuxPaneReaper implements RegisteredPaneObserver, ExactTerminalReaper {
  private listing: Promise<ReadonlyMap<string, PaneIdentity> | undefined> | undefined;

  constructor(
    private readonly tmux: TmuxController,
    private readonly incarnation: ProcessIncarnation = processIncarnationFor(),
  ) {}

  async observe(registration: RegisteredTerminalPane): Promise<ObservedTerminalPane | undefined> {
    const identity = await this.identity(registration.tmuxSession);
    if (identity === undefined) return undefined;
    const ticks = await this.incarnation.startOf(identity.pid);
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

  /** The pane `-t <session>` names, from the shared listing — or asked on its own when tmux will not list. */
  private async identity(tmuxSession: string): Promise<PaneIdentity | undefined> {
    this.listing ??= this.tmux.paneIdentities().finally(() => {
      this.listing = undefined;
    });
    const table = await this.listing;
    if (table === undefined) return await this.tmux.paneIdentity(tmuxSession);
    const name = resolveSessionTarget(tmuxSession, table.keys());
    return name === undefined ? undefined : table.get(name);
  }
}
