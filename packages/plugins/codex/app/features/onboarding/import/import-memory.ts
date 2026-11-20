/**
 * What the Codex import pages remember between themselves, and the one `setup.import` change they end in. The memory is the
 * plugin's SEGMENT memory (`StepHost.segment`): this run only, in memory, never browser storage. Each kind page leaves one
 * entry (`review.<kind>`) saying what the person left out there; the run page reads them all.
 *
 * A kind with no entry was never shown in this run (a reload, a failed scan on its page, a page passed over): it is NOT left out,
 * because only what a shown page unticked is a person's exclusion. The run page says which kinds were not looked at. Pure: names and ids only, never a value.
 */
import type { StepHost } from '../onboarding-api.ts';
import { type ImportItemId, ImportItemIdSchema } from '@ferretry/plugin-runtimes/contract';
import {
  buildImportChange,
  IMPORT_KINDS,
  type ImportKind,
  kindItemIds,
  type ToolModel,
} from '@ferretry/plugin-runtimes/import-kit';
import { z } from 'zod';

/** The step each kind's page is, and back. */
export const STEP_OF_KIND: Readonly<Record<ImportKind, string>> = {
  settings: 'import-settings',
  'model-set': 'import-model-set',
  instructions: 'import-instructions',
  skills: 'import-skills',
  mcp: 'import-mcp',
};
export const KIND_OF_STEP: Readonly<Record<string, ImportKind>> = Object.fromEntries(
  IMPORT_KINDS.map(kind => [STEP_OF_KIND[kind], kind]),
);

/** What each kind is called to the person (also the run page's summary). */
export const KIND_WORDS: Readonly<Record<ImportKind, string>> = {
  settings: 'Settings',
  'model-set': 'Models',
  instructions: 'AGENTS.md',
  skills: 'Skills',
  mcp: 'MCP servers',
};

/** One kind page's answer: the ids left unticked, and the GitHub-token variables ticked (settings page only). */
export interface Review {
  readonly left: readonly ImportItemId[];
  readonly env: readonly string[];
}

const ReviewSchema = z.strictObject({
  left: z.array(ImportItemIdSchema).max(512),
  env: z.array(z.string().min(1).max(200)).max(16),
});

const reviewKey = (kind: ImportKind): string => `review.${kind}`;

/** The review a kind page left, or `undefined` when it never did (or what is held is not a review). */
export function reviewOf(segment: StepHost['segment'], kind: ImportKind): Review | undefined {
  const held = segment[reviewKey(kind)];
  if (typeof held !== 'string') return undefined;
  try {
    const parsed = ReviewSchema.safeParse(JSON.parse(held));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** Leaves a kind page's answer in the segment memory. */
export const rememberReview = (step: StepHost, kind: ImportKind, review: Review): void =>
  step.remember({ [reviewKey(kind)]: JSON.stringify(review) });

/** The scan this run reads: one key per run, held in the segment memory so every page asks the same store. */
export const RUN_KEY = 'scanRun';
export const newRunKey = (): string => `codex-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * How this run imports. `recovered` is a run whose `importMode` is missing (a reload dropped the run's memory): nothing was
 * chosen in THIS run, so the kind pages show their checklists as in Customize and the run page builds its plan from what
 * they answered.
 */
export type ImportMode = 'everything' | 'choose' | 'recovered';

/** The mode when something is imported; `undefined` only for `fresh`, which the person chose in this run. */
export const importingMode = (segment: StepHost['segment']): ImportMode | undefined => {
  const said = segment.importMode;
  if (said === 'fresh') return undefined;
  return said === 'everything' || said === 'choose' ? said : 'recovered';
};

export interface ImportPlan {
  /** The one change the run page applies. */
  readonly change: ReturnType<typeof buildImportChange>;
  /** Kinds that had things to bring but whose checklist was never shown in this run: not left out, only said. */
  readonly unreviewed: readonly ImportKind[];
  /** The changed sources taken again (`everything` only): the person is not asked about them one by one. */
  readonly updates: number;
  /** The ids that will be brought, per kind (what the run page counts). */
  readonly taken: Readonly<Record<ImportKind, number>>;
}

const MODEL_SET_ID = (model: ToolModel): ImportItemId => `${model.harness}:model-set`;
const SETTINGS_ID = (model: ToolModel): ImportItemId => `${model.harness}:settings`;

/**
 * The change for what was chosen. `everything` leaves nothing out. `choose` leaves out what each page's person unticked, and
 * nothing more: a kind whose checklist was never shown (a reload, a scan that failed on its page) is not a person's exclusion,
 * so it adds no skip and takes no dependent with it. Leaving the settings out on their shown page also leaves out the models
 * those settings name (what the r9 wizard does for the same choice), and only a GitHub-token variable the person ticked is brought, and only while the
 * environment itself is.
 */
export function importPlan(model: ToolModel, mode: ImportMode, segment: StepHost['segment'], name: string): ImportPlan {
  const skip = new Set<ImportItemId>();
  const unreviewed: ImportKind[] = [];
  const tokens: string[] = [];
  const taken = Object.fromEntries(IMPORT_KINDS.map(kind => [kind, 0])) as Record<ImportKind, number>;
  for (const kind of IMPORT_KINDS) {
    const ids = kindItemIds(model, kind);
    const review = mode === 'everything' ? { left: [], env: [] } : reviewOf(segment, kind);
    if (review === undefined) {
      // A kind whose checklist was never shown (a reload, a scan that failed there, a page passed over) is NOT an exclusion:
      // nobody left it out, so it adds no skip and drags none of its dependents (env, models) into the skip list. The run
      // page says it was not looked at instead.
      if (mode !== 'everything' && ids.length > 0) unreviewed.push(kind);
      continue;
    }
    for (const id of review.left) if (ids.includes(id)) skip.add(id);
    tokens.push(...review.env);
  }
  if (skip.has(SETTINGS_ID(model))) skip.add(MODEL_SET_ID(model));
  for (const kind of IMPORT_KINDS) taken[kind] = kindItemIds(model, kind).filter(id => !skip.has(id)).length;
  const env = model.groups.find(group => group.key === 'env');
  const tickedEnv = skip.has(`${model.harness}:env`)
    ? []
    : tokens.filter(token => env?.githubTokens?.includes(token) === true);
  const acceptedUpdates = mode === 'everything' ? model.updates.map(update => update.reference) : [];
  const change = buildImportChange(model.harness, [model.harness], skip, model.duplicateOf === null ? name : '', {
    tickedEnv,
    acceptedUpdates,
  });
  return { change, unreviewed, taken, updates: acceptedUpdates.length };
}

/** A runtime name the daemon takes: not empty, not longer than 200 (the wizard's own rule). */
export const nameProblem = (name: string): string | null => {
  const text = name.trim();
  if (text === '') return 'Give the runtime a name.';
  return text.length > 200 ? 'That name is too long.' : null;
};
