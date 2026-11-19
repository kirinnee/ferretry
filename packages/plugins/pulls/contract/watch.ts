/**
 * Watching a project's pull requests and CI (r9 E2): the settings in `config/pulls.yaml`, the last-seen snapshot the
 * daemon keeps so a change is told once (also across a restart), the wake-up event and what the status route answers.
 *
 * NOTHING HERE CAN CARRY A TOKEN (the contract test reads every schema in `wire.ts`; this file follows the same rule).
 * Text that strangers wrote (a PR title) is bounded here and never put in a push beyond the title.
 */
import { defineConfig, defineEvent, defineState, neverLoosens, type ConfigFileDef } from '@ferretry/kernel/contract';
import { z } from 'zod';
import { PullSummarySchema, RepoRefSchema } from './wire.ts';

// ─── what can notify ──────────────────────────────────────────────────────────────────────────────────────────────

/** The events a watch can tell the phone about. A closed list: the screen and the config use the same words. */
export const WATCH_EVENTS = [
  'ciFailed',
  'reviewRequested',
  'changesRequested',
  'approved',
  'ciPassed',
  'comment',
  'closed',
] as const;
export type WatchEvent = (typeof WATCH_EVENTS)[number];

/** On by default: CI failed on your PR; a review asked of you; changes requested or approved on your PR. */
export const DEFAULT_NOTIFY: Readonly<Record<WatchEvent, boolean>> = Object.freeze({
  ciFailed: true,
  reviewRequested: true,
  changesRequested: true,
  approved: true,
  ciPassed: false,
  comment: false,
  closed: false,
});

export const NotifyChoicesSchema = z.strictObject({
  ciFailed: z.boolean().optional(),
  reviewRequested: z.boolean().optional(),
  changesRequested: z.boolean().optional(),
  approved: z.boolean().optional(),
  ciPassed: z.boolean().optional(),
  comment: z.boolean().optional(),
  closed: z.boolean().optional(),
});
export type NotifyChoices = z.infer<typeof NotifyChoicesSchema>;

// ─── config/pulls.yaml ────────────────────────────────────────────────────────────────────────────────────────────

/** A project id as Projects mints it (a UUID); a plain string here so no contract imports another's. */
export const WatchProjectIdSchema = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/u);

export const ProjectWatchSettingSchema = z.strictObject({
  /** Off unless a person turned it on: a watch asks GitHub on a timer, with the account's token. */
  watch: z.boolean().default(false),
  notify: NotifyChoicesSchema.default({}),
});
export type ProjectWatchSetting = z.infer<typeof ProjectWatchSettingSchema>;

export const PullsConfigSchema = z.strictObject({
  projects: z.record(WatchProjectIdSchema, ProjectWatchSettingSchema).default({}),
});
export type PullsConfig = z.infer<typeof PullsConfigSchema>;

/**
 * Watching and notifying can only ADD requests and pushes to a phone the owner already holds, and never reach anything
 * more: no setting here widens what a credential may do, so nothing is held for the owner.
 */
export const PullsConfigDef = defineConfig({
  file: 'pulls.yaml',
  schema: PullsConfigSchema,
  axis: 'configure',
  loosens: neverLoosens,
}) as unknown as ConfigFileDef<PullsConfig>;

/** What a project's settings come to: absent reads as watch off and the default choices. */
export function settingsOf(
  config: PullsConfig | undefined,
  project: string,
): {
  readonly watch: boolean;
  readonly notify: Readonly<Record<WatchEvent, boolean>>;
} {
  const own = config?.projects[project];
  const notify = { ...DEFAULT_NOTIFY };
  for (const event of WATCH_EVENTS) notify[event] = own?.notify[event] ?? DEFAULT_NOTIFY[event];
  return { watch: own?.watch ?? false, notify };
}

// ─── the last-seen snapshot (state/pulls/watch/<project>.json) ────────────────────────────────────────────────────

/** One open PR as the watch last saw it: the summary a screen shows, and what the next tick compares against. */
export const WatchedPullSchema = PullSummarySchema.extend({
  /** Whether the connected account wrote it. */
  mine: z.boolean(),
  /** Whether the connected account is asked to review it. */
  requestedMe: z.boolean(),
  /** Comments in the main conversation (kept for the account's own PRs only; 0 otherwise). */
  comments: z.number().int().nonnegative(),
});
export type WatchedPull = z.infer<typeof WatchedPullSchema>;

export const WatchedRepoSchema = z.strictObject({
  repo: RepoRefSchema,
  /** A `gha_…` id: the account whose eyes these are. */
  account: z.string().regex(/^gha_[0-9]{1,20}$/u),
  login: z.string().min(1).max(100),
  pulls: z.array(WatchedPullSchema).max(100),
  checkedAt: z.iso.datetime(),
  /** Why the last read of this repo did not answer, when it did not. A code of ours, never GitHub's text. */
  problem: z.string().max(60).optional(),
});
export type WatchedRepo = z.infer<typeof WatchedRepoSchema>;

export const WatchSnapshotSchema = z.strictObject({
  repos: z.array(WatchedRepoSchema).max(50),
});
export type WatchSnapshot = z.infer<typeof WatchSnapshotSchema>;

export const WATCH_STATE = defineState({
  name: 'watch',
  path: 'watch/*.json',
  store: 'json',
  format: 1,
  schema: WatchSnapshotSchema,
});

// ─── wake-up and what the status route answers ────────────────────────────────────────────────────────────────────

/** A project's PRs or CI changed. A wake-up: read `GET /v1/pulls/watch` for the truth. */
export const PullsChanged = defineEvent('pulls.changed', z.strictObject({ project: WatchProjectIdSchema }));

export const WatchProjectViewSchema = z.strictObject({
  project: WatchProjectIdSchema,
  watch: z.boolean(),
  /** The effective choice per event (the defaults with the project's own on top). */
  notify: z.record(z.enum(WATCH_EVENTS), z.boolean()),
  repos: z.array(WatchedRepoSchema).max(50),
  /** Polling is paused to stay inside GitHub's limit, until this instant (the screen says it with `budgetSentence`). */
  pausedUntil: z.iso.datetime().optional(),
  /** A repository with no connected account to read it as: the screen says "connect an account". */
  needsAccount: z.array(RepoRefSchema).max(50),
});
export type WatchProjectView = z.infer<typeof WatchProjectViewSchema>;

export const WatchOverviewSchema = z.strictObject({ projects: z.array(WatchProjectViewSchema).max(500) });
export type WatchOverview = z.infer<typeof WatchOverviewSchema>;

/** `PATCH /v1/pulls/watch/:project`: any of the two. A notify choice not named stays as it was. */
export const WatchPatchSchema = z.strictObject({
  watch: z.boolean().optional(),
  notify: NotifyChoicesSchema.optional(),
});
export type WatchPatch = z.infer<typeof WatchPatchSchema>;

/** How often a watch looks, by what is going on. Seconds are what the cadence test reads. */
export const WATCH_CADENCE_MS = {
  /** A PR whose CI is running. */
  running: 30_000,
  /** Some device has the PRs screen open (it read the status within `viewedWithinMs`). */
  viewed: 60_000,
  idle: 300_000,
  viewedWithinMs: 150_000,
} as const;
