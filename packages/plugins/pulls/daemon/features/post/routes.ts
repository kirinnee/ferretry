import { createHash } from 'node:crypto';
import { type AuditActor, type AuditDraft, auditKind } from '@ferretry/core-gate/contract';
import {
  ApiError,
  type CallContext,
  decodeParameter,
  jsonResponse,
  type Log,
  parseBody,
  type RouteHandler,
} from '@ferretry/kernel/contract';
import { rawTextMayHold } from '@ferretry/std/credential-words';
import type { GitAccountsApi } from '@ferretry/plugin-git-accounts/contract';
import type { ProjectsApi } from '@ferretry/plugin-projects/contract';
import type { z } from 'zod';
import {
  POST_CODES,
  PostCommentRequestSchema,
  PostedAnswerSchema,
  PostLineRequestSchema,
  PostReplyRequestSchema,
  PosterAnswerSchema,
  PostUnknownAnswerSchema,
  PULLS_AUDIT,
  PULLS_CODES,
  SECRET_SHAPED_SENTENCE,
} from '../../../contract/index.ts';
import { parseRepoSegment } from '../../../contract/repo-segment.ts';
import type { GithubClient } from '../../adapters/github/client.ts';
import { resolveTarget } from '../files/target.ts';
import type { PostLedger } from './ledger.ts';
import { type PostJob, type PostRefusal, type Posted, sendPost } from './send.ts';

/** A body is at most 65,536 characters; JSON can spend up to six bytes on one of them (`\u0000`). */
const BODY_LIMIT = { maxBytes: 512 * 1024 } as const;

export interface PostServices {
  readonly github: Pick<GithubClient, 'write' | 'graphql'>;
  readonly projects: Pick<ProjectsApi, 'find'>;
  readonly accounts: Pick<GitAccountsApi, 'list'>;
  /** Gate's audit door, or nothing when Gate is not there: then no post is made, because none could be recorded. */
  readonly record: () => ((draft: AuditDraft) => Promise<void>) | undefined;
  readonly ledger: PostLedger<Posted, PostRefusal>;
  /** Where a failed audit write is said, after the post it belongs to has gone out. */
  readonly log: Pick<Log, 'error'>;
}

/** An outcome line is written again this many times before it is given up on (and said, loudly, in the log). */
const OUTCOME_TRIES = 3;

const param = (call: CallContext, name: string): string => decodeParameter(call.params.get(name) ?? '') ?? '';

/** Who the log says posted: from the credential admission derived, never from the request. */
function actorOf(call: CallContext): AuditActor {
  const credential = (call as { credential?: { tokenClass: string; principal?: { holder: string } } }).credential;
  if (credential === undefined) return { kind: 'anonymous' };
  if (credential.tokenClass === 'device' && credential.principal !== undefined)
    return { kind: 'device', deviceId: credential.principal.holder };
  return credential.tokenClass === 'warden' ? { kind: 'warden' } : { kind: 'host' };
}

async function addressOf(services: PostServices, call: CallContext) {
  const named = parseRepoSegment(param(call, 'repo'));
  const repo = named === undefined ? undefined : ({ provider: 'github', ...named } as const);
  const number = Number(param(call, 'number'));
  if (repo === undefined || !Number.isSafeInteger(number) || number < 1 || number > 2_147_483_647)
    throw new ApiError(400, 'that is not a repository and pull request number', PULLS_CODES.refused);
  const target = await resolveTarget(services, param(call, 'project'), repo);
  if (!target.ok) throw new ApiError(target.status, target.message, target.code);
  return { target, repo, number } as const;
}

const sameAs = (job: PostJob, where: string): string => {
  // What makes two taps the SAME post: where it goes (the account included) and what it says. The request id, "post
  // anyway" and the account the person was shown are not part.
  const {
    requestId: _id,
    postAnyway: _anyway,
    account: _shown,
    ...rest
  } = job.request as typeof job.request & { postAnyway?: boolean };
  return createHash('sha256')
    .update(JSON.stringify([job.kind, where, rest]))
    .digest('hex');
};

/**
 * The post routes. Each posts ONE comment to GitHub as the person's connected account, and nothing else:
 * - person only (`caller: 'person'`): a ferret is refused `owner_only` by Gate before any of this runs (ferrets post
 *   through their own `gh`, which is audited);
 * - exactly once per request id (`ledger`), and never retried: a call that may have reached GitHub answers `202 unknown`;
 * - a body of at most 65,536 characters, refused before any request; a secret-shaped body needs a second tap;
 * - audited with names and ids only (never the body): the project, the repository, the number, the kind, the comment id.
 */
export function postRoutes(services: PostServices) {
  const post =
    <
      S extends z.ZodType<{
        requestId: string;
        body: string;
        postAnyway?: boolean | undefined;
        account: { id: string; login: string };
      }>,
    >(
      kind: PostJob['kind'],
      schema: S,
    ): RouteHandler =>
    async call => {
      const request = (await parseBody(call.request, schema, BODY_LIMIT)) as z.output<S>;
      const { target, repo, number } = await addressOf(services, call);
      const record = services.record();
      const where = `${target.project}/${target.account}/${repo.owner}/${repo.name}#${String(number)}`;
      const detailOf = (extra: Record<string, string | number | boolean>) => ({
        repo: `${repo.owner}/${repo.name}`,
        number,
        kind,
        requestId: request.requestId,
        account: target.account,
        ...extra,
      });
      // No post is made that could not be written down.
      if (record === undefined)
        throw new ApiError(503, 'this daemon cannot record a post yet, so it makes none', POST_CODES.notRecorded);
      /** The line a post leaves once it is decided. A failed write is retried and then SAID: it is never silent. */
      const audit = async (
        outcome: 'succeeded' | 'refused' | 'failed',
        detail: Record<string, string | number | boolean>,
      ): Promise<void> => {
        for (let attempt = 1; attempt <= OUTCOME_TRIES; attempt += 1) {
          try {
            await record({
              event: auditKind(PULLS_AUDIT.commentPosted),
              actor: actorOf(call),
              subject: target.project,
              outcome,
              detail: detailOf(detail),
            });
            return;
          } catch {
            // tried again below
          }
        }
        services.log.error('a post went out (or was refused) and its audit line could not be written', {
          kind,
          outcome,
          requestId: request.requestId,
          project: target.project,
        });
      };

      // The account the person was shown is the one this post goes out as, or it does not go out.
      if (request.account.id !== target.account || request.account.login !== target.login) {
        await audit('refused', { reason: 'account-changed' });
        throw new ApiError(
          409,
          `the account for this project changed to @${target.login}; check and post again`,
          POST_CODES.accountChanged,
        );
      }

      if (request.postAnyway !== true && rawTextMayHold(request.body)) {
        await audit('refused', { reason: 'secret-shaped' });
        throw new ApiError(409, SECRET_SHAPED_SENTENCE, POST_CODES.secretShaped);
      }

      const job = { kind, request } as PostJob;
      const ran = await services.ledger.run(request.requestId, sameAs(job, where), async () => {
        // The intent is on the log BEFORE anything is sent; if it cannot be written nothing is sent (fail closed).
        try {
          await record({
            event: auditKind(PULLS_AUDIT.commentIntent),
            actor: actorOf(call),
            subject: target.project,
            outcome: 'succeeded',
            detail: detailOf({}),
          });
        } catch {
          return {
            kind: 'refused',
            refusal: {
              status: 503,
              code: POST_CODES.notRecorded,
              message: 'this daemon could not record that post, so it was not made',
            },
          };
        }
        return await sendPost(services.github, { account: target.account, repo, number }, job);
      });
      if (ran.kind === 'busy') {
        await audit('refused', { reason: 'busy' });
        throw new ApiError(
          503,
          'too many posts are waiting to be confirmed; try again in a few minutes',
          POST_CODES.busy,
        );
      }
      if (ran.kind === 'mismatch')
        throw new ApiError(409, 'that request was already used for a different comment', POST_CODES.requestReused);
      const { settled, replayed } = ran;
      if (settled.kind === 'done') {
        // A repeat of a post that went out is not a second post: it is answered, and not written down again.
        if (!replayed) await audit('succeeded', { commentId: settled.value.id });
        return jsonResponse(
          PostedAnswerSchema.parse({
            kind: 'posted',
            id: settled.value.id,
            ...(settled.value.url === undefined ? {} : { url: settled.value.url }),
            replayed,
          }),
          201,
        );
      }
      if (settled.kind === 'unknown') {
        if (!replayed) await audit('failed', { unknown: true });
        return jsonResponse(PostUnknownAnswerSchema.parse({ kind: 'unknown' }), 202);
      }
      if (!replayed) await audit('refused', { reason: settled.refusal.code });
      throw new ApiError(
        settled.refusal.status,
        settled.refusal.message,
        settled.refusal.code,
        undefined,
        settled.refusal.pausedUntilMs === undefined ? undefined : { pausedUntilMs: settled.refusal.pausedUntilMs },
      );
    };

  return {
    'POST /v1/pulls/:project/:repo/:number/comment': post('comment', PostCommentRequestSchema),
    'POST /v1/pulls/:project/:repo/:number/reply': post('reply', PostReplyRequestSchema),
    'POST /v1/pulls/:project/:repo/:number/line-comment': post('line', PostLineRequestSchema),
    /** Which account a post goes out as: its GitHub login, so the button can say "Post as @login" before it is tapped. */
    'GET /v1/pulls/:project/:repo/:number/poster': (async call => {
      const { target } = await addressOf(services, call);
      const account = (await services.accounts.list()).find(candidate => candidate.id === target.account);
      if (account === undefined)
        throw new ApiError(409, 'the GitHub account linked to this project was removed', PULLS_CODES.noAccount);
      return jsonResponse(PosterAnswerSchema.parse({ id: account.id, login: account.login }));
    }) satisfies RouteHandler,
  } satisfies Record<string, RouteHandler>;
}
