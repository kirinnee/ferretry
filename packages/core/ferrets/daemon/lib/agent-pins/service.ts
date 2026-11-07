import type { SerialExecutor } from '../ports.ts';
import { type AgentPin, type AgentPinClock, AgentPinError, type AgentPinRepository, MAX_AGENT_PINS } from './types.ts';

/** Pin order: the one pinned first stays first; an equal instant falls back to the id so the order is total. */
export const byPinOrder = (left: AgentPin, right: AgentPin): number =>
  left.pinnedAt === right.pinnedAt
    ? left.sessionId.localeCompare(right.sessionId)
    : left.pinnedAt < right.pinnedAt
      ? -1
      : 1;

const QUEUE = 'agent-pins';

/**
 * The owner's pinned ferrets on this machine.
 *
 * It holds no state of its own: every call reads the list and every change writes it back through one
 * queue, so two devices pinning at once both land. The caller names canonical session ids (the route
 * resolves a reference first), and a pin whose session has since been removed is simply never read back
 * as one — the reader only ever asks about sessions that exist.
 */
export class AgentPinService {
  constructor(
    private readonly repository: AgentPinRepository,
    private readonly clock: AgentPinClock,
    private readonly executor: SerialExecutor,
  ) {}

  /** Session id → the instant it was pinned. */
  async pinnedAt(): Promise<ReadonlyMap<string, string>> {
    return new Map((await this.repository.load()).map(pin => [pin.sessionId, pin.pinnedAt]));
  }

  /** Pins a ferret. Pinning a pinned one keeps its place and its instant. */
  async pin(sessionId: string): Promise<string> {
    return await this.executor.run(QUEUE, async () => {
      const pins = await this.repository.load();
      const known = pins.find(pin => pin.sessionId === sessionId);
      if (known !== undefined) {
        await this.repository.retain?.(sessionId);
        return known.pinnedAt;
      }
      if (pins.length >= MAX_AGENT_PINS)
        throw new AgentPinError('full', `${MAX_AGENT_PINS} ferrets are already pinned; unpin one first`);
      const pinnedAt = this.clock.now();
      await this.repository.save([...pins, { sessionId, pinnedAt }].sort(byPinOrder));
      return pinnedAt;
    });
  }

  /** Unpins a ferret. Unpinning one that is not pinned changes nothing. */
  async unpin(sessionId: string): Promise<void> {
    await this.executor.run(QUEUE, async () => {
      const pins = await this.repository.load();
      if (!pins.some(pin => pin.sessionId === sessionId)) return;
      await this.repository.save(pins.filter(pin => pin.sessionId !== sessionId));
    });
  }
}
