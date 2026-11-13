/**
 * READING THE FERRET LIST: `GET /v1/ferrets` through the half's own client, every element parsed with the contract's own
 * schema (parse, don't validate). The route is declared conditional, so where the client offers `conditional` a re-read
 * sends the etag it holds and a `304` keeps the rows it already has.
 */

import { z } from 'zod';
import { type FerretSummary, FerretSummarySchema } from '../../../contract/index.ts';
import type { LiveFerretsClient } from '../../lib/client.ts';

const LIST_ROUTE = 'GET /v1/ferrets';

/** What one element that does not parse costs: the whole read, in these words. */
export const UNREADABLE_LIST = 'the daemon answered the ferret list with something this page cannot read';

const FerretListSchema = z.array(FerretSummarySchema);

/** A read of the list, and the etag that names it when the daemon sent one. */
export interface FerretListRead {
  readonly ferrets: readonly FerretSummary[];
  readonly etag?: string;
}

const parse = (body: unknown): readonly FerretSummary[] => {
  const parsed = FerretListSchema.safeParse(body);
  if (!parsed.success) throw new Error(UNREADABLE_LIST);
  return parsed.data;
};

/** One read of the list. `held` is the read the caller already has: a `304` answers with it unchanged. */
export const readFerretList = async (
  client: Pick<LiveFerretsClient, 'call' | 'conditional'>,
  held?: FerretListRead,
): Promise<FerretListRead> => {
  if (client.conditional === undefined) return { ferrets: parse(await client.call<unknown>(LIST_ROUTE)) };
  const answer = await client.conditional(LIST_ROUTE, {}, held?.etag === undefined ? {} : { ifNoneMatch: held.etag });
  if (answer.status === 304 && held !== undefined) return held;
  if (answer.status === 304) throw new Error(UNREADABLE_LIST);
  return { ferrets: parse(answer.body), ...(answer.etag === undefined ? {} : { etag: answer.etag }) };
};
