/**
 * THE SAVED PICTURE — the wire contract of the daemon's render store (docs/renders.md).
 *
 * A ferret saves an `svg` or `html` picture as a file the daemon keeps and cites it with a short token,
 * `%svg:7k2m9q`, instead of pasting the source into the conversation. Only these two kinds are stored;
 * every other `fy-render` type stays an inline fence. This module is the one place the id grammar, the
 * quotas, the token spelling and the request/response shapes are written, so the daemon that serves
 * them and the CLI and app that speak them cannot disagree.
 *
 * The CONTENT rules (is this a valid svg, is this html within its cap) are not here: they are the
 * `fy-render` grammar core (`./fy-render.ts`) and are applied by `./render-save.ts`.
 */
import { z } from 'zod';
import { FY_RENDER_LIMITS } from './fy-render-caps.ts';
import { InstantSchema, NonNegativeIntegerSchema } from './common.ts';

/** The only kinds the store keeps (owner decision !A377). Every other `fy-render` type stays inline. */
export const RENDER_KINDS = ['svg', 'html'] as const;
export type RenderKind = (typeof RENDER_KINDS)[number];
export const RenderKindSchema = z.enum(RENDER_KINDS);

/**
 * An id is lowercase Crockford base32 of the content digest: the digits and the letters but `i`, `l`, `o` and `u`,
 * which are the ones read as other characters. Six characters to start; the daemon
 * lengthens it by two at a time when a shorter one is already taken by DIFFERENT content, up to the
 * 52 characters that spell the whole digest. It is unique, not secret: it grants no access.
 */
export const RENDER_ID_MIN_LENGTH = 6;
export const RENDER_ID_MAX_LENGTH = 52;
export const RENDER_ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
export const RenderIdSchema = z
  .string()
  .regex(/^[0-9a-hjkmnp-tv-z]{6,52}$/u, 'a render id is 6 to 52 lowercase base32 characters (no i, l, o or u)');
export type RenderId = z.infer<typeof RenderIdSchema>;

/** The token a render is cited with: `%svg:7k2m9q`. */
export const renderToken = (kind: RenderKind, id: RenderId): string => `%${kind}:${id}`;

/**
 * The quotas, refused with the one that was hit named. Guesses to tune, not doctrine.
 * The "host" bucket is a save made with no ferret session behind it (the owner's `fy` at the machine).
 */
export const RENDER_QUOTAS = {
  perSessionCount: 2000,
  perSessionBytes: 64 * 1024 * 1024,
  machineCount: 20_000,
  machineBytes: 1024 * 1024 * 1024,
} as const;

/** The author bucket of a save made with no session behind it. */
export const RENDER_HOST_AUTHOR = 'host' as const;

/** The payload cap of each kind, read from the one owner of the `fy-render` numbers. */
export const RENDER_PAYLOAD_BYTES: Readonly<Record<RenderKind, number>> = {
  svg: FY_RENDER_LIMITS.svgBytes,
  html: FY_RENDER_LIMITS.htmlBytes,
};

/**
 * The most a save request body may weigh: the largest payload with JSON's worst escaping (six bytes for
 * one control character) and room for the envelope. The transport bounds the read with it before a byte of
 * the payload is held.
 */
export const RENDER_MAX_BODY_BYTES = FY_RENDER_LIMITS.htmlBytes * 6 + 16 * 1024;

/** What `POST /v1/renders` takes. */
export const RenderSaveRequestSchema = z
  .object({
    kind: RenderKindSchema,
    alt: z.string(),
    payload: z.string(),
    /** The older render this one replaces. The old one stays as it was; it is told apart as "has a newer version". */
    supersedes: RenderIdSchema.optional(),
  })
  .strict();
export type RenderSaveRequest = z.infer<typeof RenderSaveRequestSchema>;

/**
 * A render's record as it is kept on disk and answered by `GET /v1/renders/:id/meta`.
 *
 * `sha256` is the digest of kind, alt and payload (docs/renders.md § Ids): the id's source, and what a
 * read checks the stored bytes against. `author.sessionId` is the ferret session that saved it, absent for a
 * save at the machine. `supersedes` is the link the saver asked for, written once at creation.
 */
export const StoredRenderMetaSchema = z.object({
  v: z.literal(1),
  id: RenderIdSchema,
  kind: RenderKindSchema,
  alt: z.string(),
  bytes: NonNegativeIntegerSchema,
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  createdAt: InstantSchema,
  author: z.object({ sessionId: z.string().min(1).optional() }).strict(),
  supersedes: RenderIdSchema.optional(),
});
export type StoredRenderMeta = z.infer<typeof StoredRenderMetaSchema>;

/** The wire meta: the stored record plus the newest render that replaced this one, derived and never stored. */
export const RenderMetaSchema = StoredRenderMetaSchema.extend({ supersededBy: RenderIdSchema.optional() });
export type RenderMeta = z.infer<typeof RenderMetaSchema>;

/** What `POST /v1/renders` answers. `created: false` means this exact content was already saved. */
export const RenderSaveResponseSchema = z.object({
  id: RenderIdSchema,
  token: z.string(),
  created: z.boolean(),
  meta: RenderMetaSchema,
});
export type RenderSaveResponse = z.infer<typeof RenderSaveResponseSchema>;

/**
 * What `GET /v1/renders/:id` answers: always JSON, never the payload as a document. Its meta is the STORED
 * record, with no `supersededBy`: the answer is cached as immutable, and "a newer version exists" changes.
 */
export const RenderBodySchema = z.object({ meta: StoredRenderMetaSchema, payload: z.string() });
export type RenderBody = z.infer<typeof RenderBodySchema>;
