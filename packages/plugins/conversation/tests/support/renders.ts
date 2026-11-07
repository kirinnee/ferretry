import type { Instant } from '@ferretry/std';
import type { StoredRenderMeta } from '../../contract/index.ts';

import { RenderService, serialExecutor, type RenderRepository } from '../../daemon/renders/lib/index.ts';

/** A render repository over memory: the service's rules are real, the disk is not. */
export class MemoryRenderRepository implements RenderRepository {
  readonly metas = new Map<string, StoredRenderMeta>();
  readonly payloads = new Map<string, string>();
  listings = 0;
  failListing = false;
  failRead = false;
  failWrite = false;
  /** A write that commits the render and then rejects, as a failure after the atomic rename would. */
  failAfterWrite = false;
  #gate: Promise<void> | undefined;

  /** Holds every `write` open until the returned function is called, so a test can keep saves in flight. */
  hold(): () => void {
    let release = (): void => undefined;
    this.#gate = new Promise<void>(resolve => {
      release = resolve;
    });
    return release;
  }

  async listMetas(): Promise<readonly StoredRenderMeta[]> {
    this.listings += 1;
    if (this.failListing) throw new Error('the disk is unreadable');
    return [...this.metas.values()];
  }

  async readPayload(id: string): Promise<string | undefined> {
    if (this.failRead) throw new Error('the payload file is unreadable: /secret/path');
    return this.payloads.get(id);
  }

  async write(meta: StoredRenderMeta, payload: string): Promise<void> {
    await this.#gate;
    if (this.failWrite) throw new Error('the disk is full: /secret/path');
    this.payloads.set(meta.id, payload);
    this.metas.set(meta.id, meta);
    if (this.failAfterWrite) throw new Error('the directory could not be synced: /secret/path');
  }
}

export const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';
export const HTML = '<h1>Hello</h1><p>A page.</p>';

/** A service over memory whose clock advances one second per save, so "newer" is decidable. */
export function renderService(repository = new MemoryRenderRepository()): RenderService {
  let tick = 0;
  return new RenderService(
    repository,
    { now: () => new Date(Date.UTC(2026, 10, 5, 10, 0, tick++)).toISOString() as Instant },
    serialExecutor(),
  );
}
