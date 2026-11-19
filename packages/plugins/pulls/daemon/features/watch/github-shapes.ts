import { z } from 'zod';

/**
 * What the watch reads of GitHub's answers, and nothing more. Each shape is loose on purpose (GitHub adds fields) and
 * every field is optional where an answer without it is still usable; an item that does not parse is skipped, never
 * thrown on, so one odd PR cannot stop a project's watch.
 */
const User = z.object({ login: z.string().min(1).max(100), avatar_url: z.string().optional() });

export const RawPullSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  state: z.string(),
  draft: z.boolean().optional(),
  html_url: z.string(),
  user: User.nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  merged_at: z.string().nullable().optional(),
  head: z.object({ sha: z.string(), ref: z.string() }),
  base: z.object({ ref: z.string() }),
  requested_reviewers: z.array(User).optional(),
});
export type RawPull = z.infer<typeof RawPullSchema>;

export const RawReviewSchema = z.object({
  user: User.nullable(),
  state: z.string(),
  submitted_at: z.string().nullable().optional(),
});
export type RawReview = z.infer<typeof RawReviewSchema>;

const Signal = z.object({ status: z.string().nullable().optional(), conclusion: z.string().nullable().optional() });
export const CheckRunsSchema = z.object({ check_runs: z.array(Signal) });
export const WorkflowRunsSchema = z.object({ workflow_runs: z.array(Signal) });

/** The items of a list that parse, in order. */
export function parseEach<T>(items: readonly unknown[], schema: z.ZodType<T>): T[] {
  const out: T[] = [];
  for (const item of items) {
    const parsed = schema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}
