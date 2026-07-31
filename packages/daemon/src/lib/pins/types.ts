import type { Pin, PinBlockKind, PinBy, PinSnapshot } from '@ferretry/protocol';

export const MAX_AGENT_PINS_PER_SESSION = 10;

export type { Pin, PinBlockKind, PinBy, PinSnapshot };

export interface PinActor {
  readonly sessionId?: string | null;
  readonly name?: string | null;
}

export type PinProvenance =
  | { readonly by: 'human'; readonly createdBy: null; readonly createdByName: null; readonly sessionId: null }
  | {
      readonly by: 'agent';
      readonly createdBy: string;
      readonly createdByName: string | null;
      readonly sessionId: string;
    };

export interface PinClock {
  now(): string;
}

export interface PinIdGenerator {
  next(): string;
}

export interface PinSessionDirectory {
  has(sessionId: string): Promise<boolean>;
}

export interface PinRepository {
  snapshot(sessionId: string): Promise<PinSnapshot>;
  mutate(sessionId: string, transform: (current: readonly Pin[]) => readonly Pin[]): Promise<PinSnapshot>;
}

export type PinErrorCode = 'invalid' | 'too-long' | 'not-found' | 'forbidden';

export class PinError extends Error {
  constructor(
    readonly code: PinErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PinError';
  }
}

export interface AddNotePin {
  readonly kind: 'note';
  readonly text: unknown;
  readonly source?: { readonly blockId: string } | null;
}

export interface AddMessagePin {
  readonly kind: 'message';
  readonly blockId: unknown;
  readonly blockKind: unknown;
  readonly preview: unknown;
  readonly ts?: unknown;
}

export type AddPin = AddNotePin | AddMessagePin;
