import type { StatePort } from '@ferretry/kernel/contract';
import type { Instant } from '@ferretry/std';
import { LOGINS_MODELS } from '../../../contract/index.ts';
import type { ModelCatalogCachePort } from '../../lib/models/published.ts';

/**
 * The published model catalog this machine last took (docs/model-catalog.md), in `state/logins/models.json`, so a
 * restart — or a machine that is offline — starts from it rather than from the build's own catalog. Labels, model
 * ids and tiers; nothing secret. A document that is damaged reads as `undefined`: the worst it can do is make the
 * next check download the catalog again. The `local` slice of the same file (the models Ollama reported) is left as
 * it is.
 */
export class StateModelCatalogCache implements ModelCatalogCachePort {
  constructor(private readonly state: Pick<StatePort, 'read' | 'update'>) {}

  async read(): Promise<unknown> {
    const read = await this.state.read(LOGINS_MODELS).catch(() => undefined);
    if (read === undefined || !read.ok || read.value?.published === undefined) return undefined;
    const published = read.value.published;
    return {
      version: published.version,
      document: published.catalog,
      fetchedAt: published.fetchedAt,
      checkedAt: published.checkedAt,
    };
  }

  async write(document: unknown): Promise<void> {
    const held = document as {
      readonly version?: number;
      readonly document?: unknown;
      readonly fetchedAt?: string;
      readonly checkedAt?: string;
    };
    if (held.version === undefined || held.fetchedAt === undefined || held.checkedAt === undefined) return;
    const published = {
      version: held.version,
      fetchedAt: held.fetchedAt as Instant,
      checkedAt: held.checkedAt as Instant,
      catalog: held.document,
    };
    await this.state.update(LOGINS_MODELS, current => ({ ...(current ?? { format: 1 as const }), published }));
  }
}
