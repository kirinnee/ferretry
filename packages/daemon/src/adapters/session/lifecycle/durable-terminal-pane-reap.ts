import type { ExactTerminalReaper, RegisteredPaneObserver } from '../../../lib/session/reap-service.ts';
import type {
  DurableTerminalSession,
  ObservedTerminalPane,
  RegisteredTerminalPane,
  TerminalReapTarget,
} from '../../../lib/session/reap.ts';
import {
  createSessionPaths,
  type FileSystemPort,
  type FoundationPaths,
  parseSessionId,
  type SessionLifecycleRecord,
  TmuxController,
} from '../../../lib/index.ts';
import type { DaemonStorage } from '../../storage/session-storage.ts';

function fields(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function startTicks(text: string): number | undefined {
  const close = text.lastIndexOf(')');
  const value = Number(
    text
      .slice(close + 1)
      .trim()
      .split(/\s+/u)[19],
  );
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

async function processStartTicks(pid: number): Promise<number | undefined> {
  try {
    return startTicks(await Bun.file(`/proc/${pid}/stat`).text());
  } catch {
    return undefined;
  }
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
    const identity = await this.tmux.paneIdentity(record.config.tmuxSession);
    if (identity === undefined) throw new Error('tmux did not prove the launched pane identity');
    const ticks = await processStartTicks(identity.pid);
    if (ticks === undefined) throw new Error('the launched pane process has no stable incarnation identity');
    const registration: RegisteredTerminalPane = {
      daemonId: this.daemonId,
      sessionId: record.config.id,
      tmuxSession: record.config.tmuxSession,
      paneId: identity.paneId,
      pid: identity.pid,
      processStartTicks: ticks,
    };
    await this.files.writeTextAtomic(
      createSessionPaths(this.paths, record.config.id).terminalPane,
      `${JSON.stringify(registration)}\n`,
    );
  }
}

/** Reads registrations only from each durable session directory, never from a tmux name listing. */
export class DurableTerminalPaneStore {
  constructor(
    private readonly storage: DaemonStorage,
    private readonly files: FileSystemPort,
    private readonly paths: FoundationPaths,
  ) {}

  async registrations(daemonId: string): Promise<readonly RegisteredTerminalPane[]> {
    const values: RegisteredTerminalPane[] = [];
    for (const id of await this.storage.sessionIdsOnDisk()) {
      const text = await this.files.readText(createSessionPaths(this.paths, id).terminalPane);
      if (text === undefined) continue;
      try {
        const value = JSON.parse(text) as RegisteredTerminalPane;
        if (value.daemonId === daemonId && value.sessionId === id) values.push(value);
      } catch {}
    }
    return values;
  }

  async sessions(daemonId: string): Promise<readonly DurableTerminalSession[]> {
    const values: DurableTerminalSession[] = [];
    for (const registration of await this.registrations(daemonId)) {
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
