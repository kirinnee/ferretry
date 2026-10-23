/**
 * PACK MODE — a ferret delegates to sub-ferrets and picks the model each one runs on (docs/pack-mode.md).
 *
 * Two configuration files (docs/config-files.md) and four routes:
 *
 * - `pack.yaml` — the machine's switch, who decides the model (the agent, or Jev), the sub-ferret limits
 *   and the start probe. {@link PackConfig}.
 * - `models-guide.yaml` — the ONE routing prompt: plain words on which model runs which kind of sub-task,
 *   read the same way by the asking ferret and by Jev. Absent means the prompt rendered from the model
 *   catalogs in effect. {@link ModelsGuideFile}.
 * - `POST /v1/pack/recommend` — the routing prompt and the models usable on this machine NOW.
 * - `POST /v1/pack/new` — start one sub-ferret, after a probe; a refusal is a closed code a ferret
 *   falls back on ({@link PackRefusalCode}).
 * - `GET /v1/sessions/:sessionId/result` — what a finished sub-ferret reported.
 * - `PATCH /v1/sessions/:sessionId/pack` — one ferret's own switch.
 *
 * Data only: model ids, labels and limits — never a credential.
 */
import { z } from 'zod';
import { InstantSchema, NonNegativeIntegerSchema, PositiveIntegerSchema } from './common.ts';
import { HarnessSchema, InteractionModeSchema, SessionViewSchema } from './session.ts';

const NonEmpty = z.string().min(1);

// ── pack.yaml ────────────────────────────────────────────────────────────────────────────────────

/** Who picks the model a sub-ferret runs on: the asking ferret, or Jev, each reading the routing prompt. */
export const PACK_DECISION_MODES = ['agent', 'jev'] as const;
export const PackDecisionModeSchema = z.enum(PACK_DECISION_MODES);
export type PackDecisionMode = z.infer<typeof PackDecisionModeSchema>;

/** The deepest a sub-ferret may sit: 2 means a sub-ferret may start its own, and those may not. */
export const PACK_MAX_DEPTH_CEILING = 4;

export const PackLimitsSchema = z.strictObject({
  /** Running sub-ferrets an INTERACTIVE ferret (a person at it) may have at once. */
  interactiveChildren: z.number().int().min(0).max(100),
  /** Running sub-ferrets an unattended ferret may have at once. */
  autoChildren: z.number().int().min(0).max(100),
  /** How deep sub-ferrets nest: a top-level ferret is depth 0, its sub-ferret 1. */
  maxDepth: z.number().int().min(1).max(PACK_MAX_DEPTH_CEILING),
});
export type PackLimits = z.infer<typeof PackLimitsSchema>;

/** The "reply OK" check `fy new` runs before it starts a sub-ferret. */
export const PackProbeSchema = z.strictObject({
  /** How long one probe may take before it counts as failed. */
  timeoutSeconds: z.number().int().min(5).max(300),
  /** How long a PASSED probe is trusted for, per runtime, model and effort, so a burst probes once. */
  cacheSeconds: z.number().int().min(0).max(3_600),
});
export type PackProbe = z.infer<typeof PackProbeSchema>;

export const PackJevSchema = z.strictObject({
  /** Jev's spend on ranking candidates, per UTC day, separate from the Warden's own cap. */
  usdPerDay: z.number().finite().min(0).max(100),
});
export type PackJev = z.infer<typeof PackJevSchema>;

export const PackConfigSchema = z.strictObject({
  /** The machine's switch. Off: no ferret is told about Pack mode and `fy new` refuses `pack_off`. */
  enabled: z.boolean(),
  decision: PackDecisionModeSchema,
  limits: PackLimitsSchema,
  probe: PackProbeSchema,
  jev: PackJevSchema,
});
export type PackConfig = z.infer<typeof PackConfigSchema>;

/** What a machine with no `pack.yaml` behaves as: on, the agent decides, 20 / 4 / depth 2. */
export const DEFAULT_PACK_CONFIG: PackConfig = {
  enabled: true,
  decision: 'agent',
  limits: { interactiveChildren: 20, autoChildren: 4, maxDepth: 2 },
  probe: { timeoutSeconds: 45, cacheSeconds: 180 },
  jev: { usdPerDay: 0.25 },
};

/** `pack.yaml` as written: every setting optional, the nested sections too, an unknown key refused. */
export const PackFileSchema = z.strictObject({
  enabled: z.boolean().optional(),
  decision: PackDecisionModeSchema.optional(),
  limits: PackLimitsSchema.partial().optional(),
  probe: PackProbeSchema.partial().optional(),
  jev: PackJevSchema.partial().optional(),
  /**
   * @deprecated The old guide builder's preferences. Still READ, so a file written before the one routing
   * prompt loads unchanged; the daemon folds it into the routing prompt once and removes it
   * (docs/pack-mode.md § Migration). Nothing else reads it.
   */
  routingPreferences: z.string().optional(),
});
export type PackFile = z.infer<typeof PackFileSchema>;

/** The Pack settings a parsed `pack.yaml` means. */
export function packConfigFromFile(file: PackFile): PackConfig {
  return {
    enabled: file.enabled ?? DEFAULT_PACK_CONFIG.enabled,
    decision: file.decision ?? DEFAULT_PACK_CONFIG.decision,
    limits: { ...DEFAULT_PACK_CONFIG.limits, ...file.limits },
    probe: { ...DEFAULT_PACK_CONFIG.probe, ...file.probe },
    jev: { ...DEFAULT_PACK_CONFIG.jev, ...file.jev },
  };
}

// ── models-guide.yaml: the routing prompt ────────────────────────────────────────────────────────

/**
 * The most a routing prompt may say. It rides WHOLE in the Pack section of every Pack ferret's system
 * prompt, whose total is held under a size test (docs/pack-mode.md § Size), so it is a paragraph, not a
 * document.
 */
export const MAX_ROUTING_PROMPT_CHARS = 1_200;

/**
 * The most a ROUGH prompt handed to Clean up may be: an owner may paste a mess and have it rewritten to
 * fit, so it is longer than a saved prompt may be.
 */
export const MAX_ROUGH_PROMPT_CHARS = 6_000;

/**
 * How to pick a sub-ferret's model and effort, in plain words: "planning or review → claude-opus-5-5 at
 * max; chores → claude-haiku-5-5 low; when a login is low on quota …". The asking ferret reads it in its
 * system prompt, Jev reads it as its guidance, and `fy new --auto` tries the models it NAMES in the order
 * it names them.
 */
export const RoutingPromptSchema = z.string().trim().min(1).max(MAX_ROUTING_PROMPT_CHARS);

/**
 * Where an accepted clean-up came from: the model that rewrote the prompt, what ran it, and when it was
 * suggested and accepted. Pack mode only reports it; a hand-written prompt has none.
 */
export const RoutingSuggestedSchema = z.strictObject({
  /** The model that rewrote it, as its runtime named it. */
  by: NonEmpty.max(128),
  /** What ran it: the runtime on this machine. */
  via: NonEmpty.max(128),
  at: InstantSchema,
  acceptedAt: InstantSchema,
  /** @deprecated Written by the old per-use-case review; read and ignored. */
  partial: z.boolean().optional(),
});
export type RoutingSuggested = z.infer<typeof RoutingSuggestedSchema>;

/**
 * `models-guide.yaml`: the routing prompt and, when it was an accepted clean-up, where it came from.
 * `prompt` absent means the prompt rendered from the catalogs (or, for a file not yet migrated, from its
 * old use cases).
 *
 * `useCases`, `routing` and `models` are the old guide's keys: still READ, never written, so a file from
 * before the one routing prompt loads; the daemon renders them into `prompt` once, keeps the old file in
 * its state home and removes them (docs/pack-mode.md § Migration).
 */
export const ModelsGuideFileSchema = z.strictObject({
  prompt: RoutingPromptSchema.optional(),
  suggested: RoutingSuggestedSchema.optional(),
  /** @deprecated The old use cases; migrated once into `prompt`. */
  useCases: z.array(z.unknown()).optional(),
  /** @deprecated The old `{prompt, short}` routing guidance; migrated once into `prompt`. */
  routing: z.unknown().optional(),
  /** @deprecated The old per-model descriptions; kept in the migration's backup. */
  models: z.array(z.unknown()).optional(),
});
export type ModelsGuideFile = z.infer<typeof ModelsGuideFileSchema>;

/** What a machine with no `models-guide.yaml` has: nothing written, so the rendered prompt is in effect. */
export const DEFAULT_MODELS_GUIDE_FILE: ModelsGuideFile = {};

/** Whether a parsed file still carries the old guide's keys, so the one-time migration has work to do. */
export const isLegacyModelsGuide = (file: ModelsGuideFile): boolean =>
  file.useCases !== undefined || file.routing !== undefined || file.models !== undefined;

/**
 * The routing prompt in effect. `file`: the owner's words (hand-written or an accepted clean-up).
 * `default`: rendered from the model catalogs in effect — the strongest tier for planning and review,
 * the balanced one for everyday work, the fast one for chores — so it moves with the catalogs.
 */
export const RoutingPromptViewSchema = z.strictObject({
  text: NonEmpty,
  source: z.enum(['file', 'default']),
  suggested: RoutingSuggestedSchema.optional(),
});
export type RoutingPromptView = z.infer<typeof RoutingPromptViewSchema>;

// ── Fleet-wide model list (the editor's vocabulary) ─────────────────────────────────────────────

/** One model any catalog in effect lists, with whether a runtime on THIS machine offers it. */
export const PackFleetModelSchema = z.strictObject({
  provider: NonEmpty,
  providerLabel: NonEmpty,
  harness: HarnessSchema,
  id: NonEmpty,
  label: NonEmpty,
  tier: z.enum(['best', 'balanced', 'fast']),
  context: z.number().int().positive().optional(),
  efforts: z.array(NonEmpty).readonly(),
  /** The runtimes on this machine that can run it, by name. Empty: nowhere here. */
  runtimes: z.array(NonEmpty).readonly(),
});
export type PackFleetModel = z.infer<typeof PackFleetModelSchema>;

/** The prompt an accepted clean-up replaced, kept so `fy guide undo` (or Undo) can put it back. */
export const RoutingUndoSchema = z.strictObject({
  savedAt: InstantSchema,
  /** `default`: there was no prompt of the owner's, so undoing removes it again. */
  source: z.enum(['file', 'default']),
});
export type RoutingUndo = z.infer<typeof RoutingUndoSchema>;

/**
 * One run of Clean up: a short-lived, hidden ferret (`fy guide clean-up`, the Clean up button). It is
 * `running` until its rewrite is written and read, then `suggested` or `failed`.
 */
export const PackCleanUpJobSchema = z.strictObject({
  id: NonEmpty.max(64),
  /** The clean-up ferret's session id. */
  session: NonEmpty,
  /** The name it shows under, like any ferret. */
  name: NonEmpty,
  runtime: NonEmpty,
  model: NonEmpty.optional(),
  startedAt: InstantSchema,
  status: z.enum(['running', 'suggested', 'failed']),
  /** `failed`: why, in one sentence. */
  message: NonEmpty.optional(),
});
export type PackCleanUpJob = z.infer<typeof PackCleanUpJobSchema>;

/** Whether Clean up can run here now, and on what: the ready agent runtimes, the best first. */
export const PackCleanUpStatusSchema = z.strictObject({
  available: z.boolean(),
  runtimes: z.array(NonEmpty).readonly(),
  /** Why not, when it is not available. */
  reason: NonEmpty.optional(),
  /** The newest run, so a reopened page finds it. */
  job: PackCleanUpJobSchema.optional(),
});
export type PackCleanUpStatus = z.infer<typeof PackCleanUpStatusSchema>;

// ── Refusals ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Why a candidate cannot run, or a start was refused — a closed set a ferret branches on to fall back.
 *
 * - `pack_off`: the machine or this ferret has Pack mode off.
 * - `limit_reached`: the parent has as many running sub-ferrets as its limit.
 * - `depth_exceeded`: a sub-ferret this deep may not start its own.
 * - `unknown_runtime` / `not_agent`: no such runtime, or one that cannot run sessions.
 * - `model_unavailable`: the runtime does not offer that model.
 * - `cli_missing`: the runtime's CLI is not installed.
 * - `not_logged_in`: its login needs signing in, or a secret it names is not set.
 * - `out_of_quota`: its login's quota is used up.
 * - `probe_failed`: the "reply OK" check did not answer OK in time.
 * - `no_candidate`: no model a runtime here offers can run now.
 * - `jev_unavailable` / `jev_cap_reached`: Jev decides, and could not.
 * - `scratch_cwd`: the folder named is a temporary or scratch folder, not a project; a sub-ferret runs in
 *   its parent's folder, so this comes only from an explicit `--cwd` or a start with no parent.
 */
export const PACK_REFUSAL_CODES = [
  'pack_off',
  'limit_reached',
  'depth_exceeded',
  'unknown_runtime',
  'not_agent',
  'model_unavailable',
  'cli_missing',
  'not_logged_in',
  'out_of_quota',
  'probe_failed',
  'no_candidate',
  'jev_unavailable',
  'jev_cap_reached',
  'scratch_cwd',
] as const;
export const PackRefusalCodeSchema = z.enum(PACK_REFUSAL_CODES);
export type PackRefusalCode = z.infer<typeof PackRefusalCodeSchema>;

export const PackRefusalSchema = z.strictObject({
  code: PackRefusalCodeSchema,
  /** One sentence: what is wrong. */
  message: NonEmpty,
  /** What to do instead, when there is something. */
  remedy: NonEmpty.optional(),
});
export type PackRefusal = z.infer<typeof PackRefusalSchema>;

// ── Quota headroom ───────────────────────────────────────────────────────────────────────────────

/**
 * How much of a login's quota is left, in bands (docs/pack-mode.md § Quota). The TIGHTEST window
 * measured decides: `plenty` half or more left, `some` a fifth to a half, `low` less than a fifth,
 * `exhausted` a window full or the provider says no, `unknown` nothing measured it — never read as full
 * or as empty.
 */
export const PACK_QUOTA_STATES = ['plenty', 'some', 'low', 'exhausted', 'unknown'] as const;
export const PackQuotaStateSchema = z.enum(PACK_QUOTA_STATES);
export type PackQuotaState = z.infer<typeof PackQuotaStateSchema>;

/** One quota window, with what is used and what is left. */
export const PackQuotaWindowSchema = z.strictObject({
  label: z.enum(['5h', 'week', 'month', 'key', 'tools']),
  usedPercent: z.number().finite().min(0).optional(),
  leftPercent: z.number().finite().min(0).max(100).optional(),
  resetsAt: InstantSchema.optional(),
  /** Its reset time has passed since it was measured, so it counts as fresh. */
  reset: z.boolean().optional(),
});
export type PackQuotaWindow = z.infer<typeof PackQuotaWindowSchema>;

/** A login's quota headroom as Pack mode reads it. */
export const PackQuotaSchema = z.strictObject({
  state: PackQuotaStateSchema,
  /** The tightest window's share left. */
  leftPercent: z.number().finite().min(0).max(100).optional(),
  tightest: PackQuotaWindowSchema.shape.label.optional(),
  windows: z.array(PackQuotaWindowSchema).readonly(),
  measuredAt: InstantSchema.optional(),
  /** One plain phrase: "5h 2% · week 46%", "out of quota until 18:00Z", "not measured". */
  summary: NonEmpty,
});
export type PackQuota = z.infer<typeof PackQuotaSchema>;

// ── The models usable now ────────────────────────────────────────────────────────────────────────

/**
 * One model a runtime here offers, as it stands NOW: the runtime with the most quota headroom that could
 * start it, whether it can, and the command that does. The same model resold by another catalog (Claude
 * Opus 5.5 through Bedrock) is one row, served by whichever runtime has the most headroom.
 */
export const PackModelOptionSchema = z.strictObject({
  /** The model catalog its runtime reads, when it reads one. */
  provider: NonEmpty.optional(),
  model: NonEmpty,
  modelLabel: NonEmpty,
  harness: HarnessSchema,
  tier: z.enum(['best', 'balanced', 'fast']).optional(),
  efforts: z.array(NonEmpty).readonly(),
  /** The runtime to pass as `--runtime`: the ready one with the most headroom, else the first. */
  runtime: NonEmpty,
  /** How many runtimes here offer it. */
  runtimes: PositiveIntegerSchema,
  ready: z.boolean(),
  /** Present exactly when `ready` is false. */
  refusal: PackRefusalSchema.optional(),
  /** The quota headroom of the chosen runtime's login. */
  quota: PackQuotaSchema,
  /** Where the routing prompt first names it: 1 for the first model it names. Absent: not named. */
  named: PositiveIntegerSchema.optional(),
  /** The effort the routing prompt names right after it ("claude-opus-5-5 at max"), when one of its own. */
  effort: NonEmpty.optional(),
  /** The command that starts it, when it is ready. */
  command: NonEmpty.optional(),
});
export type PackModelOption = z.infer<typeof PackModelOptionSchema>;

/** `GET /v1/pack`: the settings, the routing prompt in effect, the vocabulary and the models usable now. */
export const PackViewSchema = z.strictObject({
  config: PackConfigSchema,
  routing: RoutingPromptViewSchema,
  /** Every model every catalog lists: what the editor highlights and completes. */
  models: z.array(PackFleetModelSchema).readonly(),
  /** The models a runtime here offers, the ready ones first, then by quota headroom. */
  available: z.array(PackModelOptionSchema).readonly(),
  /** Present while an accepted clean-up can be undone. */
  undo: RoutingUndoSchema.optional(),
  cleanUp: PackCleanUpStatusSchema,
});
export type PackView = z.infer<typeof PackViewSchema>;

export const PACK_PATH = '/v1/pack';
export const PACK_RECOMMEND_PATH = '/v1/pack/recommend';
export const PACK_NEW_PATH = '/v1/pack/new';

// ── Recommend ────────────────────────────────────────────────────────────────────────────────────

export const PackRecommendRequestSchema = z.strictObject({
  /** The part of the work being handed off; echoed back, never matched. */
  task: z.string().trim().min(1).max(8_000).optional(),
});
export type PackRecommendRequest = z.infer<typeof PackRecommendRequestSchema>;

/**
 * `fy recommend`: the routing prompt in effect and every model usable here now — the ready ones first,
 * then by quota headroom. The asking ferret decides with both; nothing is matched against the task.
 */
export const PackRecommendationSchema = z.strictObject({
  task: NonEmpty.optional(),
  routing: RoutingPromptViewSchema,
  available: z.array(PackModelOptionSchema).readonly(),
  /**
   * The command `fy new --auto` would try first: the first ready model the routing prompt names, else the
   * ready one with the most headroom.
   */
  next: NonEmpty.optional(),
});
export type PackRecommendation = z.infer<typeof PackRecommendationSchema>;

// ── New ──────────────────────────────────────────────────────────────────────────────────────────

export const PackNewRequestSchema = z
  .strictObject({
    task: z.string().trim().min(1).max(100_000),
    /** The ferret asking; its depth and limit apply. Absent: a top-level start by a person. */
    parent: NonEmpty.optional(),
    runtime: NonEmpty.optional(),
    model: NonEmpty.optional(),
    effort: NonEmpty.optional(),
    /**
     * Let the decision mode pick: the models the routing prompt names, in its order, then the ready one
     * with the most headroom — or Jev's order when Jev decides.
     */
    auto: z.boolean().optional(),
    cwd: NonEmpty.optional(),
    /** Run in a temporary or scratch folder anyway (`--allow-scratch`); refused `scratch_cwd` otherwise. */
    allowScratch: z.boolean().optional(),
    name: NonEmpty.max(120).optional(),
    mode: InteractionModeSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.auto === true && value.runtime !== undefined)
      context.addIssue({ code: 'custom', message: '--auto picks the runtime; do not name one', path: ['runtime'] });
    if (value.auto !== true && value.runtime === undefined)
      context.addIssue({ code: 'custom', message: 'name a --runtime, or pass --auto', path: ['runtime'] });
  });
export type PackNewRequest = z.infer<typeof PackNewRequestSchema>;

/** One candidate tried on the way to a start, in order: what it was and what came of it. */
export const PackAttemptSchema = z.strictObject({
  runtime: NonEmpty,
  model: NonEmpty.optional(),
  outcome: z.enum(['started', 'refused']),
  refusal: PackRefusalSchema.optional(),
  /** `cached`: a probe of this runtime and model answered OK moments ago, so none was run. */
  probe: z.enum(['ran', 'cached']).optional(),
  probeMs: NonNegativeIntegerSchema.optional(),
});
export type PackAttempt = z.infer<typeof PackAttemptSchema>;

/**
 * What `POST /v1/pack/new` answers. A refusal is an ANSWER, not an HTTP error, so a ferret reads the
 * closed code and every attempt from one body and falls back to the next candidate.
 *
 * `decidedBy`: `agent` — the ferret named the runtime; `routing` — `--auto` took the routing prompt's
 * order; `jev` — Jev ranked the models usable now, guided by the same prompt.
 */
export const PackNewOutcomeSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.literal('started'),
    view: SessionViewSchema,
    decidedBy: z.enum(['agent', 'routing', 'jev']),
    attempts: z.array(PackAttemptSchema).readonly(),
    /** Said when Jev was meant to decide and the routing prompt's order was used instead. */
    note: NonEmpty.optional(),
  }),
  z.strictObject({
    outcome: z.literal('refused'),
    refusal: PackRefusalSchema,
    attempts: z.array(PackAttemptSchema).readonly(),
  }),
]);
export type PackNewOutcome = z.infer<typeof PackNewOutcomeSchema>;

// ── Result and the per-ferret switch ────────────────────────────────────────────────────────────

/** `GET /v1/sessions/:sessionId/result`: what a finished ferret reported with `signal done`. */
export const SessionResultSchema = z.strictObject({
  id: NonEmpty,
  status: NonEmpty,
  finished: z.boolean(),
  finishedAt: InstantSchema.optional(),
  /** The `signal done` message, verbatim. Absent when it gave none, or has not finished. */
  summary: z.string().optional(),
});
export type SessionResult = z.infer<typeof SessionResultSchema>;

/** `PATCH /v1/sessions/:sessionId/pack`. */
export const SessionPackPatchSchema = z.strictObject({ enabled: z.boolean() });
export type SessionPackPatch = z.infer<typeof SessionPackPatchSchema>;

export const SessionPackPatchResultSchema = z.strictObject({
  view: SessionViewSchema,
  restartRequired: z.boolean(),
  note: NonEmpty,
});
export type SessionPackPatchResult = z.infer<typeof SessionPackPatchResultSchema>;
