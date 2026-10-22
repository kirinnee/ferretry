/**
 * PACK MODE — a ferret delegates to sub-ferrets and picks the model each one runs on (docs/pack-mode.md).
 *
 * Two configuration files (docs/config-files.md) and four routes:
 *
 * - `pack.yaml` — the machine's switch, who decides the model (the agent, or Jev), the sub-ferret limits
 *   and the start probe. {@link PackConfig}.
 * - `models-guide.yaml` — use cases and, for each, the models that suit it, best first. Human-edited;
 *   absent means the guide DERIVED from the model catalogs in effect. {@link ModelsGuide}.
 * - `POST /v1/pack/recommend` — the candidates usable on this machine NOW for one task.
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

/** Who picks the model a sub-ferret runs on: the asking ferret, or Jev ranking the guide's candidates. */
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

/** The most an owner's routing preferences may say: a paragraph or two, never a document. */
export const MAX_ROUTING_PREFERENCES_CHARS = 4_000;

/**
 * The owner's routing preferences, in their own words ("keep Opus for reviews; GLM for bulk work"). Read
 * only by the guide builder (`fy guide suggest`), which drafts a guide with them; never a rule the
 * daemon enforces.
 */
export const RoutingPreferencesSchema = z.string().trim().max(MAX_ROUTING_PREFERENCES_CHARS);

export const PackConfigSchema = z.strictObject({
  /** The machine's switch. Off: no ferret is told about Pack mode and `fy new` refuses `pack_off`. */
  enabled: z.boolean(),
  decision: PackDecisionModeSchema,
  limits: PackLimitsSchema,
  probe: PackProbeSchema,
  jev: PackJevSchema,
  routingPreferences: RoutingPreferencesSchema.optional(),
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
  routingPreferences: RoutingPreferencesSchema.optional(),
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
    ...(file.routingPreferences === undefined || file.routingPreferences === ''
      ? {}
      : { routingPreferences: file.routingPreferences }),
  };
}

// ── models-guide.yaml ────────────────────────────────────────────────────────────────────────────

/** A use case's id: lowercase words joined by dashes, so a ferret can name one (`--use-case bulk`). */
export const GuideUseCaseIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,39}$/u, 'a use case id is lowercase letters, digits and dashes');

export const MAX_GUIDE_TEXT_CHARS = 1_000;
export const MAX_GUIDE_USE_CASES = 24;
export const MAX_GUIDE_CANDIDATES = 12;

/**
 * One model that suits a use case: the catalog it comes from (`anthropic`, `openai`, `zai`, … — the
 * provider), the model id that catalog lists, the effort to run it at, and why.
 */
export const GuideCandidateSchema = z.strictObject({
  provider: NonEmpty.max(64),
  model: NonEmpty.max(128),
  /** The CLI, when the provider's catalog lists the model for both. */
  harness: HarnessSchema.optional(),
  effort: NonEmpty.max(32).optional(),
  why: z.string().trim().min(1).max(MAX_GUIDE_TEXT_CHARS),
});
export type GuideCandidate = z.infer<typeof GuideCandidateSchema>;

export const GuideUseCaseSchema = z.strictObject({
  id: GuideUseCaseIdSchema,
  title: z.string().trim().min(1).max(80),
  /**
   * What the use case covers, in the owner's words. Model names in it are recognised by the editor
   * and are matched against a task by `fy recommend`.
   */
  description: z.string().trim().min(1).max(MAX_GUIDE_TEXT_CHARS),
  /** Extra words a task may use for it ("rename", "migrate"). */
  keywords: z.array(z.string().trim().min(1).max(40)).max(32).optional(),
  candidates: z.array(GuideCandidateSchema).max(MAX_GUIDE_CANDIDATES),
});
export type GuideUseCase = z.infer<typeof GuideUseCaseSchema>;

export const MAX_ROUTING_PROMPT_CHARS = 6_000;
/**
 * The short form rides in every Pack ferret's system prompt, whose whole is held under 4.5 KB with every
 * section on (docs/pack-mode.md), so it is one short line.
 */
export const MAX_ROUTING_SHORT_CHARS = 150;

/**
 * How to pick a sub-ferret's model and effort, in plain words. `prompt` is the whole of it — printed by
 * `fy recommend` and given to Jev as its guidance; `short` is one line for the Pack section of every
 * ferret's system prompt, with no quote, backslash or control character, so it sits inside any harness's
 * quoting unchanged.
 */
export const GuideRoutingSchema = z.strictObject({
  prompt: z.string().trim().min(1).max(MAX_ROUTING_PROMPT_CHARS),
  short: z
    .string()
    .trim()
    .min(1)
    .max(MAX_ROUTING_SHORT_CHARS)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it refuses
    .regex(/^[^"\\\u0000-\u001f\u007f]*$/u, 'the short routing line is one line, without a quote or a backslash'),
});
export type GuideRouting = z.infer<typeof GuideRoutingSchema>;

/** The most models a guide may describe. */
export const MAX_MODEL_DESCRIPTIONS = 400;

/**
 * The owner's description of one model, in their own words — strengths, weaknesses, what it costs, when to
 * use or avoid it. The input a guide is built from (`fy guide describe`, Settings › Pack › Models). A model
 * the owner never described is described by its catalog: its note, tier and context window.
 */
export const ModelDescriptionSchema = z.strictObject({
  provider: NonEmpty.max(64),
  model: NonEmpty.max(128),
  description: z.string().trim().min(1).max(MAX_GUIDE_TEXT_CHARS),
});
export type ModelDescription = z.infer<typeof ModelDescriptionSchema>;

/**
 * Where an accepted guide came from: the model that drafted it, what ran that model, and when it was
 * suggested and accepted. Pack mode only reports it (`fy recommend`); a hand-written guide has none.
 */
export const GuideSuggestedSchema = z.strictObject({
  /** The model that drafted it, as its runtime named it. */
  by: NonEmpty.max(128),
  /** What ran it: the runtime on this machine. */
  via: NonEmpty.max(128),
  at: InstantSchema,
  acceptedAt: InstantSchema,
  /** Some of its use cases were accepted and the rest kept as they were. */
  partial: z.boolean().optional(),
});
export type GuideSuggested = z.infer<typeof GuideSuggestedSchema>;

/**
 * `models-guide.yaml`. `useCases` absent means the DERIVED guide; present (even empty) is the owner's.
 * Duplicate use case ids are refused: a ferret names one by id.
 */
export const ModelsGuideFileSchema = z
  .strictObject({
    useCases: z.array(GuideUseCaseSchema).max(MAX_GUIDE_USE_CASES).optional(),
    /** How to pick a model, in words; absent means the one rendered from the use cases. */
    routing: GuideRoutingSchema.optional(),
    /** The owner's description of each model they described. */
    models: z.array(ModelDescriptionSchema).max(MAX_MODEL_DESCRIPTIONS).optional(),
    suggested: GuideSuggestedSchema.optional(),
  })
  .superRefine((value, context) => {
    const described = new Set<string>();
    for (const [index, entry] of (value.models ?? []).entries()) {
      const key = `${entry.provider}\u0000${entry.model}`;
      if (described.has(key))
        context.addIssue({
          code: 'custom',
          message: `${entry.provider} ${entry.model} is described twice`,
          path: ['models', index, 'model'],
        });
      described.add(key);
    }
    const seen = new Set<string>();
    for (const [index, useCase] of (value.useCases ?? []).entries()) {
      if (seen.has(useCase.id))
        context.addIssue({
          code: 'custom',
          message: `use case "${useCase.id}" appears twice`,
          path: ['useCases', index, 'id'],
        });
      seen.add(useCase.id);
    }
  });
export type ModelsGuideFile = z.infer<typeof ModelsGuideFileSchema>;

/** What a machine with no `models-guide.yaml` has: nothing written, so the derived guide is in effect. */
export const DEFAULT_MODELS_GUIDE_FILE: ModelsGuideFile = {};

export const ModelsGuideSchema = z.strictObject({
  /** `file`: the owner's `models-guide.yaml`. `derived`: built from the model catalogs in effect. */
  source: z.enum(['file', 'derived']),
  useCases: z.array(GuideUseCaseSchema).readonly(),
  /**
   * How to pick a model, in words: the file's (`file`), or rendered from the use cases in effect
   * (`derived`). Absent from a daemon that predates it.
   */
  routing: GuideRoutingSchema.extend({ source: z.enum(['file', 'derived']) }).optional(),
  /** The suggestion the file's guide was accepted from, when it says. */
  suggested: GuideSuggestedSchema.optional(),
});
export type ModelsGuide = z.infer<typeof ModelsGuideSchema>;

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
  /** What the guide builder is told about it: the owner's words, else the catalog's. */
  description: NonEmpty.optional(),
  describedBy: z.enum(['owner', 'catalog']).optional(),
});
export type PackFleetModel = z.infer<typeof PackFleetModelSchema>;

/** The guide an accept replaced, kept so `fy guide undo` (or Undo in the editor) can put it back. */
export const GuideUndoSchema = z.strictObject({
  savedAt: InstantSchema,
  /** `derived`: there was no guide of the owner's, so undoing removes the use cases again. */
  source: z.enum(['file', 'derived']),
});
export type GuideUndo = z.infer<typeof GuideUndoSchema>;

/**
 * One run of the guide builder: a short-lived, hidden ferret (`fy guide suggest`, Suggest a guide). It is
 * `running` until its draft is written and read, then `suggested` or `failed`.
 */
export const PackGuideJobSchema = z.strictObject({
  id: NonEmpty.max(64),
  /** The builder ferret's session id. */
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
export type PackGuideJob = z.infer<typeof PackGuideJobSchema>;

/** Whether a guide can be built here now, and on what: the ready agent runtimes, the best first. */
export const PackGuideBuilderSchema = z.strictObject({
  available: z.boolean(),
  runtimes: z.array(NonEmpty).readonly(),
  /** Why not, when it is not available. */
  reason: NonEmpty.optional(),
  /** The newest builder run, so a reopened page finds it. */
  job: PackGuideJobSchema.optional(),
});
export type PackGuideBuilder = z.infer<typeof PackGuideBuilderSchema>;

/** `GET /v1/pack`: the settings, the guide in effect and every model the fleet knows. */
export const PackViewSchema = z.strictObject({
  config: PackConfigSchema,
  guide: ModelsGuideSchema,
  models: z.array(PackFleetModelSchema).readonly(),
  /** Present while an accepted suggestion can be undone. */
  undo: GuideUndoSchema.optional(),
  /** Absent from a daemon that predates the guide builder. */
  builder: PackGuideBuilderSchema.optional(),
});
export type PackView = z.infer<typeof PackViewSchema>;

export const PACK_PATH = '/v1/pack';
export const PACK_RECOMMEND_PATH = '/v1/pack/recommend';
export const PACK_NEW_PATH = '/v1/pack/new';

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
 * - `no_candidate`: nothing in the guide can run here now.
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

// ── Recommend ────────────────────────────────────────────────────────────────────────────────────

export const PackRecommendRequestSchema = z.strictObject({
  task: z.string().trim().min(1).max(8_000),
  /** Name a use case instead of letting the task's words choose one. */
  useCase: GuideUseCaseIdSchema.optional(),
});
export type PackRecommendRequest = z.infer<typeof PackRecommendRequestSchema>;

/** One way to run the task: a guide candidate resolved to a runtime here, or why it cannot be. */
export const PackCandidateSchema = z.strictObject({
  rank: PositiveIntegerSchema,
  provider: NonEmpty,
  model: NonEmpty,
  modelLabel: NonEmpty.optional(),
  harness: HarnessSchema.optional(),
  effort: NonEmpty.optional(),
  why: NonEmpty,
  /** The runtime to pass as `--runtime`, when one here offers the model. */
  runtime: NonEmpty.optional(),
  ready: z.boolean(),
  /** Present exactly when `ready` is false. */
  refusal: PackRefusalSchema.optional(),
  /** The quota headroom of the login of the runtime it resolved to. */
  quota: PackQuotaSchema.optional(),
  /** Why live quota put this candidate below the guide's place for it ("91% of the week used"). */
  movedDown: NonEmpty.optional(),
});
export type PackCandidate = z.infer<typeof PackCandidateSchema>;

export const PackRecommendationSchema = z.strictObject({
  task: NonEmpty,
  useCase: z.strictObject({
    id: GuideUseCaseIdSchema,
    title: NonEmpty,
    matchedBy: z.enum(['named', 'words', 'fallback']),
  }),
  guideSource: z.enum(['file', 'derived']),
  /** The suggestion the guide was accepted from, when it says. */
  guideSuggested: GuideSuggestedSchema.optional(),
  /** How to pick, in the guide's words: the whole routing prompt, current as of this answer. */
  routing: NonEmpty.optional(),
  /** Ready ones first, then by quota headroom, each group in the guide's order. */
  candidates: z.array(PackCandidateSchema).readonly(),
  /** The command that starts the first ready candidate, so a ferret can copy it. */
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
    /** Let the decision mode pick: the guide's first ready candidate, or Jev's when Jev decides. */
    auto: z.boolean().optional(),
    useCase: GuideUseCaseIdSchema.optional(),
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
 */
export const PackNewOutcomeSchema = z.discriminatedUnion('outcome', [
  z.strictObject({
    outcome: z.literal('started'),
    view: SessionViewSchema,
    decidedBy: z.enum(['agent', 'guide', 'jev']),
    attempts: z.array(PackAttemptSchema).readonly(),
    /** Said when Jev was meant to decide and the guide's order was used instead. */
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
