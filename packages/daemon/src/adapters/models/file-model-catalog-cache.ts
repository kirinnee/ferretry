import type { ModelCatalogCachePort } from '../../lib/index.ts';

/** The two calls this cache makes on the state home's confined filesystem. */
export interface ModelCatalogCacheFiles {
  readText(path: string): Promise<string | undefined>;
  writeTextAtomic(path: string, text: string): Promise<void>;
}

/**
 * The published model catalog this machine last took (docs/model-catalog.md), in one document inside the
 * state home, so a restart — or a machine that is offline — starts from it rather than from the build's
 * own catalog. Labels, model ids and tiers; nothing secret. A document that is missing or not JSON reads
 * as `undefined`: the worst a damaged one can do is make the next check download the catalog again.
 */
export class FileModelCatalogCache implements ModelCatalogCachePort {
  constructor(
    private readonly files: ModelCatalogCacheFiles,
    private readonly path: string,
  ) {}

  async read(): Promise<unknown> {
    const raw = await this.files.readText(this.path).catch(() => undefined);
    if (raw === undefined || raw.trim() === '') return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      return undefined;
    }
  }

  async write(document: unknown): Promise<void> {
    await this.files.writeTextAtomic(this.path, `${JSON.stringify(document)}\n`);
  }
}
