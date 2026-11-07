import { defineEvent, defineHook, definePort, defineState, type FerretId } from '@ferretry/kernel/contract';
import { type Brand, InstantSchema, KEBAB_NAME } from '@ferretry/std';
import { z } from 'zod';

/**
 * `@ferretry/core-asks/contract` (§2.2, §7.4): every question for the owner and every answer, with a GENERIC source
 * envelope. No plugin's ids live here: a source registers the schema of its own `ref` through `ask.sources`, and Asks
 * parses `ref` with it on raise and on read ("source unavailable" when that plugin is later off). Answering is
 * owner-only and happens only through Asks' own route; the port has no answer method, so no plugin and no ferret can
 * answer through it (a ferret must never answer its own secret ask).
 *
 * Limits and kinds are today's agenda (`protocol/src/lib/agenda.ts`); the words are §1's (ask, notice, answer).
 */

// ─── ids ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * An ask's id, `A12`, as `!A12` references it (today's `AgendaIdSchema`). Numbered per ferret's board (lead decision
 * #13): unique only together with its ferret, so every call names an {@link AskRef}.
 */
export type AskId = Brand<string, 'AskId'>;
export const AskIdSchema = z
  .string()
  .regex(/^A[1-9][0-9]*$/u, 'an ask id is A and a number')
  .transform(value => value as AskId);

/** Which ask: its ferret's board and its id there (lead decision #13). */
export const AskRefSchema = z.strictObject({
  ferret: z.string().min(1).max(128),
  id: AskIdSchema,
});
export type AskRef = z.infer<typeof AskRefSchema>;

/** An answer's own id: each answer is applied once, by this id (§7.4 rule 4). */
export type AnswerId = Brand<string, 'AnswerId'>;
export const AnswerIdSchema = z
  .string()
  .regex(/^an_[0-9a-f]{24}$/u, 'an answer id is an_ and 24 hex digits')
  .transform(value => value as AnswerId);

/** A source: one per `ask.sources` taker (`card`, `sign-in-approval`, `question`, `input`), plus `ferret` and `daemon`. */
export type SourceKey = Brand<string, 'SourceKey'>;
export const SourceKeySchema = z
  .string()
  .regex(KEBAB_NAME)
  .max(40)
  .transform(value => value as SourceKey);

/** The two sources Asks itself owns: a ferret's own `fy ask`, and a daemon notice with no plugin behind it. */
export const BUILT_IN_SOURCES = ['ferret', 'daemon'] as const;

/** The source's own entry id (a card's gate entry, an approval id); `(source, entry)` makes a raise idempotent. */
export type EntryId = Brand<string, 'EntryId'>;
export const EntryIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,127}$/u)
  .transform(value => value as EntryId);

// ─── the envelope ─────────────────────────────────────────────────────────────────────────────────────────────────

/** The generic source envelope (§7.4): `ref` is validated by the schema the source registered. */
export const AskSourceSchema = z.strictObject({
  source: SourceKeySchema,
  ref: z.unknown(),
  entry: EntryIdSchema,
});
export type AskSource = z.infer<typeof AskSourceSchema>;

export const MAX_ASK_SUBJECT_LENGTH = 240;
export const MAX_ASK_DETAIL_LENGTH = 2_048;
export const MAX_ASK_CONTEXT_LENGTH = 64_000;
export const MAX_ASK_OPTIONS = 12;
export const MAX_ASK_OPTION_LENGTH = 120;
export const MAX_ASK_OPTION_DETAIL_LENGTH = 240;

const singleLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .regex(/^[^\r\n]*$/u, 'one line');

/** What kind of answer an ask wants (today's `AgendaKindSchema`, with `info` named `notice`). */
export const ASK_KINDS = [
  'task',
  'yesno',
  'permission',
  'choice',
  'review',
  'notice',
  'reply',
  'form',
  'input',
] as const;
export const AskKindSchema = z.enum(ASK_KINDS);
export type AskKind = z.infer<typeof AskKindSchema>;

export const AskOptionSchema = z.strictObject({
  label: singleLine(MAX_ASK_OPTION_LENGTH),
  description: singleLine(MAX_ASK_OPTION_DETAIL_LENGTH).optional(),
});
export type AskOption = z.infer<typeof AskOptionSchema>;

/** Who raised an ask. A ferret is the kernel-stamped caller, never a claimed name. */
export const AskRaiserSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ferret'), ferret: z.string().min(1).max(128) }),
  z.strictObject({ kind: z.literal('daemon') }),
  z.strictObject({ kind: z.literal('owner') }),
]);
export type AskRaiser = z.infer<typeof AskRaiserSchema>;

/** What a source hands `raise` (§7.4). */
export const AskDraftSchema = z
  .strictObject({
    ...AskSourceSchema.shape,
    kind: AskKindSchema,
    subject: singleLine(MAX_ASK_SUBJECT_LENGTH),
    why: z.string().trim().min(1).max(MAX_ASK_DETAIL_LENGTH),
    howToResolve: z.string().trim().min(1).max(MAX_ASK_DETAIL_LENGTH).optional(),
    context: z.string().max(MAX_ASK_CONTEXT_LENGTH).optional(),
    options: z.array(AskOptionSchema).min(2).max(MAX_ASK_OPTIONS).optional(),
    raisedBy: AskRaiserSchema,
    /** The ferret this ask is about (its sitrep shows it as a blocker). */
    ferret: z.string().min(1).max(128).optional(),
    /** Pings the owner. */
    blocking: z.boolean().optional(),
  })
  .superRefine((draft, context) => {
    if ((draft.kind === 'choice') !== (draft.options !== undefined))
      context.addIssue({ code: 'custom', path: ['options'], message: 'a choice names its options, and only a choice' });
    const labels = (draft.options ?? []).map(option => option.label);
    if (new Set(labels).size !== labels.length)
      context.addIssue({ code: 'custom', path: ['options'], message: 'option labels must be unique' });
  });
export type AskDraft = z.input<typeof AskDraftSchema>;

/** What an answer did (today's `AgendaAnswerEffectSchema`). */
export const ANSWER_EFFECTS = [
  'choose',
  'approve',
  'reject',
  'good',
  'clarify',
  'done',
  'needs-info',
  'dismiss',
] as const;
export const AnswerEffectSchema = z.enum(ANSWER_EFFECTS);
export type AnswerEffect = z.infer<typeof AnswerEffectSchema>;

/** Who answered: only ever the owner, at the machine or from a device (never a ferret, never the warden). */
export const AnswererSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('host') }),
  z.strictObject({ kind: z.literal('device'), holder: z.string().min(1).max(128) }),
]);
export type Answerer = z.infer<typeof AnswererSchema>;

/** One answer. Never a secret: an input card's value goes to its target through the Vault, never through here. */
export const AskAnswerSchema = z.strictObject({
  id: AnswerIdSchema,
  /** The board the ask is on: `ask` is unique only with it. */
  ferret: z.string().min(1).max(128),
  ask: AskIdSchema,
  source: SourceKeySchema,
  entry: EntryIdSchema,
  effect: AnswerEffectSchema,
  choice: singleLine(MAX_ASK_OPTION_LENGTH).optional(),
  text: z.string().trim().min(1).max(MAX_ASK_DETAIL_LENGTH).optional(),
  /** A form's plain values, by field id. */
  values: z.record(z.string().regex(/^[a-z][a-z0-9_]{0,31}$/u), z.string().max(MAX_ASK_DETAIL_LENGTH)).optional(),
  by: AnswererSchema,
  at: InstantSchema,
});
export type AskAnswer = z.infer<typeof AskAnswerSchema>;

export const ASK_STATES = ['open', 'answered', 'closed'] as const;
export const AskStateSchema = z.enum(ASK_STATES);
export type AskState = z.infer<typeof AskStateSchema>;

/** Why an ask was closed. */
export const CLOSE_REASONS = ['answered', 'withdrawn', 'superseded', 'source-gone', 'expired', 'dismissed'] as const;
export const CloseReasonSchema = z.enum(CLOSE_REASONS);
export type CloseReason = z.infer<typeof CloseReasonSchema>;

export const AskSummarySchema = z.strictObject({
  id: AskIdSchema,
  source: SourceKeySchema,
  entry: EntryIdSchema,
  kind: AskKindSchema,
  subject: z.string(),
  raisedBy: AskRaiserSchema,
  ferret: z.string().optional(),
  state: AskStateSchema,
  raisedAt: InstantSchema,
  /** The source's plugin is off or no longer registers this ref: the app shows "source unavailable". */
  sourceUnavailable: z.literal(true).optional(),
});
export type AskSummary = z.infer<typeof AskSummarySchema>;

export interface AskFilter {
  readonly source?: SourceKey;
  readonly entry?: EntryId;
  readonly ferret?: FerretId;
  readonly state?: AskState;
}

// ─── the port ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The Asks port (§7.4). `raise` is idempotent by `(source, entry)`. Effects across subsystems are owed, then
 * reconciled: a source records "owed: raise" in its own write, calls `raise`, and on `AskAnswered` reads `answers`
 * and applies each once BY ANSWER ID.
 */
export interface AsksApi {
  /** Raised on the board of the draft's `ferret`, which a raise therefore names. */
  raise(ask: AskDraft): Promise<AskRef>;
  /** A notice: something the owner should know; no answer. Idempotent by `(source, entry)`. */
  notify(notice: Omit<AskDraft, 'kind' | 'options'>): Promise<AskRef>;
  answers(
    filter: { readonly source: SourceKey; readonly entry?: EntryId },
    since?: string,
  ): Promise<readonly AskAnswer[]>;
  close(ask: AskRef, reason: CloseReason): Promise<void>;
  open(filter: AskFilter): Promise<readonly AskSummary[]>;
  get(ask: AskRef): Promise<AskSummary | undefined>;
}

export const AsksPort = definePort<AsksApi>('asks');

/** What a source registers under `ask.sources:<key>` (§7.4). */
export interface AskSourceSpec {
  /** Parses this source's `ref`; a strict object. */
  readonly schema: z.ZodType;
  /** The card title template, `{field}` filled from the ref (`Card {card}`). */
  readonly title: string;
  /** Whether an answer carries form values. */
  readonly form: boolean;
  /**
   * Applies the owner's answer in the source's own world BEFORE the ask is marked answered (lead decision #13; the
   * #1552 order: the card moves first). A refusal leaves the ask open and is the sentence the owner is told. Absent,
   * an answer is owed and the source reconciles on {@link AskAnswered}.
   */
  readonly apply?: (answer: AskAnswer) => Promise<'applied' | { readonly refused: string }>;
}

export const AskSources = defineHook('ask.sources', {
  mode: 'provide',
  key: SourceKeySchema,
  value: z.custom<AskSourceSpec>(),
});

/** An answer landed. A wake-up: the source reads `answers` and applies each once. */
export const AskAnswered = defineEvent(
  'asks.answered',
  z.strictObject({
    ferret: z.string().min(1).max(128),
    askId: AskIdSchema,
    answerId: AnswerIdSchema,
    source: SourceKeySchema,
    entry: EntryIdSchema,
  }),
);

/** An ask was raised, closed or changed. A wake-up for views (Agenda, sitrep). */
export const AsksChanged = defineEvent(
  'asks.changed',
  z.strictObject({ ferret: z.string().min(1).max(128), askId: AskIdSchema, state: AskStateSchema }),
);

// ─── state ────────────────────────────────────────────────────────────────────────────────────────────────────────

export const StoredAskSchema = z.strictObject({
  ...AskSummarySchema.omit({ sourceUnavailable: true }).shape,
  ref: z.unknown(),
  why: z.string(),
  howToResolve: z.string().optional(),
  context: z.string().optional(),
  options: z.array(AskOptionSchema).optional(),
  blocking: z.boolean().optional(),
  closedAt: InstantSchema.optional(),
  closeReason: CloseReasonSchema.optional(),
});

export const AsksFile = defineState({
  name: 'asks',
  path: 'asks.json',
  store: 'json',
  format: 1,
  schema: z.strictObject({ format: z.literal(1), next: z.number().int().positive(), asks: z.array(StoredAskSchema) }),
});
export const AnswersFile = defineState({
  name: 'answers',
  path: 'answers.json',
  store: 'json',
  format: 1,
  schema: z.strictObject({ format: z.literal(1), answers: z.array(AskAnswerSchema) }),
});
export const AskHistoryFile = defineState({ name: 'history', path: 'history.jsonl', store: 'jsonl', format: 1 });
export const AskVersionsFiles = defineState({
  name: 'versions',
  path: 'versions/*.sqlite',
  store: 'sqlite',
  format: 1,
});
