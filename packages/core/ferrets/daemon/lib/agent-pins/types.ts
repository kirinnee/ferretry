import { type AgentPin } from '../../../contract/pins.ts';

/** The stored shapes (one pin, the `agent-pins.json` body) are the contract's; the daemon's readers use them as before. */
export { type AgentPin, AgentPinsDocumentSchema } from '../../../contract/pins.ts';

/** The most ferrets one owner can keep pinned on a machine; a pin list is a shortcut, not a second roster. */
export const MAX_AGENT_PINS = 50;

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
