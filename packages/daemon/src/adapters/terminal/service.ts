import { isAbsolute, resolve } from 'node:path';
import type { SurfaceOpener, TerminalListView, TerminalSize, TerminalView } from '@ferretry/protocol';
import type {
  TerminalClock,
  TerminalIdSource,
  TerminalRecord,
  TerminalRuntimePort,
  TerminalSession,
  TerminalSessionResolver,
} from '../../lib/terminal/contracts.ts';
import {
  DEFAULT_TERMINAL_SIZE,
  idleDeadline,
  nextTerminalTitle,
  normalizeTerminalSize,
  normalizeTerminalTitle,
} from '../../lib/terminal/policy.ts';
import type { TerminalCapture } from '../../lib/terminal/redraw.ts';

export class TerminalServiceError extends Error {
  constructor(
    readonly code: 'not_found' | 'capacity' | 'bad_request' | 'conflict',
    message: string,
  ) {
    super(message);
    this.name = 'TerminalServiceError';
  }
}

export interface TerminalServiceOptions {
  readonly maximumPerSession?: number;
  readonly maximumGlobal?: number;
  readonly idleTimeoutMs?: number;
  /**
   * Whether a folder exists, for a terminal opened somewhere other than the session's own folder.
   * tmux silently starts a shell in the daemon's own directory when asked for one that does not
   * exist, so the folder is checked here rather than trusted. Without it, such a request is refused.
   */
  readonly isDirectory?: (path: string) => Promise<boolean>;
}

function key(ownerId: string, terminalId: string): string {
  return `${ownerId}\n${terminalId}`;
}

/** Stateful lifecycle adapter; terminal process and session authority are injected ports. */
export class ManagedTerminalService {
  private readonly records = new Map<string, TerminalRecord>();
  private creating: Promise<unknown> = Promise.resolve();
  private readonly maximumPerSession: number;
  private readonly maximumGlobal: number;
  private readonly idleTimeoutMs: number;
  private readonly isDirectory: ((path: string) => Promise<boolean>) | undefined;

  constructor(
    private readonly runtime: TerminalRuntimePort,
    private readonly sessions: TerminalSessionResolver,
    private readonly clock: TerminalClock,
    private readonly ids: TerminalIdSource,
    options: TerminalServiceOptions = {},
  ) {
    this.maximumPerSession = options.maximumPerSession ?? 6;
    this.maximumGlobal = options.maximumGlobal ?? 24;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 60 * 60_000;
    this.isDirectory = options.isDirectory;
  }

  private async session(reference: string): Promise<TerminalSession> {
    const session = await this.sessions.resolve(reference);
    if (!session || !session.cwd.startsWith('/'))
      throw new TerminalServiceError('not_found', 'terminal session not found');
    return session;
  }

  private async refresh(): Promise<void> {
    const records = await this.runtime.list();
    this.records.clear();
    for (const record of records) this.records.set(key(record.ownerId, record.id), record);
  }

  private view(record: TerminalRecord): TerminalView {
    return {
      id: record.id,
      sessionId: record.ownerId,
      title: record.title,
      state: 'running',
      cols: record.cols,
      rows: record.rows,
      viewers: 0,
      // Spread rather than assigned: `openedBy: undefined` is a present key with
      // no value, and the wire's "unrecorded" is an ABSENT key.
      ...(record.openedBy === undefined ? {} : { openedBy: record.openedBy }),
      ...(record.name === undefined ? {} : { name: record.name }),
      createdAt: new Date(record.createdAtMs).toISOString(),
      lastActivityAt: new Date(record.lastActivityAtMs).toISOString(),
      idleDeadline: new Date(idleDeadline(record.lastActivityAtMs, 0, this.idleTimeoutMs) ?? 0).toISOString(),
    };
  }

  private async record(sessionReference: string, terminalId: string): Promise<TerminalRecord> {
    const session = await this.session(sessionReference);
    await this.refresh();
    const record = this.records.get(key(session.id, terminalId));
    if (!record) throw new TerminalServiceError('not_found', 'terminal not found');
    return record;
  }

  /**
   * The record a live stream's write or capture acts on, WITHOUT re-listing tmux when it is known.
   *
   * `record` lists every tmux session before it answers, which is right for a route a person calls
   * once and wrong for a stream that calls it on every keystroke and every poll: it was a whole extra
   * `tmux` process in front of each echo. A terminal this service closed is gone from the map and
   * falls through to `record`, which refreshes and refuses it — so a stream still cannot outlive the
   * lifecycle — and one that died behind the service's back fails its tmux command instead, which ends
   * the stream the same way. The session is still resolved every time: that is where a deleted session
   * stops its terminals.
   */
  private async liveRecord(sessionReference: string, terminalId: string): Promise<TerminalRecord> {
    const session = await this.session(sessionReference);
    return this.records.get(key(session.id, terminalId)) ?? (await this.record(sessionReference, terminalId));
  }

  async list(sessionReference: string): Promise<TerminalListView> {
    const session = await this.session(sessionReference);
    await this.refresh();
    const terminals = [...this.records.values()]
      .filter(record => record.ownerId === session.id)
      .toSorted((left, right) => left.createdAtMs - right.createdAtMs)
      .map(record => this.view(record));
    return {
      sessionId: session.id,
      terminals,
      limits: {
        perSession: this.maximumPerSession,
        global: this.maximumGlobal,
        runningGlobal: this.records.size,
        idleTimeoutSeconds: Math.round(this.idleTimeoutMs / 1_000),
        scrollbackLines: 5_000,
      },
    };
  }

  async create(
    sessionReference: string,
    input: {
      readonly title?: unknown;
      readonly cols?: number;
      readonly rows?: number;
      /**
       * Already DERIVED by the caller from the credential that authenticated the
       * request — this service never sees a request body, so it cannot decide
       * ownership itself and must not appear to. Absent means the caller could
       * attest nothing.
       */
      readonly openedBy?: SurfaceOpener;
      /** Unique within the session; the protocol's `SurfaceNameSchema` already checked its shape. */
      readonly name?: string;
      /** Where the shell starts: absolute, or relative to the session's own folder. */
      readonly folder?: string;
    } = {},
  ): Promise<TerminalView> {
    // ONE CREATE AT A TIME. The name and capacity checks below read the listing and then await the
    // runtime, so two opens racing for one name would both pass and leave two `dev` terminals.
    const turn = this.creating.then(async () => await this.createNow(sessionReference, input));
    this.creating = turn.catch(() => undefined);
    return await turn;
  }

  private async createNow(
    sessionReference: string,
    input: Parameters<ManagedTerminalService['create']>[1] & object,
  ): Promise<TerminalView> {
    const session = await this.session(sessionReference);
    await this.refresh();
    const owned = [...this.records.values()].filter(record => record.ownerId === session.id);
    if (input.name !== undefined && owned.some(record => record.name === input.name))
      throw new TerminalServiceError('conflict', `this session already has a terminal named ${input.name}`);
    const cwd = await this.folder(session.cwd, input.folder);
    if (owned.length >= this.maximumPerSession)
      throw new TerminalServiceError('capacity', 'terminal capacity reached for this session');
    if (this.records.size >= this.maximumGlobal)
      throw new TerminalServiceError('capacity', 'global terminal capacity reached');
    const size = normalizeTerminalSize(
      input.cols ?? DEFAULT_TERMINAL_SIZE.cols,
      input.rows ?? DEFAULT_TERMINAL_SIZE.rows,
    );
    const title =
      input.title === undefined
        ? nextTerminalTitle(
            owned.map(record => record.title),
            this.maximumPerSession,
          )
        : normalizeTerminalTitle(input.title);
    const record = await this.runtime.create({
      ownerId: session.id,
      id: this.ids.next(),
      title,
      cwd,
      size,
      ...(input.openedBy === undefined ? {} : { openedBy: input.openedBy }),
      ...(input.name === undefined ? {} : { name: input.name }),
    });
    this.records.set(key(record.ownerId, record.id), record);
    return this.view(record);
  }

  /** The folder a new shell starts in, proved to exist. */
  private async folder(sessionCwd: string, folder: string | undefined): Promise<string> {
    if (folder === undefined) return sessionCwd;
    const path = isAbsolute(folder) ? resolve(folder) : resolve(sessionCwd, folder);
    if (this.isDirectory === undefined || !(await this.isDirectory(path)))
      throw new TerminalServiceError('bad_request', `there is no folder ${path} to open a terminal in`);
    return path;
  }

  async get(sessionReference: string, terminalId: string): Promise<TerminalView> {
    return this.view(await this.record(sessionReference, terminalId));
  }

  async rename(sessionReference: string, terminalId: string, title: unknown): Promise<TerminalView> {
    const record = await this.record(sessionReference, terminalId);
    const normalized = normalizeTerminalTitle(title);
    await this.runtime.rename(record, normalized);
    const updated = { ...record, title: normalized };
    this.records.set(key(updated.ownerId, updated.id), updated);
    return this.view(updated);
  }

  async resize(sessionReference: string, terminalId: string, cols: number, rows: number): Promise<TerminalSize> {
    const record = await this.record(sessionReference, terminalId);
    const size = normalizeTerminalSize(cols, rows);
    await this.runtime.resize(record, size);
    this.records.set(key(record.ownerId, record.id), { ...record, ...size, lastActivityAtMs: this.clock.now() });
    return size;
  }

  async write(sessionReference: string, terminalId: string, bytes: Uint8Array): Promise<void> {
    const record = await this.liveRecord(sessionReference, terminalId);
    await this.runtime.write(record, bytes);
    this.records.set(key(record.ownerId, record.id), { ...record, lastActivityAtMs: this.clock.now() });
  }

  async capture(sessionReference: string, terminalId: string, historyLines: number): Promise<TerminalCapture> {
    return await this.runtime.capture(await this.liveRecord(sessionReference, terminalId), historyLines);
  }

  async text(sessionReference: string, terminalId: string, lines: number): Promise<string> {
    return await this.runtime.text(await this.record(sessionReference, terminalId), lines);
  }

  async foreground(sessionReference: string, terminalId: string): Promise<string> {
    return await this.runtime.foreground(await this.record(sessionReference, terminalId));
  }

  async close(sessionReference: string, terminalId: string): Promise<void> {
    const record = await this.record(sessionReference, terminalId);
    await this.runtime.kill(record);
    this.records.delete(key(record.ownerId, record.id));
  }
}
