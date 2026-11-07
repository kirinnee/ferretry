import type { StateFileDef, StatePort } from '@ferretry/kernel/contract';
import { DRAFTS_STATE as DRAFTS_FILE } from '../../../contract/index.ts';

/** The drafts file is opaque bytes to the state port. */
const DRAFTS_STATE = DRAFTS_FILE as unknown as StateFileDef<string, Uint8Array>;
import {
  type AgendaId,
  AgendaIdSchema,
  type SharedDraftSnapshot,
  SharedDraftSnapshotSchema,
} from '../../seams/protocol.ts';
import type { SerialExecutor } from '../../seams/ports.ts';
import type { SharedDraftRepository } from '../lib/index.ts';

/** One ferret's drafts, the chat box and one reply per open agenda item, kept as one document in its state folder. */
interface DraftsDocument {
  chat?: SharedDraftSnapshot;
  items: Record<string, SharedDraftSnapshot>;
}

/**
 * The shared draft's repository on the ferret's own state file. Each ferret's drafts are one document, written
 * whole (the state port replaces it atomically); a lane per ferret serializes the read-modify-write. A document
 * that does not read back as drafts of this ferret is no draft: the composer starts empty, and nothing else breaks.
 */
export class StateDraftRepository implements SharedDraftRepository {
  constructor(
    private readonly state: StatePort,
    private readonly executor: SerialExecutor,
  ) {}

  async load(sessionId: string, slot?: AgendaId): Promise<SharedDraftSnapshot | undefined> {
    const document = await this.#read(sessionId);
    const snapshot = slot === undefined ? document.chat : document.items[slot];
    return snapshot !== undefined && snapshot.ferret === sessionId && snapshot.slot === slot ? snapshot : undefined;
  }

  async save(snapshot: SharedDraftSnapshot): Promise<void> {
    await this.executor.run(snapshot.ferret, async () => {
      const document = await this.#read(snapshot.ferret);
      if (snapshot.slot === undefined) document.chat = snapshot;
      else document.items[snapshot.slot] = snapshot;
      await this.#write(snapshot.ferret, document);
    });
  }

  async remove(sessionId: string, slot: AgendaId): Promise<void> {
    await this.executor.run(sessionId, async () => {
      const document = await this.#read(sessionId);
      delete document.items[slot];
      await this.#write(sessionId, document);
    });
  }

  async items(sessionId: string): Promise<readonly AgendaId[]> {
    const document = await this.#read(sessionId);
    return Object.keys(document.items).flatMap(key => {
      const id = AgendaIdSchema.safeParse(key);
      return id.success ? [id.data] : [];
    });
  }

  async #read(ferret: string): Promise<DraftsDocument> {
    const read = await this.state.read<Uint8Array>(DRAFTS_STATE, ferret);
    const bytes = read.ok ? read.value : undefined;
    const document: DraftsDocument = { items: {} };
    if (bytes === undefined) return document;
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return document;
    }
    if (typeof value !== 'object' || value === null) return document;
    const stored = value as { chat?: unknown; items?: unknown };
    const chat = SharedDraftSnapshotSchema.safeParse(stored.chat);
    if (chat.success) document.chat = chat.data;
    if (typeof stored.items === 'object' && stored.items !== null)
      for (const [key, raw] of Object.entries(stored.items)) {
        const item = SharedDraftSnapshotSchema.safeParse(raw);
        if (item.success) document.items[key] = item.data;
      }
    return document;
  }

  async #write(ferret: string, document: DraftsDocument): Promise<void> {
    await this.state.write<Uint8Array>(DRAFTS_STATE, new TextEncoder().encode(JSON.stringify(document)), ferret);
  }
}
