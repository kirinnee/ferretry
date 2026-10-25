/**
 * CLEAN UP — THE ROUTING PROMPT'S ONLY GENERATOR (docs/pack-mode.md § Clean up): a short-lived, hidden
 * ferret is given the owner's current rough prompt and this machine's harness inventory — every runtime,
 * the models each offers, whether each can start now and how much quota each login has left — and writes
 * the prompt back rewritten to fit, with notes. A person reviews it as a before/after text diff and accepts
 * or discards it; nothing is ever applied unasked.
 *
 * - `GET /v1/pack/inventory` — what the clean-up ferret is shown ({@link PackInventory}).
 * - `POST /v1/pack/routing/clean-up` — start the clean-up ferret; only when a person asks.
 * - `GET /v1/pack/routing/jobs/:jobId` — the run, and its checked rewrite once it is written.
 * - `POST /v1/pack/routing/accept` — write the reviewed prompt, keeping the one it replaces.
 * - `POST /v1/pack/routing/undo` — put the replaced prompt back.
 *
 * The text diff is here, pure, so `fy guide clean-up` and the app review a rewrite the same way.
 *
 * Data only: model ids, runtime and login NAMES, readiness and quota — never a credential or a value.
 */
import { z } from 'zod';
import { InstantSchema } from './common.ts';
import {
  MAX_ROUGH_PROMPT_CHARS,
  PackBuilderModeSchema,
  PackCleanUpJobSchema,
  PackQuotaSchema,
  PackRefusalSchema,
  RoutingPromptSchema,
  RoutingPromptViewSchema,
  RoutingSuggestedSchema,
} from './pack.ts';
import { HarnessSchema } from './session.ts';

const NonEmpty = z.string().min(1);

export const PACK_INVENTORY_PATH = '/v1/pack/inventory';
export const PACK_CLEAN_UP_PATH = '/v1/pack/routing/clean-up';
export const PACK_CLEAN_UP_JOBS_PATH = '/v1/pack/routing/jobs';
export const PACK_ROUTING_ACCEPT_PATH = '/v1/pack/routing/accept';
export const PACK_ROUTING_UNDO_PATH = '/v1/pack/routing/undo';

/**
 * The label a clean-up ferret's session carries, so every surface can hide it from the normal list. The
 * value is the old guide builder's, so a builder session from before is hidden the same way.
 */
export const PACK_CLEAN_UP_LABEL = 'ferretry-guide-builder';

// ── The inventory ───────────────────────────────────────────────────────────────────────────────

/** One runtime on this machine: its CLI, the catalog its login reads, whether it can start now, its quota. */
export const PackInventoryRuntimeSchema = z.strictObject({
  name: NonEmpty,
  harness: HarnessSchema,
  /** The model catalog its login reads, when it reads one. */
  provider: NonEmpty.optional(),
  /** Its login's id — a name, never a credential. */
  login: NonEmpty,
  ready: z.boolean(),
  /** Why it cannot start a ferret now, exactly as `fy recommend` would refuse it. */
  refusal: PackRefusalSchema.optional(),
  quota: PackQuotaSchema,
  /** The model ids it offers. */
  models: z.array(NonEmpty).readonly(),
});
export type PackInventoryRuntime = z.infer<typeof PackInventoryRuntimeSchema>;

/** One model a catalog lists: names, tier, context and efforts — and the runtimes here that run it. */
export const PackInventoryModelSchema = z.strictObject({
  provider: NonEmpty,
  harness: HarnessSchema,
  id: NonEmpty,
  label: NonEmpty,
  tier: z.enum(['best', 'balanced', 'fast']),
  context: z.number().int().positive().optional(),
  efforts: z.array(NonEmpty).readonly(),
  /** Every runtime here that runs it, ready or not. Empty: no runtime here runs it. */
  runtimes: z.array(z.strictObject({ name: NonEmpty, ready: z.boolean() })).readonly(),
});
export type PackInventoryModel = z.infer<typeof PackInventoryModelSchema>;

/** `GET /v1/pack/inventory`: the harness config as names and states, and the routing prompt in effect. */
export const PackInventorySchema = z.strictObject({
  at: InstantSchema,
  runtimes: z.array(PackInventoryRuntimeSchema).readonly(),
  models: z.array(PackInventoryModelSchema).readonly(),
  routing: RoutingPromptViewSchema,
});
export type PackInventory = z.infer<typeof PackInventorySchema>;

// ── Clean up ────────────────────────────────────────────────────────────────────────────────────

/** A prompt as an owner hands it to Clean up: rough, and allowed to be longer than a saved one. */
export const RoughPromptSchema = z.string().trim().min(1).max(MAX_ROUGH_PROMPT_CHARS);

/**
 * The most a "your idea" for Write it for me may say: several paragraphs of intent, but still a note
 * for the writer rather than a second routing prompt (which Clean up takes up to `MAX_ROUGH_PROMPT_CHARS`).
 */
export const MAX_IDEA_CHARS = 4_000;

/**
 * What a daemon without the `pack.idea.4000` feature still refuses past. The app keeps this limit for
 * such a machine, because the app deploys before the daemon does (`daemon-features.ts`).
 */
export const LEGACY_MAX_IDEA_CHARS = 500;

/** The idea an owner hands Write it for me, line breaks kept; may be absent, which asks for a sensible default. */
export const IdeaSchema = z.string().trim().min(1).max(MAX_IDEA_CHARS);

export const PackCleanUpRequestSchema = z.strictObject({
  /** `clean-up` (default) rewrites the owner's prompt; `generate` writes one from `idea` and what is here. */
  mode: PackBuilderModeSchema.optional(),
  /** `generate` only: what the owner wants, in their words ("cheap models for chores, Opus for planning"). */
  idea: IdeaSchema.optional(),
  /**
   * The owner's current rough prompt. `clean-up`: absent means the prompt in effect. `generate`: absent
   * means the prompt saved, if the owner saved one — a default is not an owner's prompt to build on.
   */
  prompt: RoughPromptSchema.optional(),
  /** The runtime the clean-up ferret runs on; absent: the ready one with the most headroom. */
  runtime: NonEmpty.max(128).optional(),
  /** The model it runs on; absent: the runtime's own default. */
  model: NonEmpty.max(128).optional(),
});
export type PackCleanUpRequest = z.infer<typeof PackCleanUpRequestSchema>;

export const PackCleanUpStartSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('started'), job: PackCleanUpJobSchema }),
  /** Nothing was started: no runtime is ready, or the one named cannot run now. */
  z.strictObject({ outcome: z.literal('refused'), message: NonEmpty }),
]);
export type PackCleanUpStart = z.infer<typeof PackCleanUpStartSchema>;

/** What the clean-up ferret writes, read leniently so a nearly-right rewrite is checked, not refused whole. */
export const PackCleanUpDraftSchema = z.looseObject({
  prompt: z.string(),
  notes: z.array(z.unknown()).optional(),
});
export type PackCleanUpDraft = z.infer<typeof PackCleanUpDraftSchema>;

/** The most notes a rewrite carries, and the most one note says. */
export const MAX_CLEAN_UP_NOTES = 12;
export const MAX_CLEAN_UP_NOTE_CHARS = 300;

/**
 * One note on a rewrite. `unknown_model`: the rewrite names a model-like word no catalog lists.
 * `absent_model`: it names a model no runtime here runs. `cut`: it was too long and was cut to fit.
 * `suggestion`: the clean-up ferret's own advice (a login to add, a model to try), in its words.
 */
export const PackCleanUpNoteSchema = z.strictObject({
  kind: z.enum(['unknown_model', 'absent_model', 'cut', 'suggestion']),
  message: NonEmpty.max(MAX_CLEAN_UP_NOTE_CHARS + 80),
  model: NonEmpty.max(128).optional(),
});
export type PackCleanUpNote = z.infer<typeof PackCleanUpNoteSchema>;

/** A checked rewrite, ready to review against the prompt it was made from. */
export const PackCleanUpSuggestionSchema = z.strictObject({
  /** Who rewrote it and when; the accept adds when it was accepted. */
  suggested: RoutingSuggestedSchema.omit({ acceptedAt: true, partial: true }),
  /** The rough prompt it was given; empty when `generate` had none to build on. */
  before: z.string().trim().max(MAX_ROUGH_PROMPT_CHARS),
  /** The rewrite, within the routing prompt's limit. */
  after: RoutingPromptSchema,
  notes: z.array(PackCleanUpNoteSchema).readonly(),
});
export type PackCleanUpSuggestion = z.infer<typeof PackCleanUpSuggestionSchema>;

/** `GET /v1/pack/routing/jobs/:jobId`: the run, and its suggestion once it has one. */
export const PackCleanUpJobResultSchema = z.strictObject({
  job: PackCleanUpJobSchema,
  suggestion: PackCleanUpSuggestionSchema.optional(),
});
export type PackCleanUpJobResult = z.infer<typeof PackCleanUpJobResultSchema>;

// ── Accept, undo ────────────────────────────────────────────────────────────────────────────────

export const PackRoutingAcceptRequestSchema = z.strictObject({
  /** The prompt to write: the rewrite as reviewed. */
  prompt: RoutingPromptSchema,
  suggested: RoutingSuggestedSchema.omit({ acceptedAt: true, partial: true }),
});
export type PackRoutingAcceptRequest = z.infer<typeof PackRoutingAcceptRequestSchema>;

export const PackRoutingWriteResultSchema = z.strictObject({
  /** `nothing`: there was nothing to do (an undo with no replaced prompt kept). */
  outcome: z.enum(['applied', 'nothing']),
  message: NonEmpty,
});
export type PackRoutingWriteResult = z.infer<typeof PackRoutingWriteResultSchema>;

// ── The before/after diff ───────────────────────────────────────────────────────────────────────

/** One run of a word diff: text both share, text only the before has, text only the after has. */
export interface TextDiffPart {
  readonly kind: 'same' | 'removed' | 'added';
  readonly text: string;
}

/** Words and the whitespace after each, so joining a side's parts gives that side back exactly. */
const tokens = (text: string): readonly string[] => text.match(/\S+\s*|\s+/gu) ?? [];

/** The most tokens a side may have before the diff stops looking for shared words and replaces it whole. */
const MAX_DIFF_TOKENS = 2_000;

/**
 * A word-level diff of two prompts (a longest common subsequence of words, whitespace aside): joining the
 * `same` and `added` parts gives `after` back exactly, and `same` and `removed` gives `before` up to its
 * spacing. Adjacent parts of a kind are merged, so a renderer shows one run per change.
 */
export function diffText(before: string, after: string): readonly TextDiffPart[] {
  const left = tokens(before);
  const right = tokens(after);
  const parts: TextDiffPart[] = [];
  const push = (kind: TextDiffPart['kind'], text: string): void => {
    const last = parts.at(-1);
    if (last?.kind === kind) parts[parts.length - 1] = { kind, text: last.text + text };
    else if (text !== '') parts.push({ kind, text });
  };
  if (left.length > MAX_DIFF_TOKENS || right.length > MAX_DIFF_TOKENS) {
    push('removed', before);
    push('added', after);
    return parts;
  }
  // Compared without trailing whitespace, so a reflowed line is not a change of every word on it.
  const word = (token: string): string => token.trimEnd();
  const width = right.length + 1;
  const table = new Uint16Array((left.length + 1) * width);
  for (let i = left.length - 1; i >= 0; i -= 1)
    for (let j = right.length - 1; j >= 0; j -= 1)
      table[i * width + j] =
        word(left[i] as string) === word(right[j] as string)
          ? (table[(i + 1) * width + j + 1] as number) + 1
          : Math.max(table[(i + 1) * width + j] as number, table[i * width + j + 1] as number);
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const l = left[i] as string;
    const r = right[j] as string;
    if (word(l) === word(r)) {
      push('same', r);
      i += 1;
      j += 1;
    } else if ((table[(i + 1) * width + j] as number) >= (table[i * width + j + 1] as number)) {
      push('removed', l);
      i += 1;
    } else {
      push('added', r);
      j += 1;
    }
  }
  for (; i < left.length; i += 1) push('removed', left[i] as string);
  for (; j < right.length; j += 1) push('added', right[j] as string);
  return parts;
}
