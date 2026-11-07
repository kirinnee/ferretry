import type { Instant } from '@ferretry/std';
import type { AgendaId, SharedDraftSlot, SharedDraftSnapshot } from '../../seams/protocol.ts';

/**
 * The draft as it was last written, or nothing when this session has never had one. A session holds a CHAT
 * draft (`slot` left out) and one draft per agenda item (the item's id): each is its own record.
 */
export interface SharedDraftRepository {
  load(sessionId: string, slot?: AgendaId): Promise<SharedDraftSnapshot | undefined>;
  save(snapshot: SharedDraftSnapshot): Promise<void>;
  /** Deletes one item's draft, if it has one. The chat draft is never deleted. */
  remove(sessionId: string, slot: AgendaId): Promise<void>;
  /** The items this session holds a stored draft for. */
  items(sessionId: string): Promise<readonly AgendaId[]>;
}

export interface SharedDraftSessionDirectory {
  has(sessionId: string): Promise<boolean>;
  /** Whether this item is on the session's board and still open: a closed or unknown item has no reply box. */
  hasOpenItem(sessionId: string, item: AgendaId): Promise<boolean>;
}

/** Which of a session's drafts, as the service's callers name it: the chat draft when no slot is given. */
export type SharedDraftSlotName = SharedDraftSlot | undefined;

export interface SharedDraftClock {
  now(): Instant;
}

/** The one timer the store uses, injected so a test drives time itself. */
export interface SharedDraftScheduler {
  after(milliseconds: number, action: () => void): { cancel(): void };
}

export type SharedDraftErrorCode =
  | 'not-found'
  | 'stale'
  | 'too-long'
  | 'too-many-items'
  | 'invalid'
  | 'rate-limited'
  | 'too-many-drafts';

export class SharedDraftError extends Error {
  constructor(
    readonly code: SharedDraftErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SharedDraftError';
  }
}

/** Mints the id a draft's generation carries: unique per load, so no two lives of a draft share one. */
export interface SharedDraftGenerationSource {
  next(): string;
}
