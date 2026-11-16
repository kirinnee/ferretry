import type { StateFileDef, StatePort } from '@ferretry/kernel/contract';
import { ok } from '@ferretry/std';

/**
 * The few things a rotated queue asks of a state port, with an append that costs the same however long the file is.
 *
 * The kernel's in-memory file system copies a whole file on every append, which is nothing for a file of a few hundred
 * lines and minutes for the 200,000 appends a test of a rotating log makes. This keeps lines in an array, so the test
 * measures the store and not the fake. What it must do as the real port does is proved against the real port in the
 * other tests of the store; this one only has to be a faithful enough file.
 */
export class LightState {
  readonly logs = new Map<string, string[]>();
  readonly documents = new Map<string, string>();
  private readonly revisions = new Map<string, number>();

  private key(file: StateFileDef, name?: string): string {
    return name === undefined ? file.path : file.path.replace('*', name);
  }

  private touch(key: string): void {
    this.revisions.set(key, (this.revisions.get(key) ?? 0) + 1);
  }

  port(): StatePort {
    return {
      append: async (file: StateFileDef, entry: unknown, name?: string) => {
        const key = this.key(file, name);
        this.logs.set(key, [...(this.logs.get(key) ?? []), JSON.stringify({ format: 1, ...(entry as object) })]);
        this.touch(key);
      },
      lines: async function* (this: LightState, file: StateFileDef, name?: string) {
        for (const line of this.logs.get(this.key(file, name)) ?? []) {
          const { format: _format, ...rest } = JSON.parse(line) as Record<string, unknown>;
          yield rest;
        }
      }.bind(this),
      version: async (file: StateFileDef, name?: string) => {
        const key = this.key(file, name);
        const lines = this.logs.get(key);
        return lines === undefined && !this.documents.has(key)
          ? undefined
          : { size: lines?.length ?? 0, etag: `${this.revisions.get(key) ?? 0}` };
      },
      write: async (file: StateFileDef, value: unknown, name?: string) => {
        const key = this.key(file, name);
        if (file.store === 'jsonl')
          this.logs.set(
            key,
            (value as object[]).map(record => JSON.stringify({ format: 1, ...record })),
          );
        else this.documents.set(key, JSON.stringify({ format: 1, ...(value as object) }));
        this.touch(key);
      },
      read: async (file: StateFileDef, name?: string) => {
        const text = this.documents.get(this.key(file, name));
        if (text === undefined) return ok(undefined);
        const { format: _format, ...rest } = JSON.parse(text) as Record<string, unknown>;
        return ok(rest);
      },
      list: async (file: StateFileDef) => {
        const [prefix, suffix] = file.path.split('*') as [string, string];
        return [...this.documents.keys()]
          .filter(key => key.startsWith(prefix) && key.endsWith(suffix))
          .map(key => key.slice(prefix.length, key.length - suffix.length));
      },
      remove: async (file: StateFileDef, name?: string) => {
        const key = this.key(file, name);
        this.documents.delete(key);
        this.logs.delete(key);
        this.touch(key);
      },
    } as unknown as StatePort;
  }
}
