import type { MaskSource } from '../../../contract/index.ts';

/**
 * The last successful snapshot survives an unavailable or throwing hook provider. Only masking
 * holds this source; nothing that resolves a named secret receives it. Reads are serialized so an
 * older in-flight read cannot replace a newer snapshot. Maps are copied before being retained.
 * Only an undeclared source is absent. A declared source must first prove its values, even if empty.
 */
export class RetainedMaskSource implements MaskSource {
  #last: ReadonlyMap<string, string> | undefined;
  #pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly provider: () => MaskSource | 'unavailable' | 'absent') {}

  values(): Promise<ReadonlyMap<string, string>> {
    const read = this.#pending.then(async () => {
      try {
        const source = this.provider();
        if (source === 'absent') return new Map(this.#last);
        if (source !== 'unavailable') this.#last = new Map(await source.values());
      } catch {
        // Never expose a provider error: it may quote one of the values it was trying to open.
      }
      if (this.#last === undefined) throw new Error('mask source unavailable before its first successful read');
      return new Map(this.#last);
    });
    this.#pending = read.catch(() => undefined);
    return read;
  }
}
