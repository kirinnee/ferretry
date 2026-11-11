import type { StateFileDef, StatePort } from '@ferretry/kernel/contract';
import { type AgentPin, AgentPinsDocumentSchema, type AgentPinRepository } from '../../lib/agent-pins/index.ts';

/** The body `agent-pins.json` holds; the kernel store stamps and checks its `format`. */
export type AgentPinFile = { readonly pins: readonly AgentPin[] };

/**
 * The owner's pinned ferrets in one small file, `state/ferrets/agent-pins.json`, written through the kernel store
 * (atomic, owner-only, like every state file). It holds ferret ids and instants, nothing else.
 *
 * THE PARSED LIST IS KEPT against the file's identity (`StatePort.version`: one lstat, no read). Every ferret read
 * asks for the pins, and a board walk made ~7,000 of those in one burst (a read, a parse and two zod passes each,
 * ~190 ms of blocked event loop); now a burst of reads costs one lstat each and ONE read, and concurrent loads share it.
 * A save drops the copy, and a file that changed behind the daemon's back is a new identity, read again.
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

  /** The pins as last read, with the identity of the file they came from; held as a promise so a burst shares one read. */
  private kept: { readonly etag: string; readonly pins: Promise<readonly AgentPin[]> } | undefined;

  async load(): Promise<readonly AgentPin[]> {
    const version = await this.state.version(this.file);
    if (version === undefined) {
      this.kept = undefined;
      return [];
    }
    if (this.kept?.etag !== version.etag) {
      // The identity was taken BEFORE the read: a file that moves in between is read newer than its etag, and the
      // next load sees a different etag and reads again, so a stale list is never kept.
      const pins = this.read();
      const kept = { etag: version.etag, pins };
      this.kept = kept;
      pins.catch(() => {
        if (this.kept === kept) this.kept = undefined;
      });
    }
    return await (this.kept?.pins ?? this.read());
  }

  private async read(): Promise<readonly AgentPin[]> {
    const read = await this.state.read(this.file);
    // A damaged or foreign file is not the owner's pin list; starting empty is the honest answer.
    if (!read.ok || read.value === undefined) return [];
    const parsed = AgentPinsDocumentSchema.safeParse(read.value);
    return parsed.success ? parsed.data.pins : [];
  }

  async save(pins: readonly AgentPin[]): Promise<void> {
    this.kept = undefined;
    await this.state.write(this.file, { pins });
    this.kept = undefined;
    for (const pin of pins) await this.retain(pin.sessionId);
  }

  async retain(sessionId: string): Promise<void> {
    await this.retained?.(sessionId);
  }
}
