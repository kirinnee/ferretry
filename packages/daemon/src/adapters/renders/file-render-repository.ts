import { join } from 'node:path';
import { RenderIdSchema, type StoredRenderMeta, StoredRenderMetaSchema } from '@ferretry/protocol';
import type { FileSystemPort, FoundationPaths } from '../../lib/index.ts';
import type { RenderRepository } from '../../lib/renders/index.ts';

/** The directory the store lives in: `state/renders/`, in the state home beside the sessions, not under one of them. */
export const rendersDirectory = (paths: FoundationPaths): string => join(paths.state, 'renders');

const SHARD_LENGTH = 2;

/**
 * Two files per render under `state/renders/<first two characters of the id>/`: `<id>.payload`, the payload
 * text exactly as saved, and `<id>.json`, its meta. The payload is written first and the meta second, each
 * atomically and owner-only, so a crash leaves at worst a payload nothing points at.
 *
 * The id is checked against the id grammar before it becomes a path, so no caller-supplied string can
 * name a file outside the directory. A meta that does not parse, or that sits under another id's name, is
 * skipped: it is not a render, and serving it would serve whatever somebody planted there.
 */
export class FileRenderRepository implements RenderRepository {
  constructor(
    private readonly paths: FoundationPaths,
    private readonly files: FileSystemPort,
  ) {}

  async listMetas(): Promise<readonly StoredRenderMeta[]> {
    const root = rendersDirectory(this.paths);
    const found: StoredRenderMeta[] = [];
    for (const shard of await this.files.listDirectory(root)) {
      if (!shard.directory) continue;
      for (const entry of await this.files.listDirectory(join(root, shard.name))) {
        if (entry.regularFile !== true || !entry.name.endsWith('.json')) continue;
        const id = entry.name.slice(0, -'.json'.length);
        const meta = await this.#readMeta(id, shard.name);
        if (meta !== undefined) found.push(meta);
      }
    }
    return found;
  }

  async readPayload(id: string): Promise<string | undefined> {
    return await this.files.readText(this.#file(id, 'payload'));
  }

  async write(meta: StoredRenderMeta, payload: string): Promise<void> {
    await this.files.writeTextAtomic(this.#file(meta.id, 'payload'), payload);
    await this.files.writeTextAtomic(this.#file(meta.id, 'json'), JSON.stringify(meta));
  }

  async #readMeta(id: string, shard: string): Promise<StoredRenderMeta | undefined> {
    if (!RenderIdSchema.safeParse(id).success || id.slice(0, SHARD_LENGTH) !== shard) return undefined;
    const text = await this.files.readText(this.#file(id, 'json'));
    if (text === undefined) return undefined;
    try {
      const parsed = StoredRenderMetaSchema.safeParse(JSON.parse(text));
      return parsed.success && parsed.data.id === id ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  }

  #file(id: string, extension: 'json' | 'payload'): string {
    if (!RenderIdSchema.safeParse(id).success) throw new Error(`not a render id: ${id}`);
    return join(rendersDirectory(this.paths), id.slice(0, SHARD_LENGTH), `${id}.${extension}`);
  }
}
