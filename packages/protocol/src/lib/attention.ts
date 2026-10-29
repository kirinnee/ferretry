import { z } from 'zod';
import { InstantSchema, NonNegativeIntegerSchema, PositiveIntegerSchema } from './common.ts';

export const ATTENTION_SCHEMA_VERSION = 1 as const;
export const MAX_ATTENTION_PER_SESSION = 20;
export const MAX_ATTENTION_RESOLUTIONS = 100;
export const MAX_ATTENTION_SUBJECT_LENGTH = 240;
export const MAX_ATTENTION_DETAIL_LENGTH = 2_048;
export const MAX_ATTENTION_SOURCE_REF_LENGTH = 512;
export const MAX_ATTENTION_ASK_OPTIONS = 12;
export const MAX_ATTENTION_ASK_OPTION_LENGTH = 120;
export const MAX_ATTENTION_ASK_OPTION_DETAIL_LENGTH = 240;
export const MAX_NOTIFICATION_TITLE_LENGTH = 120;
export const MAX_NOTIFICATION_BODY_LENGTH = 500;
export const MAX_ATTENTION_WARNINGS = 12;
export const MAX_ATTENTION_WARNING_LENGTH = 400;
/**
 * What an Attention push says, at most: a lock screen shows the title and about a line or two. The
 * title is the card's own, so it is also how long a card's title should be; past it the lint advises.
 */
export const ATTENTION_PUSH_TITLE_LENGTH = 40;
/** The push body is the card's ask, so it holds as much as an ask should say (`ATTENTION_ASK_TARGET_LENGTH`). */
export const ATTENTION_PUSH_BODY_LENGTH = 120;
/** The longest title an item may carry at all; past the target it is advice, past this a refusal. */
export const MAX_ATTENTION_TITLE_LENGTH = 60;
/** The most a card's ASK should say: the one-line question or action, which is the push's text. */
export const ATTENTION_ASK_TARGET_LENGTH = 120;
/** The most answers a card offers: one per swipe direction, left, up and right. */
export const MAX_ATTENTION_CARD_ANSWERS = 3;

const singleLine = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .regex(/^[^\r\n]*$/u, 'must be a single line');

export const AttentionSourceSchema = z.enum(['task', 'question', 'agent-raised']);
export type AttentionSource = z.infer<typeof AttentionSourceSchema>;

export const AttentionAskOptionSchema = z.strictObject({
  label: singleLine(MAX_ATTENTION_ASK_OPTION_LENGTH),
  description: singleLine(MAX_ATTENTION_ASK_OPTION_DETAIL_LENGTH).optional(),
});
export type AttentionAskOption = z.infer<typeof AttentionAskOptionSchema>;

const MultipleChoiceAskSchema = z
  .strictObject({
    kind: z.literal('multiple-choice'),
    options: z.array(AttentionAskOptionSchema).min(2).max(MAX_ATTENTION_ASK_OPTIONS),
  })
  .superRefine((value, context) => {
    const labels = value.options.map(option => option.label.trim());
    if (new Set(labels).size !== labels.length) {
      context.addIssue({ code: 'custom', message: 'option labels must be unique', path: ['options'] });
    }
  });

export const AttentionAskSchema = z.union([
  z.strictObject({ kind: z.literal('permission') }),
  MultipleChoiceAskSchema,
  z.strictObject({ kind: z.literal('answer-review') }),
  z.strictObject({ kind: z.literal('open-question') }),
  /** "Do this": the owner does something and nothing is chosen. Its answers are Done and Need more info. */
  z.strictObject({ kind: z.literal('task') }),
]);
export type AttentionAsk = z.infer<typeof AttentionAskSchema>;

/**
 * WHAT KIND OF CARD AN ITEM IS, as the owner sees it — the words a ferret picks (`--kind`) and the
 * defaults each one answers with (`attention-card.ts`). It sits beside the ask rather than replacing
 * it, so every daemon and app that reads only the ask still answers the item correctly:
 *
 * - `task`: do something, then say Done (the `task` ask).
 * - `yesno`: a yes-or-no decision (a `multiple-choice` ask of exactly Yes and No).
 * - `permission`: allow or deny an action (the `permission` ask).
 * - `choice`: pick one of two or three options (a `multiple-choice` ask).
 * - `review`: look at something and say whether it is good (the `answer-review` ask).
 * - `info`: something the owner should know, acknowledged with Got it (no ask).
 * - `reply`: a question only words answer (the `open-question` ask).
 */
export const AttentionKindSchema = z.enum(['task', 'yesno', 'permission', 'choice', 'review', 'info', 'reply']);
export type AttentionKind = z.infer<typeof AttentionKindSchema>;

/** The way a card is swiped to give one of its answers. Down is never one: the card scrolls that way. */
export const AttentionDirectionSchema = z.enum(['left', 'up', 'right']);
export type AttentionDirection = z.infer<typeof AttentionDirectionSchema>;

/**
 * What giving an answer DOES, as the daemon is asked to do it:
 *
 * - `choose`: answer a `multiple-choice` ask with the option of the same label.
 * - `approve` / `reject`: answer a `permission` ask.
 * - `good` / `clarify`: answer an `answer-review` ask; `clarify` needs the reply text.
 * - `done`: resolve the item; `needs-info`: ask the ferret for more and keep it open; `dismiss`: close
 *   it unanswered. These three fit any card.
 */
export const AttentionAnswerEffectSchema = z.enum([
  'choose',
  'approve',
  'reject',
  'good',
  'clarify',
  'done',
  'needs-info',
  'dismiss',
]);
export type AttentionAnswerEffect = z.infer<typeof AttentionAnswerEffectSchema>;

/**
 * One answer on a card, bound to the swipe that gives it. Its label is what the button and the swipe
 * stamp say; for `choose` it IS the option's label, so the button and the recorded answer cannot drift.
 */
export const AttentionCardAnswerSchema = z.strictObject({
  direction: AttentionDirectionSchema,
  label: singleLine(MAX_ATTENTION_ASK_OPTION_LENGTH),
  does: AttentionAnswerEffectSchema,
  description: singleLine(MAX_ATTENTION_ASK_OPTION_DETAIL_LENGTH).optional(),
});
export type AttentionCardAnswer = z.infer<typeof AttentionCardAnswerSchema>;

/** The effects each ask may be answered with, beyond the `done`, `needs-info` and `dismiss` every card takes. */
const ASK_EFFECTS: Readonly<Record<AttentionAsk['kind'] | 'none', readonly AttentionAnswerEffect[]>> = {
  permission: ['approve', 'reject'],
  'multiple-choice': ['choose'],
  'answer-review': ['good', 'clarify'],
  'open-question': [],
  task: [],
  none: [],
};
const ANY_CARD_EFFECTS: readonly AttentionAnswerEffect[] = ['done', 'needs-info', 'dismiss'];

/**
 * Everything wrong with a card's answers against its ask, as `[path, message]` pairs — empty when they
 * fit: at most three, one per direction, each effect one its ask takes, and every `choose` naming one
 * of the ask's options. The schemas and the CLI both read it, so one rule refuses in both places.
 */
export function attentionAnswerProblems(
  answers: readonly AttentionCardAnswer[],
  ask: AttentionAsk | undefined,
): readonly (readonly [string, string])[] {
  const problems: (readonly [string, string])[] = [];
  if (answers.length > MAX_ATTENTION_CARD_ANSWERS) {
    problems.push([
      'answers',
      `a card offers at most ${MAX_ATTENTION_CARD_ANSWERS} answers (left, up, right); split it into several items, or let the reply carry the rest`,
    ]);
  }
  const directions = answers.map(answer => answer.direction);
  if (new Set(directions).size !== directions.length) {
    problems.push(['answers', 'each answer needs its own direction: left, up or right, once each']);
  }
  const labels = answers.map(answer => answer.label.trim().toLowerCase());
  if (new Set(labels).size !== labels.length) problems.push(['answers', 'answer labels must be unique']);
  const allowed = new Set([...ASK_EFFECTS[ask?.kind ?? 'none'], ...ANY_CARD_EFFECTS]);
  const options = ask?.kind === 'multiple-choice' ? ask.options.map(option => option.label.trim()) : [];
  answers.forEach((answer, index) => {
    if (!allowed.has(answer.does)) {
      problems.push([
        `answers.${index}.does`,
        `"${answer.does}" does not answer a ${ask?.kind ?? 'card with no ask'}; use ${[...allowed].join(', ')}`,
      ]);
    } else if (answer.does === 'choose' && !options.includes(answer.label.trim())) {
      problems.push([`answers.${index}.label`, 'a choose answer must name one of the ask options']);
    }
  });
  return problems;
}

/** The card's own fields: what it is about, what kind it is, and its answers by direction. */
export const AttentionCardShape = {
  /** What the item is about, in a few plain words: the card's heading and the push's title. */
  title: singleLine(MAX_ATTENTION_TITLE_LENGTH).optional(),
  /** What kind of card it is; derived from the ask when absent (`attentionCardKind`). */
  kind: AttentionKindSchema.optional(),
  /** Up to three answers, one per direction; the kind's defaults when absent (`attentionCardAnswers`). */
  answers: z.array(AttentionCardAnswerSchema).min(1).max(MAX_ATTENTION_CARD_ANSWERS).optional(),
};

const AnswerReviewResponseSchema = z.discriminatedUnion('verdict', [
  z.strictObject({ kind: z.literal('answer-review'), verdict: z.literal('good') }),
  z.strictObject({
    kind: z.literal('answer-review'),
    verdict: z.literal('clarify'),
    clarification: z.string().trim().min(1).max(MAX_ATTENTION_DETAIL_LENGTH),
  }),
]);

export const AttentionResponseSchema = z.union([
  z.strictObject({ kind: z.literal('permission'), decision: z.enum(['approve', 'reject']) }),
  z.strictObject({
    kind: z.literal('multiple-choice'),
    choice: singleLine(MAX_ATTENTION_ASK_OPTION_LENGTH),
  }),
  AnswerReviewResponseSchema,
  z.strictObject({
    kind: z.literal('open-question'),
    answer: z.string().trim().min(1).max(MAX_ATTENTION_DETAIL_LENGTH),
  }),
]);
export type AttentionResponse = z.infer<typeof AttentionResponseSchema>;

export const MAX_ATTENTION_TERMS = 12;
export const MAX_ATTENTION_TERM_LENGTH = 80;
export const MAX_ATTENTION_TERM_MEANING_LENGTH = 400;
export const MAX_ATTENTION_QUESTIONS = 6;
export const MAX_ATTENTION_QUESTION_LENGTH = 600;
export const MAX_ATTENTION_REASON_LENGTH = 1_024;
export const MAX_ATTENTION_URGENCY_LENGTH = 120;
export const MAX_ATTENTION_LINKS = 10;
export const MAX_ATTENTION_LINK_LABEL_LENGTH = 120;
export const MAX_ATTENTION_LINK_TARGET_LENGTH = 1_024;
/** The most steps an item carries, and the longest one: each is Markdown, one thing to do. */
export const MAX_ATTENTION_STEPS = 20;
export const MAX_ATTENTION_STEP_LENGTH = 2_000;
/** The longest instruction document an item carries, as one block of Markdown. */
export const MAX_ATTENTION_BODY_LENGTH = 8_000;

const prose = (maximum: number) => z.string().trim().min(1).max(maximum);

/** A list of short points as markdown bullets, one per line; blank points are dropped. */
export const toBullets = (points: readonly string[]): string =>
  points
    .map(point => point.replaceAll(/\s+/gu, ' ').trim())
    .filter(point => point !== '')
    .map(point => `- ${point}`)
    .join('\n');

/** Accepts text, or a list of points that becomes bullets — what a ferret writes, point form first. */
const asBullets = (value: unknown): unknown =>
  Array.isArray(value) && value.every((point): point is string => typeof point === 'string') ? toBullets(value) : value;

/** One piece of jargon the item uses, spelled out for a reader who has not been following. */
export const AttentionTermSchema = z.strictObject({
  term: singleLine(MAX_ATTENTION_TERM_LENGTH),
  meaning: prose(MAX_ATTENTION_TERM_MEANING_LENGTH),
});
export type AttentionTerm = z.infer<typeof AttentionTermSchema>;

/**
 * One thing the owner is asked. Its options, when it has them, are what the owner picks from; its
 * `recommended` is the asker's own pick — one of those labels when there are options, the suggested
 * answer in words when there are none — and `why` is the reason for it.
 */
export const AttentionQuestionSchema = z
  .strictObject({
    question: prose(MAX_ATTENTION_QUESTION_LENGTH),
    options: z.array(AttentionAskOptionSchema).min(2).max(MAX_ATTENTION_ASK_OPTIONS).optional(),
    recommended: singleLine(MAX_ATTENTION_ASK_OPTION_LENGTH).optional(),
    why: prose(MAX_ATTENTION_REASON_LENGTH).optional(),
  })
  .superRefine((value, context) => {
    if (value.options === undefined) return;
    const labels = value.options.map(option => option.label.trim());
    if (new Set(labels).size !== labels.length) {
      context.addIssue({ code: 'custom', message: 'option labels must be unique', path: ['options'] });
    }
    if (value.recommended !== undefined && !labels.includes(value.recommended.trim())) {
      context.addIssue({
        code: 'custom',
        message: 'a recommendation must name one of the question options',
        path: ['recommended'],
      });
    }
  });
export type AttentionQuestion = z.infer<typeof AttentionQuestionSchema>;

/** The asker's overall suggested decision, and why. */
export const AttentionRecommendationSchema = z.strictObject({
  decision: prose(MAX_ATTENTION_QUESTION_LENGTH),
  why: prose(MAX_ATTENTION_REASON_LENGTH).optional(),
});
export type AttentionRecommendation = z.infer<typeof AttentionRecommendationSchema>;

/** A PR, a file or a reference the reader may want to open. The target is a URL, a path or a reference. */
export const AttentionLinkSchema = z.strictObject({
  label: singleLine(MAX_ATTENTION_LINK_LABEL_LENGTH).optional(),
  target: singleLine(MAX_ATTENTION_LINK_TARGET_LENGTH),
});
export type AttentionLink = z.infer<typeof AttentionLinkSchema>;

/**
 * THE STRUCTURED PART OF AN ITEM, every field optional so an item raised before it existed still
 * reads. The item's `subject` is its SUMMARY (one line: what is needed) and `context` is what is
 * happening and why it matters; these carry the rest of what a reader who has not been following
 * needs (docs/attention.md, "What an item says").
 */
export const AttentionBriefShape = {
  /** Jargon the item uses, each spelled out. */
  terms: z.array(AttentionTermSchema).min(1).max(MAX_ATTENTION_TERMS).optional(),
  /** What the owner is asked, one entry per decision. */
  questions: z.array(AttentionQuestionSchema).min(1).max(MAX_ATTENTION_QUESTIONS).optional(),
  /** The asker's overall suggested decision. */
  recommendation: AttentionRecommendationSchema.optional(),
  /** What happens if nobody answers. */
  impact: z.preprocess(asBullets, prose(MAX_ATTENTION_REASON_LENGTH)).optional(),
  /** By when it matters, in words: "before the 14:00 deploy", "no rush". */
  urgency: singleLine(MAX_ATTENTION_URGENCY_LENGTH).optional(),
  /** PRs, files and references worth opening. */
  links: z.array(AttentionLinkSchema).min(1).max(MAX_ATTENTION_LINKS).optional(),
  /** Ordered Markdown steps the owner follows, one thing to do each: complete instructions, never a secret. */
  steps: z.array(prose(MAX_ATTENTION_STEP_LENGTH)).min(1).max(MAX_ATTENTION_STEPS).optional(),
  /** Instructions that are not a list, as one Markdown document. */
  body: prose(MAX_ATTENTION_BODY_LENGTH).optional(),
};

/** The structured fields of an item, alone. */
export type AttentionBrief = {
  readonly [K in keyof typeof AttentionBriefShape]?: z.infer<(typeof AttentionBriefShape)[K]>;
};

/** Just the structured fields an item or a request carries, with the absent ones left out. */
export const attentionBriefOf = (value: AttentionBrief): AttentionBrief => ({
  ...(value.terms === undefined ? {} : { terms: value.terms }),
  ...(value.questions === undefined ? {} : { questions: value.questions }),
  ...(value.recommendation === undefined ? {} : { recommendation: value.recommendation }),
  ...(value.impact === undefined ? {} : { impact: value.impact }),
  ...(value.urgency === undefined ? {} : { urgency: value.urgency }),
  ...(value.links === undefined ? {} : { links: value.links }),
  ...(value.steps === undefined ? {} : { steps: value.steps }),
  ...(value.body === undefined ? {} : { body: value.body }),
});

/**
 * The one question an item asks, when it asks exactly one — the only case where its options are
 * also the item's own answers (and so the swipe deck's). An item with several questions is answered
 * in words, one answer per question.
 */
export const singleAttentionQuestion = (brief: AttentionBrief): AttentionQuestion | undefined =>
  brief.questions?.length === 1 ? brief.questions[0] : undefined;

/**
 * The option an item recommends, when it has a choice ask: its single question's recommendation, or
 * the overall recommendation when it names one of the options exactly.
 */
export const recommendedAttentionOption = (
  item: AttentionBrief & { readonly ask?: AttentionAsk },
): string | undefined => {
  if (item.ask?.kind !== 'multiple-choice') return undefined;
  const labels = item.ask.options.map(option => option.label.trim());
  const candidates = [singleAttentionQuestion(item)?.recommended, item.recommendation?.decision];
  return candidates
    .map(candidate => candidate?.trim())
    .find(candidate => candidate !== undefined && labels.includes(candidate));
};

/** The most entries an item's history keeps, oldest dropped. */
export const MAX_ATTENTION_HISTORY = 20;

/** One thing that happened to an item after it was raised, for "You asked for more info 10:42 · updated 10:44". */
export const AttentionHistoryEntrySchema = z.strictObject({
  at: InstantSchema,
  kind: z.enum(['needs-info', 'updated']),
  note: z.string().trim().min(1).max(MAX_ATTENTION_DETAIL_LENGTH).optional(),
});
export type AttentionHistoryEntry = z.infer<typeof AttentionHistoryEntrySchema>;

export const AttentionDispositionSchema = z.enum(['done', 'dismissed']);
export type AttentionDisposition = z.infer<typeof AttentionDispositionSchema>;

export const AttentionIdSchema = z.string().regex(/^A[1-9][0-9]*$/u);
export type AttentionId = z.infer<typeof AttentionIdSchema>;

export const AttentionBySchema = z.enum(['human', 'agent', 'daemon']);
export type AttentionBy = z.infer<typeof AttentionBySchema>;

const AttentionItemBaseShape = {
  id: AttentionIdSchema,
  source: AttentionSourceSchema,
  sourceRef: z.string().max(MAX_ATTENTION_SOURCE_REF_LENGTH).nullable(),
  sourceSeq: PositiveIntegerSchema.optional(),
  subject: singleLine(MAX_ATTENTION_SUBJECT_LENGTH),
  why: z.string().trim().min(1).max(MAX_ATTENTION_DETAIL_LENGTH),
  context: z.string().max(MAX_ATTENTION_DETAIL_LENGTH).nullable().optional(),
  waitingSince: InstantSchema,
  howToResolve: z.string().trim().min(1).max(MAX_ATTENTION_DETAIL_LENGTH),
  ask: AttentionAskSchema.optional(),
  ...AttentionCardShape,
  ...AttentionBriefShape,
  /** The indices of the steps the owner has ticked: sorted, unique, each below `steps.length`; absent when none. */
  stepsDone: z.array(NonNegativeIntegerSchema).min(1).max(MAX_ATTENTION_STEPS).optional(),
  /** Set while the owner has asked the raising ferret for more information and it has not yet added any. */
  waitingOn: z.literal('ferret').optional(),
  /** When the owner asked; present exactly while `waitingOn` is. */
  askedAt: InstantSchema.optional(),
  /** How many times the owner has asked for more information: the request counter. */
  infoRequests: PositiveIntegerSchema.optional(),
  /** Bounded, oldest first: when the owner asked for more information and when the ferret added it. */
  history: z.array(AttentionHistoryEntrySchema).min(1).max(MAX_ATTENTION_HISTORY).optional(),
};

export const AttentionItemSchema = z
  .discriminatedUnion('raisedBy', [
    z.object({
      ...AttentionItemBaseShape,
      raisedBy: z.literal('human'),
      raisedBySession: z.null(),
      raisedByName: z.null(),
    }),
    z.object({
      ...AttentionItemBaseShape,
      raisedBy: z.literal('agent'),
      raisedBySession: z.string().min(1),
      raisedByName: z.string().nullable(),
    }),
    z.object({
      ...AttentionItemBaseShape,
      raisedBy: z.literal('daemon'),
      raisedBySession: z.null(),
      raisedByName: z.null(),
    }),
  ])
  .superRefine((value, context) => {
    for (const [path, message] of attentionAnswerProblems(value.answers ?? [], value.ask)) {
      context.addIssue({ code: 'custom', message, path: path.split('.') });
    }
    if (value.sourceSeq !== undefined && value.source !== 'agent-raised') {
      context.addIssue({ code: 'custom', message: 'sourceSeq is valid only for agent-raised attention' });
    }
    if ((value.waitingOn === undefined) !== (value.askedAt === undefined)) {
      context.addIssue({ code: 'custom', message: 'waitingOn and askedAt are set together', path: ['askedAt'] });
    }
    if (value.stepsDone !== undefined) {
      const done = value.stepsDone;
      const ordered = done.every((step, index) => index === 0 || step > (done[index - 1] ?? -1));
      if (!ordered || done.some(step => step >= (value.steps?.length ?? 0))) {
        context.addIssue({
          code: 'custom',
          message: 'stepsDone must be sorted, unique and each below the number of steps',
          path: ['stepsDone'],
        });
      }
    }
  });
export type AttentionItem = z.infer<typeof AttentionItemSchema>;

const ResolvedAttentionBaseShape = {
  resolvedAt: InstantSchema,
  resolutionNote: z.string().max(MAX_ATTENTION_DETAIL_LENGTH).nullable(),
  response: AttentionResponseSchema.optional(),
  disposition: AttentionDispositionSchema,
};

const AttentionResolutionSchema = z.discriminatedUnion('resolvedBy', [
  z.object({
    ...ResolvedAttentionBaseShape,
    resolvedBy: z.literal('human'),
    resolvedBySession: z.null(),
    resolvedByName: z.null(),
  }),
  z.object({
    ...ResolvedAttentionBaseShape,
    resolvedBy: z.literal('agent'),
    resolvedBySession: z.string().min(1),
    resolvedByName: z.string().nullable(),
  }),
  z.object({
    ...ResolvedAttentionBaseShape,
    resolvedBy: z.literal('daemon'),
    resolvedBySession: z.null(),
    resolvedByName: z.null(),
  }),
]);

export const ResolvedAttentionItemSchema = z
  .intersection(AttentionItemSchema, AttentionResolutionSchema)
  .superRefine((value, context) => {
    if (value.disposition === 'dismissed' && value.response !== undefined) {
      context.addIssue({ code: 'custom', message: 'a dismissed item may not carry a response', path: ['response'] });
    }
    if (value.response !== undefined && value.ask?.kind !== value.response.kind) {
      context.addIssue({ code: 'custom', message: 'response kind must match the original ask', path: ['response'] });
    }
    if (value.response?.kind === 'multiple-choice' && value.ask?.kind === 'multiple-choice') {
      const choices = value.ask.options.map(option => option.label.trim());
      if (!choices.includes(value.response.choice.trim())) {
        context.addIssue({
          code: 'custom',
          message: 'choice must name one of the ask options',
          path: ['response', 'choice'],
        });
      }
    }
  });
export type ResolvedAttentionItem = z.infer<typeof ResolvedAttentionItemSchema>;

/**
 * The owner's answers a machine is holding for one ferret, to deliver them as ONE message once the owner
 * stops answering (docs/attention.md § The loop). Present on the board while anything is held, so the app
 * can say "sending in 8 s" and offer "Send now" (`POST /v1/sessions/:sessionId/attention/replies`).
 */
export const AttentionRepliesSchema = z.strictObject({
  pending: z.array(AttentionIdSchema).min(1).max(MAX_ATTENTION_RESOLUTIONS),
  dueAt: InstantSchema,
});
export type AttentionReplies = z.infer<typeof AttentionRepliesSchema>;

export const AttentionSnapshotSchema = z
  .object({
    v: z.literal(ATTENTION_SCHEMA_VERSION),
    sessionId: z.string().min(1),
    items: z.array(AttentionItemSchema).max(MAX_ATTENTION_PER_SESSION),
    resolved: z.array(ResolvedAttentionItemSchema).max(MAX_ATTENTION_RESOLUTIONS),
    count: NonNegativeIntegerSchema,
    parseErrors: NonNegativeIntegerSchema,
    updatedAt: InstantSchema,
    /** Writing advice for the item just raised or edited; present only on that response. */
    warnings: z
      .array(z.string().trim().min(1).max(MAX_ATTENTION_WARNING_LENGTH))
      .max(MAX_ATTENTION_WARNINGS)
      .optional(),
    /**
     * How many devices this machine has enrolled for push, counted as an item was raised; present only on
     * the response to that raise. Zero means the owner was told nothing: the ask is on the board, and no
     * phone or browser will hear of it until one turns notifications on.
     */
    enrolled: NonNegativeIntegerSchema.optional(),
    /** Answers held for this ferret and when they go; absent when nothing is held. */
    replies: AttentionRepliesSchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.count !== value.items.length) {
      context.addIssue({ code: 'custom', message: 'count must equal the number of active items', path: ['count'] });
    }
    const activeIds = new Set(value.items.map(item => item.id));
    if (activeIds.size !== value.items.length) {
      context.addIssue({ code: 'custom', message: 'active attention ids must be unique', path: ['items'] });
    }
    const resolvedIds = value.resolved.map(item => item.id);
    if (new Set(resolvedIds).size !== resolvedIds.length) {
      context.addIssue({ code: 'custom', message: 'resolved attention ids must be unique', path: ['resolved'] });
    }
    if (resolvedIds.some(id => activeIds.has(id))) {
      context.addIssue({ code: 'custom', message: 'active and resolved attention ids must be disjoint' });
    }
  });
export type AttentionSnapshot = z.infer<typeof AttentionSnapshotSchema>;

const AddAttentionRequestSchema = z.strictObject({
  action: z.literal('add'),
  ...AttentionCardShape,
  source: z.literal('agent-raised').default('agent-raised'),
  sourceRef: z.string().max(MAX_ATTENTION_SOURCE_REF_LENGTH).nullable().default(null),
  subject: singleLine(MAX_ATTENTION_SUBJECT_LENGTH),
  why: z.string().trim().min(1).max(MAX_ATTENTION_DETAIL_LENGTH),
  context: z.preprocess(asBullets, z.string().max(MAX_ATTENTION_DETAIL_LENGTH)).nullable().optional(),
  howToResolve: z.string().trim().min(1).max(MAX_ATTENTION_DETAIL_LENGTH),
  ask: AttentionAskSchema.optional(),
  ...AttentionBriefShape,
});

export const AttentionActionRequestSchema = z
  .discriminatedUnion('action', [
    AddAttentionRequestSchema,
    /** Reword an open item in place: only the writing, never its ask or who raised it. */
    z.strictObject({
      action: z.literal('edit'),
      id: AttentionIdSchema,
      subject: singleLine(MAX_ATTENTION_SUBJECT_LENGTH).optional(),
      title: AttentionCardShape.title,
      context: z.preprocess(asBullets, z.string().max(MAX_ATTENTION_DETAIL_LENGTH)).nullable().optional(),
      ...AttentionBriefShape,
    }),
    z.strictObject({
      action: z.literal('resolve'),
      id: AttentionIdSchema,
      note: z.string().max(MAX_ATTENTION_DETAIL_LENGTH).optional(),
      response: AttentionResponseSchema.optional(),
    }),
    /** Tick or untick one step of an open item: never resolves it, never pushes, never messages the ferret. */
    z.strictObject({
      action: z.literal('progress'),
      id: AttentionIdSchema,
      step: NonNegativeIntegerSchema,
      done: z.boolean(),
    }),
    /** The owner asks the raising ferret for more information: the item stays open, marked waiting on the ferret. */
    z.strictObject({
      action: z.literal('needs-info'),
      id: AttentionIdSchema,
      note: z.string().trim().min(1).max(MAX_ATTENTION_DETAIL_LENGTH).optional(),
    }),
    z.strictObject({
      action: z.literal('dismiss'),
      id: AttentionIdSchema,
      note: z.string().max(MAX_ATTENTION_DETAIL_LENGTH).optional(),
    }),
  ])
  .superRefine((value, context) => {
    if (value.action !== 'add') return;
    for (const [path, message] of attentionAnswerProblems(value.answers ?? [], value.ask)) {
      context.addIssue({ code: 'custom', message, path: path.split('.') });
    }
  });
export type AttentionActionRequest = z.infer<typeof AttentionActionRequestSchema>;

export const DirectNotificationRequestSchema = z.strictObject({
  body: z.string().trim().min(1).max(MAX_NOTIFICATION_BODY_LENGTH),
  title: singleLine(MAX_NOTIFICATION_TITLE_LENGTH).optional(),
  kind: z.enum(['completed', 'failed']).optional(),
});
export type DirectNotificationRequest = z.infer<typeof DirectNotificationRequestSchema>;

export const AttentionCountResponseSchema = z.object({
  sessionId: z.string().min(1),
  count: NonNegativeIntegerSchema,
});
export type AttentionCountResponse = z.infer<typeof AttentionCountResponseSchema>;

export const DirectNotificationResponseSchema = z.object({
  sessionId: z.string().min(1),
  delivered: NonNegativeIntegerSchema,
});
export type DirectNotificationResponse = z.infer<typeof DirectNotificationResponseSchema>;

export const AttentionErrorCodeSchema = z.enum([
  'invalid',
  'too-long',
  'not-found',
  'forbidden',
  'rate-limited',
  'read-only',
  'full',
  'corrupt',
]);
export type AttentionErrorCode = z.infer<typeof AttentionErrorCodeSchema>;

/**
 * A session's open Attention, as its list row carries it: what makes a conversation read as UNREAD
 * until the owner has dealt with it. The daemon rewrites it after every board change that moves the
 * open set, and removes it when nothing is open — so its absence means "nothing waits on the owner",
 * never "unknown". The board itself (`GET /v1/sessions/:id/attention`) has every item in full.
 */
export const SessionAttentionSummarySchema = z.object({
  /** How many items are open. */
  open: PositiveIntegerSchema,
  /** The oldest open item — the one a row opens to. */
  first: AttentionIdSchema,
  /** That item's one-line ask, for a row's preview. */
  ask: singleLine(MAX_ATTENTION_SUBJECT_LENGTH),
  /** When the NEWEST open item was raised: "newest needing you first" sorts by it. */
  latestAt: InstantSchema,
});
export type SessionAttentionSummary = z.infer<typeof SessionAttentionSummarySchema>;

/** The query parameter a conversation link names an Attention item by. */
export const ATTENTION_LINK_PARAMETER = 'attention';

/**
 * Where a push about a conversation opens, RELATIVE TO THE MACHINE'S OWN PAGES: the daemon names the
 * session, and the browser's per-machine push worker puts it under that machine — the daemon never
 * names an origin or the browser's address for itself (`packages/pwa/src/lib/push-scope.ts`). A push
 * with no item to point at (`fy attention notify`) opens here.
 */
export const sessionNotificationPath = (sessionId: string): string => `/session/${encodeURIComponent(sessionId)}`;

/** Where an Attention notification opens: its conversation, AT the item (`?attention=A3`). */
export const attentionNotificationPath = (sessionId: string, id: AttentionId): string =>
  `${sessionNotificationPath(sessionId)}?${ATTENTION_LINK_PARAMETER}=${encodeURIComponent(id)}`;
