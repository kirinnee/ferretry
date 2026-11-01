import { z } from 'zod';
import { AccountIdSchema, TwoFactorStageIdSchema } from './account-ids.ts';
import { TaskRefSchema } from './board-refs.ts';
import { InstantSchema, NonNegativeIntegerSchema, PositiveIntegerSchema } from './common.ts';

export const AGENDA_SCHEMA_VERSION = 1 as const;
export const MAX_AGENDA_PER_SESSION = 20;
export const MAX_AGENDA_RESOLUTIONS = 100;
export const MAX_AGENDA_SUBJECT_LENGTH = 240;
export const MAX_AGENDA_DETAIL_LENGTH = 2_048;
export const MAX_AGENDA_SOURCE_REF_LENGTH = 512;
export const MAX_AGENDA_ASK_OPTIONS = 12;
export const MAX_AGENDA_ASK_OPTION_LENGTH = 120;
/** The most fields a form carries, and the longest id one has. */
export const MAX_AGENDA_FIELDS = 12;
export const MAX_AGENDA_FIELD_ID_LENGTH = 24;
export const MAX_AGENDA_FIELD_NAME_LENGTH = 40;
export const MAX_AGENDA_ASK_OPTION_DETAIL_LENGTH = 240;
export const MAX_NOTIFICATION_TITLE_LENGTH = 120;
export const MAX_NOTIFICATION_BODY_LENGTH = 500;
export const MAX_AGENDA_WARNINGS = 12;
export const MAX_AGENDA_WARNING_LENGTH = 400;
/**
 * What an Agenda push says, at most: a lock screen shows the title and about a line or two. The
 * title is the card's own, so it is also how long a card's title should be; past it the lint advises.
 */
export const AGENDA_PUSH_TITLE_LENGTH = 40;
/** The push body is the card's ask, so it holds as much as an ask should say (`AGENDA_ASK_TARGET_LENGTH`). */
export const AGENDA_PUSH_BODY_LENGTH = 120;
/** The longest title an item may carry at all; past the target it is advice, past this a refusal. */
export const MAX_AGENDA_TITLE_LENGTH = 60;
/** The most a card's ASK should say: the one-line question or action, which is the push's text. */
export const AGENDA_ASK_TARGET_LENGTH = 120;
/** The most answers a card offers: one per swipe direction, left, up and right. */
export const MAX_AGENDA_CARD_ANSWERS = 3;

const singleLine = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .regex(/^[^\r\n]*$/u, 'must be a single line');

export const AgendaSourceSchema = z.enum(['task', 'question', 'agent-raised']);
export type AgendaSource = z.infer<typeof AgendaSourceSchema>;

export const AgendaAskOptionSchema = z.strictObject({
  label: singleLine(MAX_AGENDA_ASK_OPTION_LENGTH),
  description: singleLine(MAX_AGENDA_ASK_OPTION_DETAIL_LENGTH).optional(),
});
export type AgendaAskOption = z.infer<typeof AgendaAskOptionSchema>;

const MultipleChoiceAskSchema = z
  .strictObject({
    kind: z.literal('multiple-choice'),
    options: z.array(AgendaAskOptionSchema).min(2).max(MAX_AGENDA_ASK_OPTIONS),
  })
  .superRefine((value, context) => {
    const labels = value.options.map(option => option.label.trim());
    if (new Set(labels).size !== labels.length) {
      context.addIssue({ code: 'custom', message: 'option labels must be unique', path: ['options'] });
    }
  });

export const AgendaAskSchema = z.union([
  z.strictObject({ kind: z.literal('permission') }),
  MultipleChoiceAskSchema,
  z.strictObject({ kind: z.literal('answer-review') }),
  z.strictObject({ kind: z.literal('open-question') }),
  /** "Do this": the owner does something and nothing is chosen. Its answers are Done and Need more info. */
  z.strictObject({ kind: z.literal('task') }),
]);
export type AgendaAsk = z.infer<typeof AgendaAskSchema>;

/**
 * WHAT KIND OF CARD AN ITEM IS, as the owner sees it — the words a ferret picks (`--kind`) and the
 * defaults each one answers with (`agenda-card.ts`). It sits beside the ask rather than replacing
 * it, so every daemon and app that reads only the ask still answers the item correctly:
 *
 * - `task`: do something, then say Done (the `task` ask).
 * - `yesno`: a yes-or-no decision (a `multiple-choice` ask of exactly Yes and No).
 * - `permission`: allow or deny an action (the `permission` ask).
 * - `choice`: pick one of two or three options (a `multiple-choice` ask).
 * - `review`: look at something and say whether it is good (the `answer-review` ask).
 * - `info`: something the owner should know, acknowledged with Got it (no ask).
 * - `reply`: a question only words answer (the `open-question` ask).
 * - `form`: several structured answers at once — pick-one, pick-many and yes/no fields on the card, one free-text
 *   field answered in the reply box (`fields`, `AgendaFormFieldSchema`). It asks in words (the `open-question` ask), so
 *   an app that does not know forms still lets the owner reply.
 * - `input`: a value only the owner can type, for an agent's terminal or browser field (docs/input-requests.md).
 *   Only the daemon raises one, it has no ask or swipes, and the generic answer routes refuse it: the value
 *   must never travel as an agenda answer.
 */
export const AgendaKindSchema = z.enum([
  'task',
  'yesno',
  'permission',
  'choice',
  'review',
  'info',
  'reply',
  'form',
  'input',
]);
export type AgendaKind = z.infer<typeof AgendaKindSchema>;

/** The way a card is swiped to give one of its answers. Down is never one: the card scrolls that way. */
export const AgendaDirectionSchema = z.enum(['left', 'up', 'right']);
export type AgendaDirection = z.infer<typeof AgendaDirectionSchema>;

/**
 * What giving an answer DOES, as the daemon is asked to do it:
 *
 * - `choose`: answer a `multiple-choice` ask with the option of the same label.
 * - `approve` / `reject`: answer a `permission` ask.
 * - `good` / `clarify`: answer an `answer-review` ask; `clarify` needs the reply text.
 * - `done`: resolve the item; `needs-info`: ask the ferret for more and keep it open; `dismiss`: close
 *   it unanswered. These three fit any card.
 */
export const AgendaAnswerEffectSchema = z.enum([
  'choose',
  'approve',
  'reject',
  'good',
  'clarify',
  'done',
  'needs-info',
  'dismiss',
]);
export type AgendaAnswerEffect = z.infer<typeof AgendaAnswerEffectSchema>;

/**
 * One answer on a card, bound to the swipe that gives it. Its label is what the button and the swipe
 * stamp say; for `choose` it IS the option's label, so the button and the recorded answer cannot drift.
 */
export const AgendaCardAnswerSchema = z.strictObject({
  direction: AgendaDirectionSchema,
  label: singleLine(MAX_AGENDA_ASK_OPTION_LENGTH),
  does: AgendaAnswerEffectSchema,
  description: singleLine(MAX_AGENDA_ASK_OPTION_DETAIL_LENGTH).optional(),
});
export type AgendaCardAnswer = z.infer<typeof AgendaCardAnswerSchema>;

/** The effects each ask may be answered with, beyond the `done`, `needs-info` and `dismiss` every card takes. */
const ASK_EFFECTS: Readonly<Record<AgendaAsk['kind'] | 'none', readonly AgendaAnswerEffect[]>> = {
  permission: ['approve', 'reject'],
  'multiple-choice': ['choose'],
  'answer-review': ['good', 'clarify'],
  'open-question': [],
  task: [],
  none: [],
};
const ANY_CARD_EFFECTS: readonly AgendaAnswerEffect[] = ['done', 'needs-info', 'dismiss'];

/**
 * Everything wrong with a card's answers against its ask, as `[path, message]` pairs — empty when they
 * fit: at most three, one per direction, each effect one its ask takes, and every `choose` naming one
 * of the ask's options. The schemas and the CLI both read it, so one rule refuses in both places.
 */
export function agendaAnswerProblems(
  answers: readonly AgendaCardAnswer[],
  ask: AgendaAsk | undefined,
): readonly (readonly [string, string])[] {
  const problems: (readonly [string, string])[] = [];
  if (answers.length > MAX_AGENDA_CARD_ANSWERS) {
    problems.push([
      'answers',
      `a card offers at most ${MAX_AGENDA_CARD_ANSWERS} answers (left, up, right); split it into several items, or let the reply carry the rest`,
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
export const AgendaCardShape = {
  /** What the item is about, in a few plain words: the card's heading and the push's title. */
  title: singleLine(MAX_AGENDA_TITLE_LENGTH).optional(),
  /** What kind of card it is; derived from the ask when absent (`agendaCardKind`). */
  kind: AgendaKindSchema.optional(),
  /** Up to three answers, one per direction; the kind's defaults when absent (`agendaCardAnswers`). */
  answers: z.array(AgendaCardAnswerSchema).min(1).max(MAX_AGENDA_CARD_ANSWERS).optional(),
};

const AnswerReviewResponseSchema = z.discriminatedUnion('verdict', [
  z.strictObject({ kind: z.literal('answer-review'), verdict: z.literal('good') }),
  z.strictObject({
    kind: z.literal('answer-review'),
    verdict: z.literal('clarify'),
    clarification: z.string().trim().min(1).max(MAX_AGENDA_DETAIL_LENGTH),
  }),
]);

/** One answered form field: the field's id and its value — the picked label(s), Yes or No, or the typed text. */
export const AgendaFormAnswerSchema = z.strictObject({
  id: z.string().trim().min(1).max(MAX_AGENDA_FIELD_ID_LENGTH),
  picked: z.union([
    z.string().trim().min(1).max(MAX_AGENDA_DETAIL_LENGTH),
    z.array(singleLine(MAX_AGENDA_ASK_OPTION_LENGTH)).min(1).max(MAX_AGENDA_ASK_OPTIONS),
  ]),
});
export type AgendaFormAnswer = z.infer<typeof AgendaFormAnswerSchema>;

export const AgendaResponseSchema = z.union([
  z.strictObject({ kind: z.literal('permission'), decision: z.enum(['approve', 'reject']) }),
  z.strictObject({
    kind: z.literal('multiple-choice'),
    choice: singleLine(MAX_AGENDA_ASK_OPTION_LENGTH),
  }),
  AnswerReviewResponseSchema,
  z.strictObject({
    kind: z.literal('open-question'),
    answer: z.string().trim().min(1).max(MAX_AGENDA_DETAIL_LENGTH),
  }),
  /** A form answered: each field the owner filled in, by id (`AgendaFormAnswerSchema`). */
  z.strictObject({
    kind: z.literal('form'),
    answers: z.array(AgendaFormAnswerSchema).min(1).max(MAX_AGENDA_FIELDS),
  }),
  /**
   * The owner's own words INSTEAD of the item's options — "none of these". Any ask with options takes it
   * (a choice, a permission, a review), so the ferret reads it apart from a picked option and its note.
   */
  z.strictObject({
    kind: z.literal('other'),
    answer: z.string().trim().min(1).max(MAX_AGENDA_DETAIL_LENGTH),
  }),
]);
export type AgendaResponse = z.infer<typeof AgendaResponseSchema>;

export const MAX_AGENDA_TERMS = 12;
export const MAX_AGENDA_TERM_LENGTH = 80;
export const MAX_AGENDA_TERM_MEANING_LENGTH = 400;
export const MAX_AGENDA_QUESTIONS = 6;
export const MAX_AGENDA_QUESTION_LENGTH = 600;
export const MAX_AGENDA_REASON_LENGTH = 1_024;
export const MAX_AGENDA_URGENCY_LENGTH = 120;
export const MAX_AGENDA_LINKS = 10;
export const MAX_AGENDA_LINK_LABEL_LENGTH = 120;
export const MAX_AGENDA_LINK_TARGET_LENGTH = 1_024;
/** The most steps an item carries, and the longest one: each is Markdown, one thing to do. */
export const MAX_AGENDA_STEPS = 20;
export const MAX_AGENDA_STEP_LENGTH = 2_000;
/** The longest instruction document an item carries, as one block of Markdown. */
export const MAX_AGENDA_BODY_LENGTH = 8_000;
/** The longest Markdown explanation one option carries (`optionDetails`). */
export const MAX_AGENDA_OPTION_DETAIL_MARKDOWN_LENGTH = 1_000;

const prose = (maximum: number) => z.string().trim().min(1).max(maximum);

const LIST_MARKER = /^\s*(?:[-*•]|\d+[.)])\s+/u;
const NESTED_MARKER = /^(\s*(?:[-*•]|\d+[.)])\s+)(?:(?:[-*•]|\d+[.)])\s+)+/u;

/** One point without its leading list marker ("- ", "* ", "• ", "1. "): a point is a plain line, the list adds the bullet. */
export const stripListMarker = (point: string): string => {
  const stripped = point.replace(LIST_MARKER, '').trim();
  return stripped === '' ? point.trim() : stripped;
};

/** A list of short points as markdown bullets, one per line; blank points are dropped, a stray leading marker is not doubled. */
export const toBullets = (points: readonly string[]): string =>
  points
    .map(point => stripListMarker(point.replaceAll(/\s+/gu, ' ').trim()))
    .filter(point => point !== '')
    .map(point => `- ${point}`)
    .join('\n');

/** Text already written as bullets with a second marker inside a point ("- - x") loses the extra one; anything else is kept. */
export const unnestBullets = (text: string): string => {
  const lines = text.split(/\r?\n/u).filter(line => line.trim() !== '');
  if (lines.length === 0 || !lines.every(line => LIST_MARKER.test(line))) return text;
  return text.replaceAll(new RegExp(NESTED_MARKER.source, 'gmu'), '$1');
};

/** Accepts text, or a list of points that becomes bullets — what a ferret writes, point form first. */
const asBullets = (value: unknown): unknown =>
  Array.isArray(value) && value.every((point): point is string => typeof point === 'string')
    ? toBullets(value)
    : typeof value === 'string'
      ? unnestBullets(value)
      : value;

/** One piece of jargon the item uses, spelled out for a reader who has not been following. */
export const AgendaTermSchema = z.strictObject({
  term: singleLine(MAX_AGENDA_TERM_LENGTH),
  meaning: prose(MAX_AGENDA_TERM_MEANING_LENGTH),
});
export type AgendaTerm = z.infer<typeof AgendaTermSchema>;

/**
 * One thing the owner is asked. Its options, when it has them, are what the owner picks from; its
 * `recommended` is the asker's own pick — one of those labels when there are options, the suggested
 * answer in words when there are none — and `why` is the reason for it.
 */
export const AgendaQuestionSchema = z
  .strictObject({
    question: prose(MAX_AGENDA_QUESTION_LENGTH),
    options: z.array(AgendaAskOptionSchema).min(2).max(MAX_AGENDA_ASK_OPTIONS).optional(),
    recommended: singleLine(MAX_AGENDA_ASK_OPTION_LENGTH).optional(),
    why: prose(MAX_AGENDA_REASON_LENGTH).optional(),
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
export type AgendaQuestion = z.infer<typeof AgendaQuestionSchema>;

/** How a form field is answered: pick one (radio), pick any (checkboxes), yes or no, or typed in the reply box. */
export const AgendaFieldTypeSchema = z.enum(['one', 'many', 'yesno', 'text']);
export type AgendaFieldType = z.infer<typeof AgendaFieldTypeSchema>;

/**
 * One field of a `form` card. `label` is the question; `name` is the short word its line in the answer uses
 * ("Region"), else the question is used. `one` and `many` carry their options (each can say what it means);
 * `yesno` and `text` carry none. `recommended` is the asker's pick: one option for `one`, any for `many`, Yes
 * or No for `yesno`. A field is required unless it says otherwise or is `text` (the reply box).
 */
export const AgendaFormFieldSchema = z
  .strictObject({
    id: z
      .string()
      .trim()
      .min(1)
      .max(MAX_AGENDA_FIELD_ID_LENGTH)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u, 'must be letters, digits, - or _ (e.g. 1 or region)'),
    type: AgendaFieldTypeSchema,
    label: prose(MAX_AGENDA_QUESTION_LENGTH),
    name: singleLine(MAX_AGENDA_FIELD_NAME_LENGTH).optional(),
    options: z.array(AgendaAskOptionSchema).min(2).max(MAX_AGENDA_ASK_OPTIONS).optional(),
    recommended: z.array(singleLine(MAX_AGENDA_ASK_OPTION_LENGTH)).min(1).max(MAX_AGENDA_ASK_OPTIONS).optional(),
    required: z.boolean().optional(),
  })
  .superRefine((value, context) => {
    const issue = (message: string, path: string) => context.addIssue({ code: 'custom', message, path: [path] });
    const labels = (value.options ?? []).map(option => option.label.trim());
    if (value.type === 'one' || value.type === 'many') {
      if (value.options === undefined) issue(`a ${value.type} field needs 2 or more options`, 'options');
      if (new Set(labels).size !== labels.length) issue('option labels must be unique', 'options');
    } else if (value.options !== undefined) {
      issue(`a ${value.type} field has no options`, 'options');
    }
    const picks = value.recommended ?? [];
    const allowed = value.type === 'yesno' ? ['Yes', 'No'] : labels;
    if (value.type === 'text' && picks.length > 0) issue('a text field has no recommended option', 'recommended');
    else if (value.type !== 'many' && picks.length > 1)
      issue('only a pick-many field recommends several', 'recommended');
    else if (picks.some(pick => !allowed.includes(pick.trim()))) {
      issue('a recommendation must name one of the field options', 'recommended');
    }
  });
export type AgendaFormField = z.infer<typeof AgendaFormFieldSchema>;

/** The asker's overall suggested decision, and why. */
export const AgendaRecommendationSchema = z.strictObject({
  decision: prose(MAX_AGENDA_QUESTION_LENGTH),
  why: prose(MAX_AGENDA_REASON_LENGTH).optional(),
});
export type AgendaRecommendation = z.infer<typeof AgendaRecommendationSchema>;

/**
 * The longer explanation of ONE option, as Markdown. It rides beside the options rather than inside them
 * (an option is a strict object in every app released before this field), and names its option by label.
 */
export const AgendaOptionDetailSchema = z.strictObject({
  label: singleLine(MAX_AGENDA_ASK_OPTION_LENGTH),
  detail: prose(MAX_AGENDA_OPTION_DETAIL_MARKDOWN_LENGTH),
});
export type AgendaOptionDetail = z.infer<typeof AgendaOptionDetailSchema>;

/** A PR, a file or a reference the reader may want to open. The target is a URL, a path or a reference. */
export const AgendaLinkSchema = z.strictObject({
  label: singleLine(MAX_AGENDA_LINK_LABEL_LENGTH).optional(),
  target: singleLine(MAX_AGENDA_LINK_TARGET_LENGTH),
});
export type AgendaLink = z.infer<typeof AgendaLinkSchema>;

/**
 * THE STRUCTURED PART OF AN ITEM, every field optional so an item raised before it existed still
 * reads. The item's `subject` is its SUMMARY (one line: what is needed) and `context` is the facts
 * around it; these carry the rest of what a reader who has not been following
 * needs (docs/agenda.md, "What an item says").
 */
export const AgendaBriefShape = {
  /** The situation the item comes out of — what is going on — in point form, so a cold reader starts here. */
  premise: z.preprocess(asBullets, prose(MAX_AGENDA_REASON_LENGTH)).optional(),
  /** Earlier answers that bear on this one, in point form: what the owner already decided. */
  decided: z.preprocess(asBullets, prose(MAX_AGENDA_REASON_LENGTH)).optional(),
  /**
   * What is STILL OPEN after the discussion so far, in point form: it shrinks as `decided` grows, so a card read
   * after several rounds of talk says where things stand, not where they started.
   */
  stillOpen: z.preprocess(asBullets, prose(MAX_AGENDA_REASON_LENGTH)).optional(),
  /** Jargon the item uses, each spelled out. */
  terms: z.array(AgendaTermSchema).min(1).max(MAX_AGENDA_TERMS).optional(),
  /** What the owner is asked, one entry per decision. */
  questions: z.array(AgendaQuestionSchema).min(1).max(MAX_AGENDA_QUESTIONS).optional(),
  /** The asker's overall suggested decision. */
  recommendation: AgendaRecommendationSchema.optional(),
  /** A longer Markdown explanation per option, each naming its option by label: the card's Options section. */
  optionDetails: z.array(AgendaOptionDetailSchema).min(1).max(MAX_AGENDA_ASK_OPTIONS).optional(),
  /** The fields of a `form` card, in order: what the owner fills in before one Send (`agendaFormProblems`). */
  fields: z.array(AgendaFormFieldSchema).min(1).max(MAX_AGENDA_FIELDS).optional(),
  /** What happens if nobody answers. */
  impact: z.preprocess(asBullets, prose(MAX_AGENDA_REASON_LENGTH)).optional(),
  /** By when it matters, in words: "before the 14:00 deploy", "no rush". */
  urgency: singleLine(MAX_AGENDA_URGENCY_LENGTH).optional(),
  /** It stops the ferret NOW: nothing else can move until the owner answers ("Blocking now"). */
  blockingNow: z.literal(true).optional(),
  /** What it WILL block when the ferret gets there, in a few words ("Will block: the deploy"). */
  willBlock: singleLine(MAX_AGENDA_URGENCY_LENGTH).optional(),
  /** When the owner's answer is needed by (`--by`): a few hours before, the owner is pinged once. */
  neededBy: InstantSchema.optional(),
  /** PRs, files and references worth opening. */
  links: z.array(AgendaLinkSchema).min(1).max(MAX_AGENDA_LINKS).optional(),
  /** Ordered Markdown steps the owner follows, one thing to do each: complete instructions, never a secret. */
  steps: z.array(prose(MAX_AGENDA_STEP_LENGTH)).min(1).max(MAX_AGENDA_STEPS).optional(),
  /** Instructions that are not a list, as one Markdown document. */
  body: prose(MAX_AGENDA_BODY_LENGTH).optional(),
  /**
   * The ferret's answer to the owner's QUESTION about the item, shown above the item's own options, which stay live:
   * the ask is still waiting for the owner's own answer, and this block never closes it.
   */
  questionAnswer: prose(MAX_AGENDA_BODY_LENGTH).optional(),
};

/** The structured fields of an item, alone. */
export type AgendaBrief = {
  readonly [K in keyof typeof AgendaBriefShape]?: z.infer<(typeof AgendaBriefShape)[K]>;
};

/** Just the structured fields an item or a request carries, with the absent ones left out. */
export const agendaBriefOf = (value: AgendaBrief): AgendaBrief => ({
  ...(value.premise === undefined ? {} : { premise: value.premise }),
  ...(value.decided === undefined ? {} : { decided: value.decided }),
  ...(value.stillOpen === undefined ? {} : { stillOpen: value.stillOpen }),
  ...(value.terms === undefined ? {} : { terms: value.terms }),
  ...(value.questions === undefined ? {} : { questions: value.questions }),
  ...(value.recommendation === undefined ? {} : { recommendation: value.recommendation }),
  ...(value.optionDetails === undefined ? {} : { optionDetails: value.optionDetails }),
  ...(value.fields === undefined ? {} : { fields: value.fields }),
  ...(value.impact === undefined ? {} : { impact: value.impact }),
  ...(value.urgency === undefined ? {} : { urgency: value.urgency }),
  ...(value.blockingNow === undefined ? {} : { blockingNow: value.blockingNow }),
  ...(value.willBlock === undefined ? {} : { willBlock: value.willBlock }),
  ...(value.neededBy === undefined ? {} : { neededBy: value.neededBy }),
  ...(value.links === undefined ? {} : { links: value.links }),
  ...(value.steps === undefined ? {} : { steps: value.steps }),
  ...(value.body === undefined ? {} : { body: value.body }),
  ...(value.questionAnswer === undefined ? {} : { questionAnswer: value.questionAnswer }),
});

/** Every option label an item offers: its ask's options, each question's options and its `choose` answers. */
export const agendaOptionLabels = (item: {
  readonly ask?: AgendaAsk | undefined;
  readonly questions?: readonly AgendaQuestion[] | undefined;
  readonly answers?: readonly AgendaCardAnswer[] | undefined;
}): readonly string[] => [
  ...(item.ask?.kind === 'multiple-choice' ? item.ask.options.map(option => option.label.trim()) : []),
  ...(item.questions ?? []).flatMap(question => (question.options ?? []).map(option => option.label.trim())),
  ...(item.answers ?? []).filter(answer => answer.does === 'choose').map(answer => answer.label.trim()),
];

/** What is wrong with an item's `optionDetails`: a label that names no option, or one named twice. */
export const agendaOptionDetailProblems = (item: {
  readonly ask?: AgendaAsk | undefined;
  readonly questions?: readonly AgendaQuestion[] | undefined;
  readonly answers?: readonly AgendaCardAnswer[] | undefined;
  readonly optionDetails?: readonly AgendaOptionDetail[] | undefined;
}): string[] => {
  const details = item.optionDetails;
  if (details === undefined) return [];
  const labels = new Set(agendaOptionLabels(item));
  const named = details.map(detail => detail.label.trim());
  return [
    ...(new Set(named).size === named.length ? [] : ['optionDetails may explain each option once']),
    ...named
      .filter(label => !labels.has(label))
      .map(label => `optionDetails names "${label}", which is not one of the options`),
  ];
};

/** What is wrong with a form's fields: an id used twice, or more than one free-text field (the reply box is one). */
export const agendaFormProblems = (item: {
  readonly kind?: AgendaKind | undefined;
  readonly fields?: readonly AgendaFormField[] | undefined;
}): string[] => {
  const fields = item.fields;
  if (fields === undefined) return item.kind === 'form' ? ['a form needs at least one field (--field)'] : [];
  if (item.kind !== undefined && item.kind !== 'form') return ['fields belong to a form (--kind form)'];
  const ids = fields.map(field => field.id);
  return [
    ...(new Set(ids).size === ids.length ? [] : ['every field needs its own id']),
    ...(fields.filter(field => field.type === 'text').length > 1
      ? ['a form has one free-text field: the reply box. Put the rest in separate fields or in that one answer']
      : []),
  ];
};

/**
 * What a raise may not say when it is a NOTICE (`fy notify`): a notice is read, not answered, so it carries no
 * ask, answers or steps and is kind info; and only a notice can ask the phone to buzz (`ping`).
 */
export const agendaNoticeProblems = (value: {
  readonly notice?: true | undefined;
  readonly ping?: true | undefined;
  readonly ask?: unknown;
  readonly answers?: readonly unknown[] | undefined;
  readonly steps?: readonly unknown[] | undefined;
  readonly kind?: string | undefined;
}): string[] => {
  if (value.notice !== true) return value.ping === true ? ['ping is only for a notice'] : [];
  return [
    ...(value.ask === undefined ? [] : ['a notice has no ask']),
    ...(value.answers === undefined ? [] : ['a notice has no answers']),
    ...(value.steps === undefined ? [] : ['a notice has no steps: it is read, not done']),
    ...(value.kind === undefined || value.kind === 'info' ? [] : ['a notice is kind info']),
  ];
};

/**
 * What a NEW ferret-raised item lacks of the two fields a cold reader starts from: the premise (the situation)
 * and the context (the facts around it). Both are required on every new item a ferret raises; a notice is read,
 * not answered, so it is exempt, and an item already on the board keeps working without them — this is checked
 * when an item is raised, never when one is read. A blank field counts as missing.
 */
export const agendaBriefRequiredProblems = (value: {
  readonly notice?: true | undefined;
  readonly premise?: string | undefined;
  readonly context?: string | null | undefined;
}): string[] => {
  if (value.notice === true) return [];
  const blank = (field: string | null | undefined): boolean => (field ?? '').trim() === '';
  return [
    ...(blank(value.premise) ? ['premise (--premise) is required: the situation, what is going on'] : []),
    ...(blank(value.context) ? ['context (--context) is required: the facts around it'] : []),
  ];
};

/** The agenda fields an edit can clear: they have no empty value to write, so clearing is named. */
export const AgendaClearableFieldSchema = z.enum(['blockingNow', 'willBlock', 'neededBy']);
export type AgendaClearableField = z.infer<typeof AgendaClearableFieldSchema>;

/**
 * The one question an item asks, when it asks exactly one — the only case where its options are
 * also the item's own answers (and so the swipe deck's). An item with several questions is answered
 * in words, one answer per question.
 */
export const singleAgendaQuestion = (brief: AgendaBrief): AgendaQuestion | undefined =>
  brief.questions?.length === 1 ? brief.questions[0] : undefined;

/**
 * The option an item recommends, when it has a choice ask: its single question's recommendation, or
 * the overall recommendation when it names one of the options exactly.
 */
export const recommendedAgendaOption = (item: AgendaBrief & { readonly ask?: AgendaAsk }): string | undefined => {
  if (item.ask?.kind !== 'multiple-choice') return undefined;
  const labels = item.ask.options.map(option => option.label.trim());
  const candidates = [singleAgendaQuestion(item)?.recommended, item.recommendation?.decision];
  return candidates
    .map(candidate => candidate?.trim())
    .find(candidate => candidate !== undefined && labels.includes(candidate));
};

/** The most entries an item's history keeps, oldest dropped. */
export const MAX_AGENDA_HISTORY = 20;

/**
 * One thing that happened to an item after it was raised, for "You asked for more info 10:42 · updated 10:44":
 * the owner asked for more information (`needs-info`) or to talk it through (`discuss`), the ferret
 * updated it (`updated`), the item left discussion for the queue (`surfaced`, the why as its note), or the
 * owner replied and it was PARKED as replied (`replied`, their words as its note; the ferret's `surface` or
 * `edit` brings it back, its `done` closes it).
 */
export const AgendaHistoryEntrySchema = z.strictObject({
  at: InstantSchema,
  kind: z.enum(['needs-info', 'discuss', 'updated', 'surfaced', 'replied']),
  note: z.string().trim().min(1).max(MAX_AGENDA_DETAIL_LENGTH).optional(),
});
export type AgendaHistoryEntry = z.infer<typeof AgendaHistoryEntrySchema>;

/**
 * WHY AN OPEN ITEM IS PARKED — off the owner's queue for now, with its way back (docs/agenda.md § Parked items):
 *
 * - `snoozed` — the owner put it away `until` a time ("waiting for approval"); the daemon wakes it then, or at
 *   its `neededBy` when that is sooner, as a fresh item. The ferret's `edit` or `surface` leaves it asleep
 *   unless it says it is urgent (`now`).
 * - `replied` — the owner wrote about it in the chat; it waits for the ferret to bring it back (`surface` or
 *   `edit`) if the owner still has to act, or to close it (`done`).
 *
 * `at` is when it was parked. A parked item is nobody's turn (`agendaTurn`): it is never "needs you", never a
 * badge, never in the Inbox's open list.
 */
export const AgendaParkedSchema = z.discriminatedUnion('reason', [
  z.strictObject({ reason: z.literal('snoozed'), at: InstantSchema, until: InstantSchema }),
  z.strictObject({ reason: z.literal('replied'), at: InstantSchema }),
]);
export type AgendaParked = z.infer<typeof AgendaParkedSchema>;

/**
 * When a SNOOZED item wakes: its `until`, or its `neededBy` when that comes first — a deadline is never slept
 * through. `null` for an item that is not snoozed.
 */
export const agendaWakeAt = (item: {
  readonly parked?: AgendaParked | undefined;
  readonly neededBy?: string | undefined;
}): string | null => {
  if (item.parked?.reason !== 'snoozed') return null;
  const { until } = item.parked;
  return item.neededBy !== undefined && Date.parse(item.neededBy) < Date.parse(until) ? item.neededBy : until;
};

/**
 * The number a badge shows for a board: its open items less the PARKED ones (snoozed, or replied to), which wait
 * on nobody. A snapshot's `count` stays every open item — the wire checks `count === items.length`.
 */
export const agendaBadgeCount = (snapshot: { readonly items: readonly { readonly parked?: unknown }[] }): number =>
  snapshot.items.filter(item => item.parked === undefined).length;

/** How often a ferret may wake an item the owner snoozed (`now`): once an hour per item. */
export const AGENDA_URGENT_WAKE_MS = 60 * 60_000;

/** The most revisions an item keeps, oldest dropped. */
export const MAX_AGENDA_REVISIONS = 10;

/** The fields an edit can change, by name: what a revision says changed. */
export const AgendaRevisableFieldSchema = z.enum([
  'subject',
  'why',
  'context',
  'howToResolve',
  'ask',
  'title',
  'kind',
  'answers',
  'premise',
  'decided',
  'stillOpen',
  'terms',
  'questions',
  'recommendation',
  'optionDetails',
  'fields',
  'impact',
  'urgency',
  'blockingNow',
  'willBlock',
  'neededBy',
  'links',
  'steps',
  'body',
  'questionAnswer',
]);
export type AgendaRevisableField = z.infer<typeof AgendaRevisableFieldSchema>;

/**
 * ONE EDIT OF AN ITEM, kept so a card that is a living summary of its discussion can show what changed and what
 * it said before: who edited it, when, which fields changed, and those fields as they were (`previous` — a field
 * absent there was absent before the edit).
 */
export const AgendaRevisionSchema = z.strictObject({
  at: InstantSchema,
  by: z.enum(['human', 'agent', 'daemon']),
  changed: z.array(AgendaRevisableFieldSchema).min(1),
  previous: z.strictObject({
    subject: singleLine(MAX_AGENDA_SUBJECT_LENGTH).optional(),
    why: z.string().trim().min(1).max(MAX_AGENDA_DETAIL_LENGTH).optional(),
    context: z.string().max(MAX_AGENDA_DETAIL_LENGTH).nullable().optional(),
    howToResolve: z.string().trim().min(1).max(MAX_AGENDA_DETAIL_LENGTH).optional(),
    ask: AgendaAskSchema.optional(),
    ...AgendaCardShape,
    ...AgendaBriefShape,
  }),
});
export type AgendaRevision = z.infer<typeof AgendaRevisionSchema>;

/**
 * How a closed item ended: answered or resolved (`done`), closed unanswered (`dismissed`), or the owner wrote
 * about it and nothing more is needed unless the ferret asks again (`replied`; the ferret reopens it with
 * `surface` or `edit`).
 */
export const AgendaDispositionSchema = z.enum(['done', 'dismissed', 'replied']);
export type AgendaDisposition = z.infer<typeof AgendaDispositionSchema>;

export const AgendaIdSchema = z.string().regex(/^A[1-9][0-9]*$/u);
export type AgendaId = z.infer<typeof AgendaIdSchema>;

export const AgendaBySchema = z.enum(['human', 'agent', 'daemon']);
export type AgendaBy = z.infer<typeof AgendaBySchema>;

/**
 * What the owner did on the board that never reached the ferret, kept so the app can offer Retry: posting
 * `{ ...reply, id }` to the board is the same action again. Each variant is the matching action request
 * without its id.
 */
export const AgendaUndeliveredReplySchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('resolve'),
    note: z.string().max(MAX_AGENDA_DETAIL_LENGTH).optional(),
    response: AgendaResponseSchema.optional(),
  }),
  z.strictObject({
    action: z.literal('dismiss'),
    note: z.string().max(MAX_AGENDA_DETAIL_LENGTH).optional(),
  }),
  z.strictObject({
    action: z.literal('needs-info'),
    note: z.string().trim().min(1).max(MAX_AGENDA_DETAIL_LENGTH).optional(),
  }),
  z.strictObject({
    action: z.literal('discuss'),
    note: z.string().trim().min(1).max(MAX_AGENDA_DETAIL_LENGTH).optional(),
  }),
]);
export type AgendaUndeliveredReply = z.infer<typeof AgendaUndeliveredReplySchema>;

/**
 * Set on an item whose answer (or request to discuss, or for more information) the owner gave on the board
 * but that was never proven to reach the ferret (docs/agenda.md § Delivery): the item is open again, as a
 * card, until the owner answers it again or retries. Cleared by the owner's next action on it.
 */
export const AgendaUndeliveredSchema = z.strictObject({
  at: InstantSchema,
  reply: AgendaUndeliveredReplySchema,
  /** Why it did not arrive, in words a person reads. */
  reason: z.string().trim().min(1).max(MAX_AGENDA_DETAIL_LENGTH),
});
export type AgendaUndelivered = z.infer<typeof AgendaUndeliveredSchema>;

/** The longest configuration file path a confirmation names: a file under the config directory. */
export const MAX_AGENDA_CONFIRMS_PATH_LENGTH = 256;
/** The most loosenings one confirmation lists, each the daemon's own words for it. */
export const MAX_AGENDA_CONFIRMS_CHANGES = 12;

/**
 * The answers of an item that confirms a held configuration change (docs/agenda.md § Confirming a
 * configuration change): the option labels ARE the decision, so a card that knows nothing about
 * confirmations still answers it correctly by choosing one.
 */
export const AGENDA_CONFIRMS_ANSWERS = {
  /** Put the held change into effect, if it is still the one the card shows. */
  allow: 'Allow',
  /** Leave it held: nothing is discarded, the tighter version stays in effect. */
  deny: 'Deny',
  /** Put the file back to the version in effect, dropping the held change. */
  discard: 'Discard change',
} as const;

/**
 * THE HELD CONFIGURATION CHANGE an item asks the owner to confirm (`fy agenda add --confirms <file>`):
 * the file, the digest of the held edit (its etag, so Allow confirms exactly the change the card
 * shows and never a later one), and each loosening in the daemon's words. `restated` is set when the
 * held edit changed after the item was raised and the card was re-armed with the new one.
 */
export const AgendaConfirmsSchema = z.strictObject({
  path: singleLine(MAX_AGENDA_CONFIRMS_PATH_LENGTH),
  etag: singleLine(MAX_AGENDA_CONFIRMS_PATH_LENGTH),
  changes: z.array(singleLine(MAX_AGENDA_WARNING_LENGTH)).min(1).max(MAX_AGENDA_CONFIRMS_CHANGES),
  restated: z.literal(true).optional(),
});
export type AgendaConfirms = z.infer<typeof AgendaConfirmsSchema>;

/**
 * The input request an `input` card presents (docs/input-requests.md). The request itself, its facts and its
 * deadline live in `input-request.ts`; the id here is the same 128-bit hex.
 */
export const AgendaInputRefSchema = z.strictObject({ requestId: z.string().regex(/^[0-9a-f]{32}$/u) });
export type AgendaInputRef = z.infer<typeof AgendaInputRefSchema>;

/**
 * The paste plan a card presents (docs/secure-copy.md): a ferret's planned pastes, answered with the plan's own
 * Allow and Decline, which only the owner's plan route carries. Only the daemon raises one.
 */
export const AgendaCopyPlanRefSchema = z.strictObject({ planId: z.string().regex(/^[0-9a-f]{32}$/u) });
export type AgendaCopyPlanRef = z.infer<typeof AgendaCopyPlanRefSchema>;

/**
 * The task plan a card presents (task-plan.ts, docs/secure-copy.md): a ferret's planned sign-ins and pastes, answered
 * by the plan's own ticks, picks and passkey, which only the owner's plan routes carry. Only the daemon raises one. An
 * app from before task plans drops the ref and reads the card's `copyPlan`, or the daemon's words, instead.
 */
export const AgendaTaskPlanRefSchema = z.strictObject({ planId: z.string().regex(/^[0-9a-f]{32}$/u) });
export type AgendaTaskPlanRef = z.infer<typeof AgendaTaskPlanRefSchema>;

/**
 * The approve-on-phone card an `info` item presents (phone-approval.ts): nothing typed, nothing of the ferret's shown,
 * answered by the owner's phone and settled only by what the daemon sees. Only the daemon raises one. An app from
 * before these cards drops the ref and shows a plain info card with the daemon's subject, which holds no number.
 */
export const AgendaPhoneApprovalRefSchema = z.strictObject({
  id: z.string().regex(/^pa_[0-9a-f]{24}$/u, 'a phone approval id is pa_ and 24 hex digits'),
});
export type AgendaPhoneApprovalRef = z.infer<typeof AgendaPhoneApprovalRefSchema>;

/**
 * A 2FA seed staged at the machine and waiting for the owner's passkey (docs/secrets.md, "2FA keys"): the card's
 * Allow runs the `add-2fa-key` ceremony bound to `stage` and saves it to `account`, and Deny drops it. The generic
 * agenda answer saves nothing, so an app from before these cards shows the daemon's words and cannot save. Only the
 * daemon raises one.
 */
export const AgendaTwoFactorSeedRefSchema = z.strictObject({
  stage: TwoFactorStageIdSchema,
  account: AccountIdSchema,
});
export type AgendaTwoFactorSeedRef = z.infer<typeof AgendaTwoFactorSeedRefSchema>;

/**
 * What an `input` card may not be, and must be: it carries its request, and no ask, answers, steps or
 * confirmation of its own (the form answers it), and it is never a notice. Anything but an `input` card
 * carries no request.
 */
export const agendaInputProblems = (value: {
  readonly kind?: string | undefined;
  readonly input?: unknown;
  readonly ask?: unknown;
  readonly answers?: readonly unknown[] | undefined;
  readonly steps?: readonly unknown[] | undefined;
  readonly confirms?: unknown;
  readonly notice?: true | undefined;
}): string[] => {
  if (value.kind !== 'input') return value.input === undefined ? [] : ['only an input card carries an input request'];
  return [
    ...(value.input === undefined ? ['an input card names its input request'] : []),
    ...(value.ask === undefined ? [] : ['an input card has no ask: the form answers it']),
    ...(value.answers === undefined ? [] : ['an input card has no swipe answers']),
    ...(value.steps === undefined ? [] : ['an input card has no steps']),
    ...(value.confirms === undefined ? [] : ['an input card does not confirm a configuration change']),
    ...(value.notice === undefined ? [] : ['an input card is not a notice']),
  ];
};

/** The `409` code of an Allow or Discard that found the held change moved on: the card shows the new one. */
export const AGENDA_CONFIG_CHANGED_CODE = 'config_changed';

const AgendaItemBaseShape = {
  id: AgendaIdSchema,
  source: AgendaSourceSchema,
  sourceRef: z.string().max(MAX_AGENDA_SOURCE_REF_LENGTH).nullable(),
  sourceSeq: PositiveIntegerSchema.optional(),
  subject: singleLine(MAX_AGENDA_SUBJECT_LENGTH),
  why: z.string().trim().min(1).max(MAX_AGENDA_DETAIL_LENGTH),
  context: z.string().max(MAX_AGENDA_DETAIL_LENGTH).nullable().optional(),
  waitingSince: InstantSchema,
  howToResolve: z.string().trim().min(1).max(MAX_AGENDA_DETAIL_LENGTH),
  ask: AgendaAskSchema.optional(),
  ...AgendaCardShape,
  ...AgendaBriefShape,
  /** The indices of the steps the owner has ticked: sorted, unique, each below `steps.length`; absent when none. */
  stepsDone: z.array(NonNegativeIntegerSchema).min(1).max(MAX_AGENDA_STEPS).optional(),
  /**
   * Set while the item waits on its raising ferret: the ask is IN DISCUSSION (every ferret-raised ask starts
   * there, until `surface`), or the owner asked for more information and it has not yet updated it.
   */
  waitingOn: z.literal('ferret').optional(),
  /** When the wait began (the raise, for an ask born in discussion); present exactly while `waitingOn` is. */
  askedAt: InstantSchema.optional(),
  /**
   * What the wait is FOR, only while `waitingOn` is set: `discussion` while the ask is being talked through in
   * the ferret's chat, before it reaches the owner's queue ("in discussion"); an ask a ferret raises starts
   * there, and the owner's `discuss` puts a surfaced one back. Absent reads as `info`, so an item written
   * before discussions existed reads exactly as it did.
   */
  waitingFor: z.enum(['info', 'discussion']).optional(),
  /** How many times the owner has asked for more information or to discuss it: one request counter for both. */
  infoRequests: PositiveIntegerSchema.optional(),
  /** Bounded, oldest first: when the owner asked for more information and when the ferret added it. */
  history: z.array(AgendaHistoryEntrySchema).min(1).max(MAX_AGENDA_HISTORY).optional(),
  /** Bounded, oldest first: every edit since the item was raised (`AgendaRevision`). Absent: never edited. */
  revisions: z.array(AgendaRevisionSchema).min(1).max(MAX_AGENDA_REVISIONS).optional(),
  /** Off the owner's queue for now, and why (`AgendaParked`); absent on an item in play. */
  parked: AgendaParkedSchema.optional(),
  /** When the ferret last woke a snoozed item as urgent (`now`): it may again only `AGENDA_URGENT_WAKE_MS` later. */
  urgentAt: InstantSchema.optional(),
  /** The owner's last action on this item never reached the ferret; present only on an open item. */
  undelivered: AgendaUndeliveredSchema.optional(),
  /**
   * A PLAIN NOTIFICATION (`fy notify`), not an agenda item: a summary the owner reads in the ferret's Inbox
   * group and taps to open its chat. It has no answers and no turn; reading or clearing it resolves it. An old
   * app reads it as an info card.
   */
  notice: z.literal(true).optional(),
  /** The ferret asked for the phone to buzz for this notification (`fy notify --ping`). */
  ping: z.literal(true).optional(),
  /** The held configuration change the owner's Allow puts into effect (`AgendaConfirms`). */
  confirms: AgendaConfirmsSchema.optional(),
  /**
   * The board card this item belongs to (`board.ts`): the card derives "waiting on you" from its open,
   * blocking items. Absent or `null` reads as "no card": an item raised before cards existed, or by a client
   * that named none. An older app reading a newer board drops the field.
   */
  task: TaskRefSchema.nullable().optional(),
  /**
   * The owner's one tap may close the linked card too: the answer row offers "Done · closes &F12". Set by
   * `fy agenda add --offer-close`, and by the daemon for a to-do or review on a card in the to-test lane.
   */
  offerClose: z.literal(true).optional(),
  /** The input request an `input` card presents; present exactly on that kind (`agendaInputProblems`). */
  input: AgendaInputRefSchema.optional(),
  /** The paste plan a card presents: the plan's own form answers it, never the generic answer. */
  copyPlan: AgendaCopyPlanRefSchema.optional(),
  /** The task plan a card presents: the plan's own form and passkey answer it, never the generic answer. */
  taskPlan: AgendaTaskPlanRefSchema.optional(),
  /** The approve-on-phone card an `info` item presents; only an `info` item carries one. */
  phoneApproval: AgendaPhoneApprovalRefSchema.optional(),
  /** The staged 2FA seed a card asks the owner to save with a passkey; answered by that ceremony, never the generic answer. */
  twoFactorSeed: AgendaTwoFactorSeedRefSchema.optional(),
};

export const AgendaItemSchema = z
  .discriminatedUnion('raisedBy', [
    z.object({
      ...AgendaItemBaseShape,
      raisedBy: z.literal('human'),
      raisedBySession: z.null(),
      raisedByName: z.null(),
    }),
    z.object({
      ...AgendaItemBaseShape,
      raisedBy: z.literal('agent'),
      raisedBySession: z.string().min(1),
      raisedByName: z.string().nullable(),
    }),
    z.object({
      ...AgendaItemBaseShape,
      raisedBy: z.literal('daemon'),
      raisedBySession: z.null(),
      raisedByName: z.null(),
    }),
  ])
  .superRefine((value, context) => {
    for (const [path, message] of agendaAnswerProblems(value.answers ?? [], value.ask)) {
      context.addIssue({ code: 'custom', message, path: path.split('.') });
    }
    for (const message of agendaOptionDetailProblems(value)) {
      context.addIssue({ code: 'custom', message, path: ['optionDetails'] });
    }
    for (const problem of agendaInputProblems(value)) {
      context.addIssue({ code: 'custom', message: problem, path: ['input'] });
    }
    if (value.phoneApproval !== undefined && value.kind !== 'info') {
      context.addIssue({
        code: 'custom',
        message: 'only an info card presents a phone approval',
        path: ['phoneApproval'],
      });
    }
    for (const problem of agendaFormProblems(value)) {
      context.addIssue({ code: 'custom', message: problem, path: ['fields'] });
    }
    if (value.sourceSeq !== undefined && value.source !== 'agent-raised') {
      context.addIssue({ code: 'custom', message: 'sourceSeq is valid only for agent-raised agenda items' });
    }
    if ((value.waitingOn === undefined) !== (value.askedAt === undefined)) {
      context.addIssue({ code: 'custom', message: 'waitingOn and askedAt are set together', path: ['askedAt'] });
    }
    if (value.waitingFor !== undefined && value.waitingOn === undefined) {
      context.addIssue({ code: 'custom', message: 'waitingFor is set only while waitingOn is', path: ['waitingFor'] });
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
export type AgendaItem = z.infer<typeof AgendaItemSchema>;

const ResolvedAgendaBaseShape = {
  resolvedAt: InstantSchema,
  resolutionNote: z.string().max(MAX_AGENDA_DETAIL_LENGTH).nullable(),
  response: AgendaResponseSchema.optional(),
  disposition: AgendaDispositionSchema,
};

const AgendaResolutionSchema = z.discriminatedUnion('resolvedBy', [
  z.object({
    ...ResolvedAgendaBaseShape,
    resolvedBy: z.literal('human'),
    resolvedBySession: z.null(),
    resolvedByName: z.null(),
  }),
  z.object({
    ...ResolvedAgendaBaseShape,
    resolvedBy: z.literal('agent'),
    resolvedBySession: z.string().min(1),
    resolvedByName: z.string().nullable(),
  }),
  z.object({
    ...ResolvedAgendaBaseShape,
    resolvedBy: z.literal('daemon'),
    resolvedBySession: z.null(),
    resolvedByName: z.null(),
  }),
]);

/** A response fits its ask by kind, except `other`: the owner's own words, which any ask with options takes. */
function responseKindFitsAsk(ask: string | undefined, response: string): boolean {
  if (response === 'other') return ask !== undefined && ask !== 'open-question' && ask !== 'task';
  return ask === response;
}

export const ResolvedAgendaItemSchema = z
  .intersection(AgendaItemSchema, AgendaResolutionSchema)
  .superRefine((value, context) => {
    if (value.disposition !== 'done' && value.response !== undefined) {
      context.addIssue({ code: 'custom', message: 'only a done item may carry a response', path: ['response'] });
    }
    // A form is asked as an open question (an old app still lets the owner reply) but answered by field.
    const answeredAsForm = value.kind === 'form' && value.response?.kind === 'form';
    if (value.response !== undefined && !answeredAsForm && !responseKindFitsAsk(value.ask?.kind, value.response.kind)) {
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
export type ResolvedAgendaItem = z.infer<typeof ResolvedAgendaItemSchema>;

/**
 * The owner's answers a machine is holding for one ferret, to deliver them as ONE message once the owner
 * stops answering (docs/agenda.md § The loop). Present on the board while anything is held, so the app
 * can say "sending in 8 s" and offer "Send now" (`POST /v1/sessions/:sessionId/attention/replies`).
 */
export const AgendaRepliesSchema = z.strictObject({
  pending: z.array(AgendaIdSchema).min(1).max(MAX_AGENDA_RESOLUTIONS),
  dueAt: InstantSchema,
  /**
   * Present once `dueAt` has passed while the ferret is still mid-turn: the batch is held until that turn
   * ends, so answers given meanwhile join it. "Send now" still delivers at once.
   */
  heldForTurn: z.literal(true).optional(),
});
export type AgendaReplies = z.infer<typeof AgendaRepliesSchema>;

/**
 * Where the owner's answers to one ferret stand past the settle window (docs/agenda.md § Delivery). A
 * sibling of `replies` rather than more fields on it, so an app that reads `replies` strictly still reads
 * a board from a newer machine.
 */
export const AgendaDeliverySchema = z.strictObject({
  /** Items whose answer was handed to the ferret and is not yet proven in its transcript: "Sending…". */
  sending: z.array(AgendaIdSchema).max(MAX_AGENDA_RESOLUTIONS),
  /**
   * Present while held answers are due but the ferret's composer holds text (a person's draft) or could
   * not be read: nothing is typed into it until it is empty.
   */
  heldForComposer: z.literal(true).optional(),
});
export type AgendaDelivery = z.infer<typeof AgendaDeliverySchema>;

export const AgendaSnapshotSchema = z
  .object({
    v: z.literal(AGENDA_SCHEMA_VERSION),
    sessionId: z.string().min(1),
    items: z.array(AgendaItemSchema).max(MAX_AGENDA_PER_SESSION),
    resolved: z.array(ResolvedAgendaItemSchema).max(MAX_AGENDA_RESOLUTIONS),
    count: NonNegativeIntegerSchema,
    parseErrors: NonNegativeIntegerSchema,
    updatedAt: InstantSchema,
    /** Writing advice for the item just raised or edited; present only on that response. */
    warnings: z.array(z.string().trim().min(1).max(MAX_AGENDA_WARNING_LENGTH)).max(MAX_AGENDA_WARNINGS).optional(),
    /**
     * How many devices this machine has enrolled for push, counted as an item was raised; present only on
     * the response to that raise. Zero means the owner was told nothing: the ask is on the board, and no
     * phone or browser will hear of it until one turns notifications on.
     */
    enrolled: NonNegativeIntegerSchema.optional(),
    /** Answers held for this ferret and when they go; absent when nothing is held. */
    replies: AgendaRepliesSchema.optional(),
    /** Answers on their way to the ferret and not yet proven to arrive; absent when there are none. */
    delivery: AgendaDeliverySchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.count !== value.items.length) {
      context.addIssue({ code: 'custom', message: 'count must equal the number of active items', path: ['count'] });
    }
    const activeIds = new Set(value.items.map(item => item.id));
    if (activeIds.size !== value.items.length) {
      context.addIssue({ code: 'custom', message: 'active agenda ids must be unique', path: ['items'] });
    }
    const resolvedIds = value.resolved.map(item => item.id);
    if (new Set(resolvedIds).size !== resolvedIds.length) {
      context.addIssue({ code: 'custom', message: 'resolved agenda ids must be unique', path: ['resolved'] });
    }
    if (resolvedIds.some(id => activeIds.has(id))) {
      context.addIssue({ code: 'custom', message: 'active and resolved agenda ids must be disjoint' });
    }
  });
export type AgendaSnapshot = z.infer<typeof AgendaSnapshotSchema>;

const AddAgendaRequestSchema = z.strictObject({
  action: z.literal('add'),
  ...AgendaCardShape,
  source: z.literal('agent-raised').default('agent-raised'),
  sourceRef: z.string().max(MAX_AGENDA_SOURCE_REF_LENGTH).nullable().default(null),
  subject: singleLine(MAX_AGENDA_SUBJECT_LENGTH),
  why: z.string().trim().min(1).max(MAX_AGENDA_DETAIL_LENGTH),
  context: z.preprocess(asBullets, z.string().max(MAX_AGENDA_DETAIL_LENGTH)).nullable().optional(),
  howToResolve: z.string().trim().min(1).max(MAX_AGENDA_DETAIL_LENGTH),
  ask: AgendaAskSchema.optional(),
  /** Sent by older CLIs: a new ask is the owner's turn now, so there is nothing to surface to. Accepted, ignored. */
  surface: z.boolean().optional(),
  /** A plain notification (`fy notify`): kind info, no ask or answers, never a turn (docs/agenda.md). */
  notice: z.literal(true).optional(),
  /** The ferret asked for the phone to buzz for this notice; only a notice can ask. */
  ping: z.literal(true).optional(),
  /**
   * The configuration file whose HELD change this item asks the owner to confirm (`--confirms`). The daemon
   * records the held edit's digest and words and writes the card's ask and answers; refused when the file has
   * no held change.
   */
  confirms: singleLine(MAX_AGENDA_CONFIRMS_PATH_LENGTH).optional(),
  /**
   * The board card the item belongs to. A daemon released before this field (4.111 and every older one)
   * refuses an add that carries it, so a client sends it only to a daemon that reports
   * `DAEMON_FEATURES.agendaTask`.
   */
  task: TaskRefSchema.optional(),
  /**
   * Offer the owner a "Done · closes &F12" answer that also closes the item's card (`--offer-close`). A daemon
   * without `DAEMON_FEATURES.agendaOfferClose` refuses the whole add, so a client sends it only to one that has it.
   */
  offerClose: z.literal(true).optional(),
  ...AgendaBriefShape,
});

/** What an offer to close may not be: a notice has no answers to carry it. */
export const agendaOfferCloseProblems = (value: {
  readonly offerClose?: true | undefined;
  readonly notice?: true | undefined;
}): string[] =>
  value.offerClose !== undefined && value.notice !== undefined
    ? ['a notice is read, not closed: no --offer-close']
    : [];

/**
 * What a raise may not say when it CONFIRMS a held configuration change: its answers are fixed (Allow, Deny,
 * Discard change), so it carries no ask, answers, kind or questions of its own, and it is never a notice.
 */
export const agendaConfirmsProblems = (value: {
  readonly confirms?: string | undefined;
  readonly notice?: true | undefined;
  readonly ask?: unknown;
  readonly answers?: readonly unknown[] | undefined;
  readonly kind?: string | undefined;
  readonly questions?: readonly unknown[] | undefined;
}): string[] => {
  if (value.confirms === undefined) return [];
  return [
    ...(value.notice === undefined ? [] : ['a confirmation is answered, so it is not a notice']),
    ...(value.ask === undefined
      ? []
      : ['a confirmation has no ask of its own: its answers are Allow, Deny and Discard change']),
    ...(value.answers === undefined
      ? []
      : ['a confirmation has no answers of its own: they are Allow, Deny and Discard change']),
    ...(value.kind === undefined ? [] : ['a confirmation has no kind of its own: it is a choice']),
    ...(value.questions === undefined
      ? []
      : ['a confirmation asks one thing, whether to apply the change: no questions']),
  ];
};

export const AgendaActionRequestSchema = z
  .discriminatedUnion('action', [
    AddAgendaRequestSchema,
    /** Reword an open item in place: only the writing, never its ask or who raised it. */
    z.strictObject({
      action: z.literal('edit'),
      id: AgendaIdSchema,
      subject: singleLine(MAX_AGENDA_SUBJECT_LENGTH).optional(),
      title: AgendaCardShape.title,
      context: z.preprocess(asBullets, z.string().max(MAX_AGENDA_DETAIL_LENGTH)).nullable().optional(),
      ...AgendaBriefShape,
      /** Agenda fields to take off the item (`--not-blocking`, `--clear-will-block`, `--clear-by`). */
      clear: z.array(AgendaClearableFieldSchema).min(1).max(3).optional(),
      /** `--now`: it is urgent — an item the owner SNOOZED wakes too, at most once an hour (`AGENDA_URGENT_WAKE_MS`). */
      now: z.literal(true).optional(),
    }),
    z.strictObject({
      action: z.literal('resolve'),
      id: AgendaIdSchema,
      note: z.string().max(MAX_AGENDA_DETAIL_LENGTH).optional(),
      response: AgendaResponseSchema.optional(),
    }),
    /** Tick or untick one step of an open item: never resolves it, never pushes, never messages the ferret. */
    z.strictObject({
      action: z.literal('progress'),
      id: AgendaIdSchema,
      step: NonNegativeIntegerSchema,
      done: z.boolean(),
    }),
    /** The owner asks the raising ferret for more information: the item stays open, marked waiting on the ferret. */
    z.strictObject({
      action: z.literal('needs-info'),
      id: AgendaIdSchema,
      note: z.string().trim().min(1).max(MAX_AGENDA_DETAIL_LENGTH).optional(),
    }),
    /**
     * The owner wants to talk a SURFACED item through before answering — the premise is wrong, or the card is
     * not understood. The item stays open, marked in discussion (`waitingFor: 'discussion'`), and the raising
     * ferret is told `[discuss !A3 «title»] …` to reply in chat. Kept for older apps: the current app talks
     * to the ferret in chat, where the ask already starts.
     */
    z.strictObject({
      action: z.literal('discuss'),
      id: AgendaIdSchema,
      note: z.string().trim().min(1).max(MAX_AGENDA_DETAIL_LENGTH).optional(),
    }),
    /**
     * The raising ferret (or the owner) moves an item out of discussion into the owner's queue: the owner did
     * not answer it in chat. The optional `why` is one line kept in the item's history.
     */
    z.strictObject({
      action: z.literal('surface'),
      id: AgendaIdSchema,
      why: singleLine(MAX_AGENDA_SUBJECT_LENGTH).optional(),
      /** `--now`: it is urgent — an item the owner SNOOZED wakes too, at most once an hour (`AGENDA_URGENT_WAKE_MS`). */
      now: z.literal(true).optional(),
    }),
    /** The owner puts an open item away `until` a time still ahead; it comes back then as a fresh item. */
    z.strictObject({
      action: z.literal('snooze'),
      id: AgendaIdSchema,
      until: InstantSchema,
    }),
    /** The owner brings a parked item (snoozed, or replied to) back to their queue now. */
    z.strictObject({
      action: z.literal('unsnooze'),
      id: AgendaIdSchema,
    }),
    z.strictObject({
      action: z.literal('dismiss'),
      id: AgendaIdSchema,
      note: z.string().max(MAX_AGENDA_DETAIL_LENGTH).optional(),
    }),
  ])
  .superRefine((value, context) => {
    if (value.action === 'edit') {
      for (const field of value.clear ?? []) {
        if (value[field] !== undefined)
          context.addIssue({ code: 'custom', message: `${field} cannot be set and cleared at once`, path: ['clear'] });
      }
      return;
    }
    if (value.action !== 'add') return;
    for (const [path, message] of agendaAnswerProblems(value.answers ?? [], value.ask)) {
      context.addIssue({ code: 'custom', message, path: path.split('.') });
    }
    for (const message of agendaOptionDetailProblems(value)) {
      context.addIssue({ code: 'custom', message, path: ['optionDetails'] });
    }
    for (const problem of agendaFormProblems(value)) {
      context.addIssue({ code: 'custom', message: problem, path: ['fields'] });
    }
    if (value.kind === 'input') {
      context.addIssue({
        code: 'custom',
        message: 'an input card is raised by an input request (terminal_request_input), never by an agenda add',
        path: ['kind'],
      });
    }
    for (const problem of [
      ...agendaNoticeProblems(value),
      ...agendaConfirmsProblems(value),
      ...agendaOfferCloseProblems(value),
    ]) {
      context.addIssue({ code: 'custom', message: problem });
    }
  });
export type AgendaActionRequest = z.infer<typeof AgendaActionRequestSchema>;

export const DirectNotificationRequestSchema = z.strictObject({
  body: z.string().trim().min(1).max(MAX_NOTIFICATION_BODY_LENGTH),
  title: singleLine(MAX_NOTIFICATION_TITLE_LENGTH).optional(),
  kind: z.enum(['completed', 'failed']).optional(),
});
export type DirectNotificationRequest = z.infer<typeof DirectNotificationRequestSchema>;

/** The resolution note every item the owner's "clear all from agent ferrets" dismisses carries. */
export const AGENDA_CLEAR_AGENTS_NOTE = 'cleared: agent-ferret backlog';

/** `POST /v1/agenda/clear-agents` (`agenda.clear-agents.1`): `dryRun` counts what would go and changes nothing. */
export const AgendaClearAgentsRequestSchema = z.strictObject({ dryRun: z.boolean().optional() });
export type AgendaClearAgentsRequest = z.infer<typeof AgendaClearAgentsRequestSchema>;

/** How many open items the call dismissed (or, on a dry run, would), on how many agent ferrets' boards. */
export const AgendaClearAgentsResultSchema = z.strictObject({
  cleared: z.number().int().nonnegative(),
  sessions: z.number().int().nonnegative(),
});
export type AgendaClearAgentsResult = z.infer<typeof AgendaClearAgentsResultSchema>;

export const AgendaCountResponseSchema = z.object({
  sessionId: z.string().min(1),
  count: NonNegativeIntegerSchema,
});
export type AgendaCountResponse = z.infer<typeof AgendaCountResponseSchema>;

export const DirectNotificationResponseSchema = z.object({
  sessionId: z.string().min(1),
  delivered: NonNegativeIntegerSchema,
});
export type DirectNotificationResponse = z.infer<typeof DirectNotificationResponseSchema>;

export const AgendaErrorCodeSchema = z.enum([
  'invalid',
  'too-long',
  'not-found',
  'forbidden',
  'rate-limited',
  'read-only',
  'full',
  'corrupt',
  /** The generic answer was used on a `kind: 'input'` card, or a paste plan's: its own form answers it. */
  'use_input_form',
]);
export type AgendaErrorCode = z.infer<typeof AgendaErrorCodeSchema>;

/**
 * A session's open Attention, as its list row carries it: what makes a conversation read as UNREAD
 * until the owner has dealt with it. The daemon rewrites it after every board change that moves the
 * open set, and removes it when nothing is open — so its absence means "nothing waits on the owner",
 * never "unknown". The board itself (`GET /v1/sessions/:id/attention`) has every item in full.
 */
export const SessionAgendaSummarySchema = z.object({
  /** How many items are open. */
  open: PositiveIntegerSchema,
  /** The oldest open item — the one a row opens to. */
  first: AgendaIdSchema,
  /** That item's one-line ask, for a row's preview. */
  ask: singleLine(MAX_AGENDA_SUBJECT_LENGTH),
  /** When the NEWEST open item was raised: "newest needing you first" sorts by it. */
  latestAt: InstantSchema,
  /**
   * How many of the `open` items are in discussion (`waitingFor: 'discussion'`): still being talked through
   * in the ferret's chat, not on the owner's queue, so they are not counted as needing the owner. Absent
   * when none is.
   */
  discussing: PositiveIntegerSchema.optional(),
  /** The ferret works in AGENDA MODE (a switchable instruction section, off by default): the chat draws its agenda. */
  agendaMode: z.literal(true).optional(),
  /** The ferret is STOPPED on the owner: idle, with at least one item on the owner's turn. */
  stopped: z.literal(true).optional(),
});
export type SessionAgendaSummary = z.infer<typeof SessionAgendaSummarySchema>;

/** The query parameter a conversation link names an agenda item by: `?agenda=A3`. */
export const AGENDA_LINK_PARAMETER = 'agenda';

/**
 * The older spelling, `?attention=A3`. Delivered pushes and bookmarks carry it for good, so a client keeps
 * reading it; the daemon still WRITES it into pushes until older apps (which read only this one) are gone.
 */
export const LEGACY_ATTENTION_LINK_PARAMETER = 'attention';

/**
 * Where a push about a conversation opens, RELATIVE TO THE MACHINE'S OWN PAGES: the daemon names the
 * session, and the browser's per-machine push worker puts it under that machine — the daemon never
 * names an origin or the browser's address for itself (`packages/pwa/src/lib/push-scope.ts`). A push
 * with no item to point at (`fy attention notify`) opens here.
 */
export const sessionNotificationPath = (sessionId: string): string => `/session/${encodeURIComponent(sessionId)}`;

/** Where an Agenda notification opens: its conversation, AT the item (`?attention=A3`). */
export const agendaNotificationPath = (sessionId: string, id: AgendaId): string =>
  `${sessionNotificationPath(sessionId)}?${LEGACY_ATTENTION_LINK_PARAMETER}=${encodeURIComponent(id)}`;
