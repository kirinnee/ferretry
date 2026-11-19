import { defineState } from '@ferretry/kernel/contract';
import { z } from 'zod';

/**
 * `state/pulls/cache/<projectId>/<accountId>-<hash>.json`: one GitHub answer per file (`0600`, in `0700` folders). It
 * holds PRIVATE CODE (diffs), so it is bounded and deleted with the project or the account it belongs to.
 */
export const PULLS_CACHE = defineState({ name: 'cache', path: 'cache/*', store: 'opaque', format: 1 });

/** What the cache keeps for one project, oldest out first. */
export const MAX_CACHE_BYTES_PER_PROJECT = 32 * 1024 * 1024;
/** One answer larger than this is served but not kept. */
export const MAX_CACHE_ENTRY_BYTES = 8 * 1024 * 1024;

/** One cached answer: what a later `If-None-Match` needs and what a `304` serves. The token is never part of it. */
export const CacheEntrySchema = z.strictObject({
  format: z.literal(1),
  /** The request path and query it answers, checked on read (a file name is only a hash). */
  path: z.string().min(1).max(1200),
  etag: z.string().min(1).max(300),
  /** The `Link` header of the answer: paging needs it again when a `304` carries none. */
  link: z.string().max(2000).optional(),
  storedAt: z.iso.datetime(),
  body: z.unknown(),
});
export type CacheEntry = z.infer<typeof CacheEntrySchema>;
