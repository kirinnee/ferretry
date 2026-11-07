import type { AgendaConversationEntry, AgendaId } from '../../lib/protocol/agenda.ts';
import type { AgendaVersion, AgendaVersionSummary } from '../../lib/protocol/agenda-versions.ts';
import { AgendaIdSchema } from '../../lib/protocol/agenda.ts';
import { isAgendaSessionId } from '../../lib/agenda/index.ts';
import type { AgendaVersionDraft, AgendaVersionStore } from '../../lib/agenda/versions.ts';
import { deepFreezeJson, type JsonValue } from '../../lib/json.ts';
import { bundledWorkerUrl } from '../runtime/bundled-worker.ts';
import { BundledWorkerHost, type HostedWorker } from '../runtime/bundled-worker-host.ts';
import { LoadSafeWorker } from '../runtime/load-safe-worker.ts';
import type { AgendaVersionsRequest, AgendaVersionsResponse, AgendaVersionsValue } from './agenda-versions-program.ts';

export interface AgendaVersionWorkerOptions {
  readonly spawn?: () => HostedWorker<AgendaVersionsRequest, AgendaVersionsResponse>;
  readonly timeoutMs?: number;
}

/**
 * Awaited archive IO on one lazy worker, never write-behind or a main-thread fallback.
 * The repository awaits record inside its session queue. Immutable fragment reads share one cached version;
 * switching versions releases it. A failed request rejects; a later request can start a fresh worker.
 */
export class FileAgendaVersionStore implements AgendaVersionStore {
  private readonly host: BundledWorkerHost<AgendaVersionsRequest, AgendaVersionsResponse, AgendaVersionsValue>;
  private cached:
    | { key: string; snapshot: AgendaVersion; conversation?: readonly AgendaConversationEntry[] }
    | undefined;

  constructor(
    private readonly sessionDirectory: (sessionId: string) => string,
    options: AgendaVersionWorkerOptions = {},
  ) {
    this.host = new BundledWorkerHost<AgendaVersionsRequest, AgendaVersionsResponse, AgendaVersionsValue>({
      label: 'the agenda version archive',
      spawn: options.spawn ?? (() => new LoadSafeWorker(bundledWorkerUrl('agenda-versions'), { type: 'module' })),
      answer: message =>
        'probe' in message
          ? undefined
          : message.ok
            ? { id: message.id, ok: true, value: message.value }
            : { id: message.id, ok: false, error: new Error(message.error) },
      timeoutMs: options.timeoutMs ?? 5 * 60_000,
      idleMs: () => 60_000,
    });
  }

  private directory(sessionId: string, item?: AgendaId): string {
    if (!isAgendaSessionId(sessionId)) throw new Error(`not a valid agenda session id: ${sessionId}`);
    if (item !== undefined && !AgendaIdSchema.safeParse(item).success)
      throw new Error(`not a valid agenda id: ${item}`);
    return this.sessionDirectory(sessionId);
  }

  async record(sessionId: string, drafts: readonly AgendaVersionDraft[]): Promise<void> {
    const directory = this.directory(sessionId);
    for (const draft of drafts) this.directory(sessionId, draft.entry.item.id);
    const id = this.host.nextId();
    await this.host.request(id, { id, kind: 'record', directory, sessionId, drafts }, 'commit agenda versions');
  }

  async discard(sessionId: string, drafts: readonly AgendaVersionDraft[]): Promise<void> {
    const directory = this.directory(sessionId);
    for (const draft of drafts) this.directory(sessionId, draft.entry.item.id);
    this.cached = undefined;
    const id = this.host.nextId();
    await this.host.request(id, { id, kind: 'discard', directory, sessionId, drafts }, 'discard agenda versions');
  }

  async list(sessionId: string, item: AgendaId): Promise<readonly AgendaVersionSummary[]> {
    const directory = this.directory(sessionId, item);
    const id = this.host.nextId();
    return (await this.host.request(
      id,
      { id, kind: 'list', directory, sessionId, item },
      'list agenda versions',
    )) as readonly AgendaVersionSummary[];
  }

  async get(sessionId: string, item: AgendaId, version: number): Promise<AgendaVersion | undefined> {
    const directory = this.directory(sessionId, item);
    const key = `${directory}/${item}:${version}`;
    if (this.cached?.key === key) return this.cached.snapshot;
    const id = this.host.nextId();
    const snapshot = (await this.host.request(
      id,
      { id, kind: 'get', directory, sessionId, item, version },
      'read an agenda version',
    )) as AgendaVersion | undefined;
    if (snapshot === undefined) return undefined;
    deepFreezeJson(snapshot as unknown as JsonValue);
    this.cached = { key, snapshot };
    return snapshot;
  }

  async conversation(
    sessionId: string,
    item: AgendaId,
    version: number,
  ): Promise<readonly AgendaConversationEntry[] | undefined> {
    const directory = this.directory(sessionId, item);
    const key = `${directory}/${item}:${version}`;
    if (this.cached?.key === key && this.cached.conversation !== undefined) return this.cached.conversation;
    if ((await this.get(sessionId, item, version)) === undefined) return undefined;
    const id = this.host.nextId();
    const conversation = (await this.host.request(
      id,
      { id, kind: 'conversation', directory, sessionId, item, version },
      'read historical agenda words',
    )) as readonly AgendaConversationEntry[];
    deepFreezeJson(conversation as unknown as JsonValue);
    if (this.cached?.key === key) this.cached.conversation = conversation;
    return conversation;
  }

  close(): void {
    this.host.close();
    this.cached = undefined;
  }
}
