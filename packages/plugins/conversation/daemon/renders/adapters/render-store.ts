import type { StatePort } from '@ferretry/kernel/contract';
import type { StoredRenderMeta } from '../../../contract/index.ts';
import type { RenderRepository } from '../lib/types.ts';
import { isRenderId, RENDER_META_STATE, RENDER_PAYLOAD_STATE } from './state.ts';

/**
 * Two records per render, in `state/conversation/renders/`: the payload, then the meta that points at it, each written
 * atomically by the state port, so a crash leaves at worst a payload nothing points at (today's `FileRenderRepository`).
 *
 * The id is checked against the id grammar before it becomes a name, so no caller-supplied string can name a file
 * outside the folder. A meta that does not parse, or that sits under another id's name, is skipped: it is not a
 * render, and serving it would serve whatever somebody planted there.
 */
export class StateRenderRepository implements RenderRepository {
  constructor(private readonly state: Pick<StatePort, 'read' | 'write' | 'list'>) {}

  async listMetas(): Promise<readonly StoredRenderMeta[]> {
    const found: StoredRenderMeta[] = [];
    for (const id of await this.state.list(RENDER_META_STATE)) {
      if (!isRenderId(id)) continue;
      const read = await this.state.read(RENDER_META_STATE, id);
      if (read.ok && read.value !== undefined && read.value.id === id) found.push(read.value);
    }
    return found;
  }

  async readPayload(id: string): Promise<string | undefined> {
    this.#checked(id);
    const read = await this.state.read(RENDER_PAYLOAD_STATE, id);
    if (!read.ok || read.value === undefined) return undefined;
    const stored: unknown = read.value;
    return typeof stored === 'string' ? stored : new TextDecoder().decode(stored as Uint8Array);
  }

  async write(meta: StoredRenderMeta, payload: string): Promise<void> {
    this.#checked(meta.id);
    await this.state.write(RENDER_PAYLOAD_STATE, new TextEncoder().encode(payload) as never, meta.id);
    await this.state.write(RENDER_META_STATE, meta, meta.id);
  }

  #checked(id: string): void {
    if (!isRenderId(id)) throw new Error(`not a render id: ${id}`);
  }
}
