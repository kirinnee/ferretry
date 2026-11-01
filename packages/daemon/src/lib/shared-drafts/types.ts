import type { SharedDraftSnapshot } from '@ferretry/protocol';

/** The draft as it was last written, or nothing when this session has never had one. */
export interface SharedDraftRepository {
  load(sessionId: string): Promise<SharedDraftSnapshot | undefined>;
  save(snapshot: SharedDraftSnapshot): Promise<void>;
}

export interface SharedDraftSessionDirectory {
  has(sessionId: string): Promise<boolean>;
}

export interface SharedDraftClock {
  now(): string;
}

/** The one timer the store uses, injected so a test drives time itself. */
export interface SharedDraftScheduler {
  after(milliseconds: number, action: () => void): { cancel(): void };
}

export type SharedDraftErrorCode = 'not-found' | 'stale' | 'too-long' | 'too-many-items' | 'invalid';

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
