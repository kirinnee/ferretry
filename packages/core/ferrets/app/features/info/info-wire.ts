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

const ManagedWorktreeSchema = z.object({
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
const RELAUNCH_DRIFTS = ['arguments', 'settings'] as const;
export type RelaunchDrift = (typeof RELAUNCH_DRIFTS)[number];

const RelaunchSettingsSchema = z.object({
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
const readError = (failure: unknown): InfoReadError => {
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
