import { InstantSchema } from '@ferretry/protocol';
import { z } from 'zod';

/** The most ferrets one owner can keep pinned on a machine; a pin list is a shortcut, not a second roster. */
export const MAX_AGENT_PINS = 50;

/** One pinned ferret: its id and the moment it was pinned, which is also its place in the list. */
export const AgentPinSchema = z.strictObject({
  sessionId: z.string().min(1),
  pinnedAt: InstantSchema,
});
export type AgentPin = z.infer<typeof AgentPinSchema>;

/** The file the pins live in. Versioned so a later shape can be told from this one. */
export const AgentPinFileSchema = z.strictObject({
  version: z.literal(1),
  pins: z.array(AgentPinSchema),
});

/** Where the owner's pins are kept; the daemon of the machine that owns the ferret holds them. */
export interface AgentPinRepository {
  /** Every stored pin; none when nothing is stored or what is stored is unreadable. */
  load(): Promise<readonly AgentPin[]>;
  save(pins: readonly AgentPin[]): Promise<void>;
  /** Retry live membership restoration for an already published pin, without rewriting its place or instant. */
  retain?(sessionId: string): Promise<void>;
}

export interface AgentPinClock {
  now(): string;
}

export type AgentPinErrorCode = 'full' | 'not-found';

export class AgentPinError extends Error {
  constructor(
    readonly code: AgentPinErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AgentPinError';
  }
}
