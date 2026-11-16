import type { StateDocument } from '../../../../daemon/adapters/state-document.ts';

/**
 * One state document in memory, as the kernel hands it to a store: the text as written, parsed on read (a damaged text
 * throws, as the kernel's damage does), and a copy kept beside it when it is set aside.
 */
export class MemoryDocument implements StateDocument {
  text: string | undefined;
  readonly asides = new Map<string, string>();

  constructor(text?: string) {
    this.text = text;
  }

  async read(): Promise<unknown> {
    return this.text === undefined ? undefined : (JSON.parse(this.text) as unknown);
  }

  async write(body: unknown): Promise<void> {
    this.text = JSON.stringify(body);
  }

  async setAside(suffix: string): Promise<void> {
    if (this.text !== undefined) this.asides.set(suffix, this.text);
  }
}
