import type { TerminalListView, TerminalSize, TerminalView } from '@ferretry/protocol';
import {
  DEFAULT_TERMINAL_SIZE,
  idleDeadline,
  nextTerminalTitle,
  normalizeTerminalSize,
  normalizeTerminalTitle,
} from '../../lib/terminal/policy.ts';
import type {
  TerminalClock,
  TerminalIdSource,
  TerminalRecord,
  TerminalRuntimePort,
  TerminalSession,
  TerminalSessionResolver,
} from '../../lib/terminal/contracts.ts';

export class TerminalServiceError extends Error {
  constructor(
    readonly code: 'not_found' | 'capacity' | 'bad_request',
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
}

function key(ownerId: string, terminalId: string): string {
  return `${ownerId}\n${terminalId}`;
}

/** Stateful lifecycle adapter; terminal process and session authority are injected ports. */
export class ManagedTerminalService {
  private readonly records = new Map<string, TerminalRecord>();
  private readonly maximumPerSession: number;
  private readonly maximumGlobal: number;
  private readonly idleTimeoutMs: number;

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
    input: { readonly title?: unknown; readonly cols?: number; readonly rows?: number } = {},
  ): Promise<TerminalView> {
    const session = await this.session(sessionReference);
    await this.refresh();
    const owned = [...this.records.values()].filter(record => record.ownerId === session.id);
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
      cwd: session.cwd,
      size,
    });
    this.records.set(key(record.ownerId, record.id), record);
    return this.view(record);
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
    const record = await this.record(sessionReference, terminalId);
    await this.runtime.write(record, bytes);
    this.records.set(key(record.ownerId, record.id), { ...record, lastActivityAtMs: this.clock.now() });
  }

  async capture(sessionReference: string, terminalId: string): Promise<Uint8Array> {
    return await this.runtime.capture(await this.record(sessionReference, terminalId));
  }

  async close(sessionReference: string, terminalId: string): Promise<void> {
    const record = await this.record(sessionReference, terminalId);
    await this.runtime.kill(record);
    this.records.delete(key(record.ownerId, record.id));
  }
}
