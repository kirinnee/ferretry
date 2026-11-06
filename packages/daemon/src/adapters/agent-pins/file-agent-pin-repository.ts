import { join } from 'node:path';
import { type AgentPin, AgentPinFileSchema, type AgentPinRepository } from '../../lib/agent-pins/index.ts';
import type { FileSystemPort, FoundationPaths } from '../../lib/index.ts';

/**
 * The owner's pinned ferrets in one small file, `state/agent-pins.json`, written atomically and
 * owner-only like every state file. It holds session ids and instants, nothing else.
 *
 * Not `state/pins/`: that is the session NOTE board (`fy pin`), a different thing.
 */
export function agentPinsFile(paths: FoundationPaths): string {
  return join(paths.state, 'agent-pins.json');
}

export class FileAgentPinRepository implements AgentPinRepository {
  constructor(
    private readonly paths: FoundationPaths,
    private readonly files: FileSystemPort,
    /** After publication, reconcile archive membership before the pin operation returns. */
    private readonly retained?: (sessionId: string) => Promise<void>,
  ) {}

  async load(): Promise<readonly AgentPin[]> {
    const text = await this.files.readText(agentPinsFile(this.paths));
    if (text === undefined) return [];
    try {
      const result = AgentPinFileSchema.safeParse(JSON.parse(text));
      // A damaged or foreign file is not the owner's pin list; starting empty is the honest answer.
      return result.success ? result.data.pins : [];
    } catch {
      return [];
    }
  }

  async save(pins: readonly AgentPin[]): Promise<void> {
    await this.files.writeTextAtomic(agentPinsFile(this.paths), JSON.stringify({ version: 1, pins }));
    for (const pin of pins) await this.retain(pin.sessionId);
  }

  async retain(sessionId: string): Promise<void> {
    await this.retained?.(sessionId);
  }
}
