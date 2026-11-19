import { z } from 'zod';
import type { ActionsJobInput, ActionsRunInput, ActionsStepInput, CheckRunInput } from '../../../contract/ci-timing.ts';

/**
 * What GitHub's Actions and checks endpoints answer, read leniently (GitHub adds fields, and a field we do not read is
 * not our business) and into the plain inputs `lib/ci-timing.ts` folds. Text we keep is bounded; `body_html`-style
 * fields are not read at all. An item that does not parse is dropped, never guessed at.
 */
const text = (max: number) => z.string().max(max);
const instant = z.string().max(40).nullable().optional();
const url = z.string().max(500).nullable().optional();

const StepPayload = z.object({
  name: text(1000),
  number: z.number().int().nonnegative(),
  status: text(40),
  conclusion: text(40).nullable().optional(),
  started_at: instant,
  completed_at: instant,
});

const JobPayload = z.object({
  id: z.number().int().nonnegative(),
  name: text(1000),
  status: text(40),
  conclusion: text(40).nullable().optional(),
  started_at: instant,
  completed_at: instant,
  html_url: url,
  steps: z.array(z.unknown()).max(2000).optional(),
});

const RunPayload = z.object({
  id: z.number().int().nonnegative(),
  name: text(1000).nullable().optional(),
  display_title: text(1000).nullable().optional(),
  event: text(100),
  status: text(40).nullable().optional(),
  conclusion: text(40).nullable().optional(),
  run_attempt: z.number().int().positive().optional(),
  head_sha: z.string().regex(/^[0-9a-f]{7,64}$/u),
  created_at: text(40),
  run_started_at: instant,
  updated_at: text(40),
  html_url: url,
});

const CheckPayload = z.object({
  id: z.number().int().nonnegative(),
  name: text(1000),
  status: text(40),
  conclusion: text(40).nullable().optional(),
  started_at: instant,
  completed_at: instant,
  html_url: url,
  app: z
    .object({ slug: text(200).nullable().optional() })
    .nullable()
    .optional(),
});

const orNull = <T>(value: T | null | undefined): T | null => value ?? null;

export function readRun(raw: unknown): ActionsRunInput | undefined {
  const parsed = RunPayload.safeParse(raw);
  if (!parsed.success) return undefined;
  const run = parsed.data;
  return {
    id: run.id,
    name: run.name ?? run.display_title ?? `Run ${run.id}`,
    event: run.event,
    status: run.status ?? 'queued',
    conclusion: orNull(run.conclusion),
    runAttempt: run.run_attempt ?? 1,
    headSha: run.head_sha,
    createdAt: run.created_at,
    runStartedAt: orNull(run.run_started_at),
    updatedAt: run.updated_at,
    htmlUrl: orNull(run.html_url),
  };
}

const readStep = (raw: unknown): ActionsStepInput | undefined => {
  const parsed = StepPayload.safeParse(raw);
  if (!parsed.success) return undefined;
  const step = parsed.data;
  return {
    name: step.name,
    number: step.number,
    status: step.status,
    conclusion: orNull(step.conclusion),
    startedAt: orNull(step.started_at),
    completedAt: orNull(step.completed_at),
  };
};

export function readJob(raw: unknown): ActionsJobInput | undefined {
  const parsed = JobPayload.safeParse(raw);
  if (!parsed.success) return undefined;
  const job = parsed.data;
  return {
    id: job.id,
    name: job.name,
    status: job.status,
    conclusion: orNull(job.conclusion),
    startedAt: orNull(job.started_at),
    completedAt: orNull(job.completed_at),
    htmlUrl: orNull(job.html_url),
    steps: (job.steps ?? []).flatMap(step => {
      const read = readStep(step);
      return read === undefined ? [] : [read];
    }),
  };
}

/** A check run that is NOT a GitHub Actions job (those are the runs' own jobs, already shown). */
export function readCheckRun(raw: unknown): CheckRunInput | undefined {
  const parsed = CheckPayload.safeParse(raw);
  if (!parsed.success || parsed.data.app?.slug === 'github-actions') return undefined;
  const check = parsed.data;
  return {
    id: check.id,
    name: check.name,
    status: check.status,
    conclusion: orNull(check.conclusion),
    startedAt: orNull(check.started_at),
    completedAt: orNull(check.completed_at),
    htmlUrl: orNull(check.html_url),
  };
}

/** The list a wrapper object holds under `key` (`workflow_runs`, `jobs`, `check_runs`), or none. */
export function listUnder(body: unknown, key: string): readonly unknown[] {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return [];
  const value = (body as Record<string, unknown>)[key];
  return Array.isArray(value) ? value : [];
}

/** The head commit a pull request or a branch answer names, or `undefined`. */
export function headShaOf(body: unknown, where: 'pull' | 'branch'): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const record = body as Record<string, unknown>;
  const holder = where === 'pull' ? record.head : record.commit;
  const sha = typeof holder === 'object' && holder !== null ? (holder as Record<string, unknown>).sha : undefined;
  return typeof sha === 'string' && /^[0-9a-f]{7,64}$/u.test(sha) ? sha : undefined;
}
