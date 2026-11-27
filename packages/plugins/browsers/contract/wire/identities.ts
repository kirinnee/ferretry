import { InstantSchema } from '@ferretry/std';
import { z } from 'zod';
import { BrowserEngineSchema, BrowserIdentityKeySchema } from '../wire.ts';

/**
 * The proxy an identity's browser goes through, by NAME only: the host and port the owner wrote. A proxy's credentials
 * are `${secret:NAME}` references the daemon never reads for Browsers, and no part of one is on this wire.
 */
export const BrowserIdentityProxySchema = z.strictObject({
  /** `host:port` of the proxy, never its sign-in. */
  name: z.string().min(1).max(300),
  /** The identity names its own proxy (`true`), or goes through the machine's (`false`). */
  own: z.boolean(),
});
export type BrowserIdentityProxy = z.infer<typeof BrowserIdentityProxySchema>;

/** One identity as the daemon knows it: the built-in `agent` and every key `browsers.yaml` names under `identities:`. */
export const BrowserIdentityRowSchema = z.strictObject({
  identity: BrowserIdentityKeySchema,
  /** The built-in identity (`agent`): it needs no entry in the file and cannot be removed. */
  builtIn: z.boolean(),
  engine: BrowserEngineSchema,
  /** Whether this identity's Chrome runs (or is being started) right now. */
  running: z.boolean(),
  startedAt: InstantSchema.optional(),
  /** When its profile folder last changed, `undefined` for an identity that has never opened a browser. */
  lastUsedAt: InstantSchema.optional(),
  proxy: BrowserIdentityProxySchema.optional(),
});
export type BrowserIdentityRow = z.infer<typeof BrowserIdentityRowSchema>;

/** `GET /v1/browser/identities`: the real identities, running or not, in the order they are written (`agent` first). */
export const BrowserIdentitiesViewSchema = z.strictObject({
  identities: z.array(BrowserIdentityRowSchema),
  /** How many may run at once. */
  maxRunning: z.number().int().min(1),
});
export type BrowserIdentitiesView = z.infer<typeof BrowserIdentitiesViewSchema>;
