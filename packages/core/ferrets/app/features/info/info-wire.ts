/**
 * THE INFO PANEL'S READS, by route key through the one client this half is given (§9.6): the ferret record, the
 * ferret list (for lineage), the managed worktrees and the relaunch-settings dial. Every answer is PARSED with a
 * schema before anything draws it, so a body this page cannot read is a failed read, never a claim about the ferret.
 *
 * The worktree and relaunch shapes are Ferrets' own daemon records; the app half holds the narrow slice it draws
 * rather than importing the daemon half.
 */

import { z } from 'zod';
import { type FerretSummary, FerretSummarySchema } from '../../../contract/index.ts';
import { callFailure, type FerretsClient } from '../../lib/client.ts';

/** The slice of a managed worktree Info draws. Unknown fields are ignored: the daemon owns the full record. */
const WorktreeStatusSchema = z.object({
  staged: z.boolean(),
  unstaged: z.boolean(),
  untracked: z.boolean(),
  conflicted: z.boolean(),
});

export const ManagedWorktreeSchema = z.object({
  path: z.string().min(1),
  branch: z.string().min(1),
  removedAt: z.string().optional(),
  live: z
    .object({
      branch: z.string().min(1).optional(),
      status: WorktreeStatusSchema.optional(),
    })
    .optional(),
});
export type ManagedWorktree = z.infer<typeof ManagedWorktreeSchema>;

const WorktreeListSchema = z.object({ worktrees: z.array(ManagedWorktreeSchema) });

/** Whether a running ferret is on the settings a relaunch would give it, and if not, why. */
export const RELAUNCH_DRIFTS = ['arguments', 'settings'] as const;
export type RelaunchDrift = (typeof RELAUNCH_DRIFTS)[number];

export const RelaunchSettingsSchema = z.object({
  current: z.boolean(),
  reasons: z.array(z.enum(RELAUNCH_DRIFTS)),
});
export type RelaunchSettings = z.infer<typeof RelaunchSettingsSchema>;

/** A read the daemon refused or could not answer, with the daemon's own words. */
export class InfoReadError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'InfoReadError';
  }
}

/** Turns whatever a client threw into a readable error (the daemon's message when it said one). */
export const readError = (failure: unknown): InfoReadError => {
  const fields = callFailure(failure);
  const message =
    typeof fields?.message === 'string' && fields.message !== ''
      ? fields.message
      : failure instanceof Error
        ? failure.message
        : 'the daemon could not answer';
  return new InfoReadError(
    message,
    typeof fields?.status === 'number' ? fields.status : undefined,
    typeof fields?.code === 'string' ? fields.code : undefined,
  );
};

const call = async (client: FerretsClient, route: string, init?: Parameters<FerretsClient['call']>[1]) => {
  try {
    return await client.call<unknown>(route, init);
  } catch (failure) {
    throw readError(failure);
  }
};

const unreadable = (): InfoReadError => new InfoReadError('the daemon answered with a body this page cannot read', 502);

/** `GET /v1/ferrets/:ferretId`. */
export const readFerret = async (client: FerretsClient, ferretId: string): Promise<FerretSummary> => {
  const parsed = FerretSummarySchema.safeParse(
    await call(client, 'GET /v1/ferrets/:ferretId', { params: { ferretId } }),
  );
  if (!parsed.success) throw unreadable();
  return parsed.data;
};

/** `GET /v1/ferrets`: every ferret on the machine, for lineage. */
export const readFerrets = async (client: FerretsClient): Promise<readonly FerretSummary[]> => {
  const parsed = z.array(FerretSummarySchema).safeParse(await call(client, 'GET /v1/ferrets'));
  if (!parsed.success) throw unreadable();
  return parsed.data;
};

/** `GET /v1/worktrees`: the checkouts the daemon made for ferrets. */
export const readWorktrees = async (client: FerretsClient): Promise<readonly ManagedWorktree[]> => {
  const parsed = WorktreeListSchema.safeParse(await call(client, 'GET /v1/worktrees'));
  if (!parsed.success) throw unreadable();
  return parsed.data.worktrees;
};

/** `GET /v1/ferrets/:ferretId/relaunch-settings`. */
export const readRelaunchSettings = async (client: FerretsClient, ferretId: string): Promise<RelaunchSettings> => {
  const parsed = RelaunchSettingsSchema.safeParse(
    await call(client, 'GET /v1/ferrets/:ferretId/relaunch-settings', { params: { ferretId } }),
  );
  if (!parsed.success) throw unreadable();
  return parsed.data;
};

const RestartAnswerSchema = z.object({
  restarted: z.array(z.object({ id: z.string() })),
  queued: z.array(z.object({ id: z.string(), reason: z.string(), detail: z.string().optional() })),
  skipped: z.array(z.object({ id: z.string(), reason: z.string() })),
  failed: z.array(z.object({ id: z.string(), reason: z.string() })),
});

export type RestartOutcome = { readonly kind: 'restarted' } | { readonly kind: 'queued'; readonly sentence: string };

const QUEUE_WORD: Readonly<Record<string, string>> = {
  'mid-turn': 'it is in the middle of a turn',
  'in-flight': 'it is running work a restart would lose',
  'own-session': 'it is the ferret that asked',
};

/**
 * `POST /v1/restarts` for this one ferret: an owner or governed-device act, exactly as the Actions menu's Restart.
 * The same-login move resumes the conversation. A busy ferret is QUEUED and said so; a refusal or a failure throws
 * the daemon's own words.
 */
export const restartFerret = async (client: FerretsClient, ferretId: string): Promise<RestartOutcome> => {
  const parsed = RestartAnswerSchema.safeParse(
    await call(client, 'POST /v1/restarts', { body: { scope: 'ids', ids: [ferretId] } }),
  );
  if (!parsed.success) throw unreadable();
  const answer = parsed.data;
  const failed = answer.failed.find(entry => entry.id === ferretId);
  if (failed !== undefined) throw new InfoReadError(failed.reason);
  const queued = answer.queued.find(entry => entry.id === ferretId);
  if (queued !== undefined)
    return {
      kind: 'queued',
      sentence:
        queued.detail ?? `Queued: ${QUEUE_WORD[queued.reason] ?? queued.reason}; it restarts at its next idle moment.`,
    };
  const skipped = answer.skipped.find(entry => entry.id === ferretId);
  if (skipped !== undefined) throw new InfoReadError(`Nothing was restarted: ${skipped.reason.replace(/-/gu, ' ')}.`);
  return { kind: 'restarted' };
};
