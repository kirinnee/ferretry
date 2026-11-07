/**
 * v4 Pack-mode files (4.291.5). A LOCAL copy on purpose: v5 has no v4 reader. Sources, at v4.291.5 (origin/main):
 *
 * - `config/pack.yaml`: `PackFileSchema` (`packages/protocol/src/lib/pack.ts:82`), strict, every key optional, plus the
 *   deprecated `routingPreferences` the one-time routing migration folded into the prompt.
 * - `config/models-guide.yaml`: `ModelsGuideFileSchema` (`pack.ts:165`): `{prompt?, suggested?}` and the old guide's
 *   `useCases`/`routing`/`models`, read and folded once; `suggested.partial` read and ignored.
 * - `config/routing.json`: `RoutingCatalogSchema` (`packages/daemon/src/lib/core/catalog.ts:128-163`), the account
 *   recommender's doctrine, read by `FileRoutingCatalog` (`adapters/core/file-routing-catalog.ts`). Accounts are named
 *   by the fleet runtime UUID (`fleet/ids.json` `runtimes[name].id`).
 * - `state/pack-guide/<runId>/`: `FileCleanUpRunStore` (`adapters/pack/cleanup-runs.ts`): `run.json`
 *   (`PackCleanUpJobResultSchema`, `protocol/src/lib/pack-cleanup.ts:168`, strict, pretty-printed, no version),
 *   `rough.txt`, `idea.txt`, `inventory.json` (`PackInventorySchema`), `draft.json` (the builder's rewrite).
 * - `state/pack-guide-replaced.json`: `FileReplacedGuide` (`cleanup-runs.ts`): `{savedAt, source, text}` where `text`
 *   is the WHOLE `models-guide.yaml` the last accept replaced, or `null` when there was no file.
 * - `state/pack-jev-spend.json` (`adapters/pack/spend-ledger.ts`) and `state/pack-routing-migration-*.json`
 *   (`FileRoutingMigrationBackup`): named only, never opened.
 * - A ferret's own switch: `pack?: boolean` in `state/sessions/<sid>/config.json` (`protocol/src/lib/session.ts:637`,
 *   absent means on).
 */
import { z } from 'zod';

export const V4_PACK_YAML = 'config/pack.yaml';
export const V4_MODELS_GUIDE_YAML = 'config/models-guide.yaml';
export const V4_ROUTING_JSON = 'config/routing.json';
export const V4_PACK_RUNS = 'state/pack-guide';
export const V4_PACK_REPLACED = 'state/pack-guide-replaced.json';
export const V4_PACK_JEV_SPEND = 'state/pack-jev-spend.json';
export const V4_ROUTING_BACKUP = /^pack-routing-migration-.+\.json$/u;

/** `cleanup-runs.ts` `RUN_ID`: what v4's `newId` (a UUID) makes; v4 listed no other folder. */
export const V4_RUN_ID = /^[A-Za-z0-9-]{1,64}$/u;

/** The files a v4 run folder holds (`lib/pack/cleanup/service.ts:90-93`). */
export const V4_RUN_FILES = {
  run: 'run.json',
  rough: 'rough.txt',
  idea: 'idea.txt',
  inventory: 'inventory.json',
  draft: 'draft.json',
} as const;

/** v4's `DEFAULT_PACK_CONFIG` (`pack.ts`): what a machine with no `pack.yaml` behaved as. */
export const V4_DEFAULT_PACK_CONFIG = {
  enabled: true,
  decision: 'agent',
  limits: { interactiveChildren: 20, autoChildren: 4, maxDepth: 2 },
  probe: { timeoutSeconds: 45, cacheSeconds: 180 },
  jev: { usdPerDay: 0.25 },
} as const;

/** The old guide's keys in `models-guide.yaml` (`isLegacyModelsGuide`). */
export const V4_LEGACY_GUIDE_KEYS = ['useCases', 'routing', 'models'] as const;

const Instant = z.iso.datetime({ offset: true });
const NonEmpty = z.string().min(1);

/** v4's `PackCleanUpJobSchema`: the clean-up ferret is `session`. */
export const V4CleanUpJob = z.strictObject({
  id: NonEmpty.max(64),
  session: NonEmpty,
  name: NonEmpty,
  mode: z.enum(['clean-up', 'generate']).optional(),
  runtime: NonEmpty,
  model: NonEmpty.optional(),
  startedAt: Instant,
  status: z.enum(['running', 'suggested', 'failed']),
  message: NonEmpty.optional(),
});

/** v4's `PackCleanUpJobResultSchema`, with the suggestion left to the v5 schema (v4's and v5's are the same shape). */
export const V4CleanUpRun = z.strictObject({
  job: V4CleanUpJob,
  suggestion: z.record(z.string(), z.unknown()).optional(),
});
export type V4CleanUpRun = z.infer<typeof V4CleanUpRun>;

/** v4's `ReplacedGuideSchema` (`RoutingUndoSchema.extend({text})`), strict: a document that does not read is no undo. */
export const V4ReplacedGuide = z.strictObject({
  savedAt: Instant,
  source: z.enum(['file', 'default']),
  text: z.string().nullable(),
});

/**
 * The parts of v4's `RoutingCatalogSchema` this tool names in the report: how many models, and each account's id and
 * whether it was excluded or preferred. Read leniently: a catalog v4 refused is reported as such, never quoted.
 */
export const V4RoutingCatalog = z.object({
  models: z.array(z.unknown()).min(1),
  accounts: z
    .array(
      z.object({
        accountId: NonEmpty,
        preferredSpend: z.boolean().optional(),
        excludedReason: NonEmpty.optional(),
        options: z.array(z.unknown()).optional(),
      }),
    )
    .optional(),
});

/** A ferret's own Pack switch in its v4 `config.json`. */
export const V4SessionPack = z.object({ pack: z.boolean().optional(), updatedAt: Instant });
