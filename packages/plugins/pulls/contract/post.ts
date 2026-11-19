/**
 * What the post routes take and answer (r9 E7: a comment posted to GitHub AS THE PERSON). Added beside E1's shapes
 * (`## Contract change` in E7's PR); every object is strict, bounded and carries no token. A body is the person's own
 * text going out, never GitHub's text coming in.
 */
import { z } from 'zod';
import { DIFF_SIDES, MAX_TEXT } from './wire.ts';

/** GitHub's own cap on a comment, in characters. A longer body is refused before any request is made. */
export const MAX_POST_BODY = MAX_TEXT;

/** Why a post did not go out. A closed list: each one is ours, none carries GitHub's text. */
export const POST_CODES = {
  /** The body looks like a credential and the person has not said "post anyway". */
  secretShaped: 'pulls_secret_shaped',
  /** A request id that was already used for a different post. */
  requestReused: 'pulls_request_reused',
  /** The post could not be recorded in the audit log, so it was not sent. */
  notRecorded: 'pulls_not_recorded',
} as const;

/** The sentence a secret-shaped body is stopped with (the app shows the daemon's word as it is). */
export const SECRET_SHAPED_SENTENCE = 'This looks like a secret. Remove it, or post anyway.';

/** The person's tap, minted once per draft: a repeat of the same one is answered with the first result. */
export const RequestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,64}$/u, 'a request id is 16 to 64 plain characters');

/** A comment that is not blank and fits GitHub's cap. */
const BodySchema = z
  .string()
  .max(MAX_POST_BODY)
  .refine(text => text.trim() !== '', 'a comment needs some text');

const Common = { requestId: RequestIdSchema, body: BodySchema, postAnyway: z.boolean().optional() } as const;

/** A comment in the PR's conversation. */
export const PostCommentRequestSchema = z.strictObject({ ...Common });
export type PostCommentRequest = z.infer<typeof PostCommentRequestSchema>;

/** A reply in a review thread (`id` is the thread's GraphQL node id, as the threads read gave it). */
export const PostReplyRequestSchema = z.strictObject({
  ...Common,
  threadId: z.string().regex(/^[A-Za-z0-9_=-]{1,100}$/u),
});
export type PostReplyRequest = z.infer<typeof PostReplyRequestSchema>;

/** A new single comment on diff lines (not a pending review). `line` is the last line, `startLine` the first. */
export const PostLineRequestSchema = z
  .strictObject({
    ...Common,
    commitId: z.string().regex(/^[0-9a-f]{7,64}$/u),
    path: z
      .string()
      .min(1)
      .max(4096)
      .refine(path => !/\p{Cc}/u.test(path), 'a path has no control characters'),
    side: z.enum(DIFF_SIDES),
    line: z.number().int().min(1).max(2_147_483_647),
    startLine: z.number().int().min(1).max(2_147_483_647).optional(),
  })
  .refine(request => request.startLine === undefined || request.startLine < request.line, {
    message: 'the first line comes before the last',
    path: ['startLine'],
  });
export type PostLineRequest = z.infer<typeof PostLineRequestSchema>;

const PostedUrl = z.url().max(500);

/** `201`: it is on GitHub. `replayed` says this is the first answer given again, not a second post. */
export const PostedAnswerSchema = z.strictObject({
  kind: z.literal('posted'),
  /** GitHub's id of the comment (digits for a REST comment, a node id for a thread reply). */
  id: z.string().regex(/^[A-Za-z0-9_=-]{1,100}$/u),
  /** Where it lives on GitHub; only an `https://github.com` address is ever passed on. */
  url: PostedUrl.optional(),
  replayed: z.boolean(),
});
export type PostedAnswer = z.infer<typeof PostedAnswerSchema>;

/** `202`: the call may have reached GitHub and the answer did not come back. The page reads the thread to see. */
export const PostUnknownAnswerSchema = z.strictObject({ kind: z.literal('unknown') });
export type PostUnknownAnswer = z.infer<typeof PostUnknownAnswerSchema>;

export const PostAnswerSchema = z.discriminatedUnion('kind', [PostedAnswerSchema, PostUnknownAnswerSchema]);
export type PostAnswer = z.infer<typeof PostAnswerSchema>;

/** Which account a post goes out as, so the button can say so before the person taps it. */
export const PosterAnswerSchema = z.strictObject({ login: z.string().min(1).max(100) });
export type PosterAnswer = z.infer<typeof PosterAnswerSchema>;
