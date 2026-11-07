/**
 * v4 login files (4.291.5). A LOCAL copy on purpose: the product has no v4 reader.
 *
 * - `fleet/credentials/<login>/` (`packages/fleet/src/lib/account/credential-directory.ts`): a `store: ferretry`
 *   login's sign-in, written by the harness itself (Claude `.credentials.json` via `CLAUDE_SECURESTORAGE_CONFIG_DIR`,
 *   Codex `auth.json`, Claude's `.claude.json` account file). SECRET: listed and moved, never opened. A `store: host`
 *   login has no sign-in here (it stays in the person's own `~/.claude` / `~/.codex` / keychain), only `usage.json`.
 * - `fleet/credentials/<login>/usage.json`: the last passive rate-limit reading, Usage's cache, not a sign-in.
 * - `state/model-catalog.json` (`packages/daemon/src/adapters/models/file-model-catalog-cache.ts`, path from
 *   `packages/daemon/bin/modules/models.ts:91`): the published model catalog last taken, no format marker, read
 *   leniently by `heldFrom` (`packages/daemon/src/lib/models/published.ts`).
 */
import { z } from 'zod';

export const V4_CREDENTIALS = 'fleet/credentials';
export const V4_PASSIVE_USAGE = 'usage.json';
export const V4_MODEL_CATALOG = 'state/model-catalog.json';

/** `packages/fleet/src/lib/account/schema.ts` `NAME_GRAMMAR` (a credential id; max 64). Mixed case is allowed. */
export const V4LoginId = z
  .string()
  .max(64)
  .regex(/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/u);

/** What `heldFrom` keeps: each field only when it has its type. `last` (the last check's outcome) is not carried. */
export const V4ModelCatalog = z.object({
  version: z.number().optional().catch(undefined),
  document: z.unknown(),
  fetchedAt: z.string().optional().catch(undefined),
  checkedAt: z.string().optional().catch(undefined),
});
