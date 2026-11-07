import type { StateFileDef, StatePort } from '@ferretry/kernel/contract';
import { type AgentPin, AgentPinsDocumentSchema, type AgentPinRepository } from '../../lib/agent-pins/index.ts';

/** The body `agent-pins.json` holds; the kernel store stamps and checks its `format`. */
export type AgentPinFile = { readonly pins: readonly AgentPin[] };

/**
 * The owner's pinned ferrets in one small file, `state/ferrets/agent-pins.json`, written through the kernel store
 * (atomic, owner-only, like every state file). It holds ferret ids and instants, nothing else.
 *
 * Not `<ferret>/pins.json`: that is one ferret's NOTE board (`fy pin`), a different thing. The file definition is
 * handed in: it is the contract's to declare.
 */
export class StateAgentPinRepository implements AgentPinRepository {
  constructor(
    private readonly state: StatePort,
    private readonly file: StateFileDef<string, AgentPinFile>,
    /** After publication, reconcile archive membership before the pin operation returns. */
    private readonly retained?: (sessionId: string) => Promise<void>,
  ) {}

  async load(): Promise<readonly AgentPin[]> {
    const read = await this.state.read(this.file);
    // A damaged or foreign file is not the owner's pin list; starting empty is the honest answer.
    if (!read.ok || read.value === undefined) return [];
    const parsed = AgentPinsDocumentSchema.safeParse(read.value);
    return parsed.success ? parsed.data.pins : [];
  }

  async save(pins: readonly AgentPin[]): Promise<void> {
    await this.state.write(this.file, { pins });
    for (const pin of pins) await this.retain(pin.sessionId);
  }

  async retain(sessionId: string): Promise<void> {
    await this.retained?.(sessionId);
  }
}
