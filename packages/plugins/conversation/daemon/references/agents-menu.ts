import type { FerretsApi, FerretSummary } from '@ferretry/core-ferrets/contract';
import { cap } from '@ferretry/core-gate/contract';
import {
  type ReferenceCatalogEntry,
  type ReferenceCatalogInput,
  type ReferenceCatalogProvider,
  referenceCatalogLimit,
} from '../../contract/index.ts';

/** How a row says where the ferret stands: the lifecycle word, and that a stopped one said it was done. */
const standing = (ferret: FerretSummary): string =>
  ferret.state === 'stopped' && ferret.finishedAt !== undefined ? 'finished' : ferret.state;

/**
 * THE `:` MENU OF A FERRET'S COMPOSER (reference.catalog, lead decision Q6): the ferrets on this daemon, by callsign, as
 * the reference grammar spells an agent (`:name`, docs/reference-standard.md — one grammar, not a second).
 *
 * The token is the callsign; the label is the ferret's task title (empty when it has none); the detail is its
 * lifecycle state. A stopped ferret is listed `closed` (known, not on offer: the composer shows live ferrets first and
 * a finished one after, with its badge). Newest first, as the owner listed them. A query narrows by the callsign or the
 * title, case ignored.
 *
 * DEMAND: `fleet` use — what `GET /v1/ferrets` declares, so a caller that could not list the fleet through that route
 * is refused before `entries` runs. Only callsigns, titles and a lifecycle word leave: never a folder, a login, a
 * token, a handle, a conversation id or any transcript text. The answer is masked by Conversation's route.
 */
export class AgentsReferenceMenu implements ReferenceCatalogProvider {
  readonly demand = cap('fleet', 'use');

  constructor(private readonly ferrets: Pick<FerretsApi, 'list'>) {}

  async entries(input: ReferenceCatalogInput): Promise<readonly ReferenceCatalogEntry[]> {
    const wanted = input.query?.trim().toLowerCase() ?? '';
    return [...(await this.ferrets.list())]
      .filter(ferret => wanted === '' || `${ferret.name} ${ferret.title ?? ''}`.toLowerCase().includes(wanted))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .slice(0, referenceCatalogLimit(':'))
      .map(ferret => ({
        // A name is at most 64 characters and a title 120 (Ferrets' own schemas), inside the entry's bounds: nothing is cut.
        token: ferret.name,
        label: ferret.title ?? '',
        detail: standing(ferret),
        ...(ferret.state === 'stopped' ? { closed: true } : {}),
      }));
  }
}
