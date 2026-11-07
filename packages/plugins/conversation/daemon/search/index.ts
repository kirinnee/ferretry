import type { Redaction } from '@ferretry/kernel/contract';
import type { AsksApi } from '@ferretry/core-asks/contract';
import { asksSource } from './adapters/asks-source.ts';
import { workRedaction } from './adapters/redaction.ts';
import type { WorkSource } from './lib/service.ts';
import { WorkSearchService } from './lib/service.ts';
import { relatedRoute, searchRoute, searchWorkTool } from './routes.ts';

export * from './lib/index.ts';
export { asksSource } from './adapters/asks-source.ts';

/** How long after start the work search builds its index: after the boot's own reads, before anyone searches. */
export const WORK_SEARCH_WARM_DELAY_MS = 5_000;

export interface SearchNeeds {
  readonly asks: Pick<AsksApi, 'open'>;
  readonly redaction: Redaction;
  /** More sources of work (the board's cards): handed over by whoever holds them. */
  readonly sources?: readonly WorkSource[];
  readonly now: () => number;
  readonly warn: (message: string) => void;
}

/** The work search: the service, its two routes and the `search_work` tool. Inert until a request or `warm()`. */
export function buildSearch(needs: SearchNeeds) {
  const redaction = workRedaction(needs.redaction);
  const service = new WorkSearchService({
    sources: [asksSource(needs.asks), ...(needs.sources ?? [])],
    redaction,
    now: needs.now,
    warn: needs.warn,
  });
  return {
    service,
    redaction,
    routes: { 'GET /v1/search': searchRoute(service), 'POST /v1/search/related': relatedRoute(service) },
    tools: { search_work: searchWorkTool(service) },
  } as const;
}
