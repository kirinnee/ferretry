import type { StoredRenderMeta } from '@ferretry/protocol';
import { KeyedSerialExecutor } from '../../src/adapters/system/keyed-serial-executor.ts';
import { RenderService, type RenderRepository } from '../../src/lib/renders/index.ts';

/** A render repository over memory: the service's rules are real, the disk is not. */
export class MemoryRenderRepository implements RenderRepository {
  readonly metas = new Map<string, StoredRenderMeta>();
  readonly payloads = new Map<string, string>();
  listings = 0;
  failListing = false;

  async listMetas(): Promise<readonly StoredRenderMeta[]> {
    this.listings += 1;
    if (this.failListing) throw new Error('the disk is unreadable');
    return [...this.metas.values()];
  }

  async readPayload(id: string): Promise<string | undefined> {
    return this.payloads.get(id);
  }

  async write(meta: StoredRenderMeta, payload: string): Promise<void> {
    this.payloads.set(meta.id, payload);
    this.metas.set(meta.id, meta);
  }
}

export const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>';
export const HTML = '<h1>Hello</h1><p>A page.</p>';

/** A service over memory whose clock advances one second per save, so "newer" is decidable. */
export function renderService(repository = new MemoryRenderRepository()): RenderService {
  let tick = 0;
  return new RenderService(
    repository,
    { now: () => new Date(Date.UTC(2026, 10, 5, 10, 0, tick++)).toISOString() },
    new KeyedSerialExecutor(),
  );
}
