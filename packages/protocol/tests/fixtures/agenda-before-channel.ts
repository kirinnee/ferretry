// Frozen origin/main agenda.ts dependency closure at b64c839d654d2993d2685e1814c7dacde466fff1.
// Schema declarations are unchanged; import paths and exports are adapted for this fixture.
import { z } from 'zod';
import {
  AccountIdSchema,
  SignInRuleIdSchema,
  SignInRuleSuggestionIdSchema,
  TwoFactorStageIdSchema,
} from '../../src/lib/account-ids.ts';
import { TaskRefSchema } from '../../src/lib/board-refs.ts';
import { InstantSchema, NonNegativeIntegerSchema, PositiveIntegerSchema } from '../../src/lib/common.ts';
const AGENDA_SCHEMA_VERSION = 1 as const;
const MAX_AGENDA_PER_SESSION = 20;
const MAX_AGENDA_RESOLUTIONS = 100;
const MAX_AGENDA_SUBJECT_LENGTH = 240;
const MAX_AGENDA_DETAIL_LENGTH = 2_048;
const MAX_AGENDA_SOURCE_REF_LENGTH = 512;
const MAX_AGENDA_ASK_OPTIONS = 12;
const MAX_AGENDA_ASK_OPTION_LENGTH = 120;
const MAX_AGENDA_FIELDS = 12;
const MAX_AGENDA_FIELD_ID_LENGTH = 24;
const MAX_AGENDA_FIELD_NAME_LENGTH = 40;
const MAX_AGENDA_ASK_OPTION_DETAIL_LENGTH = 240;
const MAX_AGENDA_WARNINGS = 12;
const MAX_AGENDA_WARNING_LENGTH = 400;
const MAX_AGENDA_TITLE_LENGTH = 60;
const MAX_AGENDA_CARD_ANSWERS = 3;
const singleLine = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .regex(/^[^\r\n]*$/u, 'must be a single line');
const AgendaSourceSchema = z.enum(['task', 'question', 'agent-raised']);
const AgendaAskOptionSchema = z.strictObject({
  label: singleLine(MAX_AGENDA_ASK_OPTION_LENGTH),
  description: singleLine(MAX_AGENDA_ASK_OPTION_DETAIL_LENGTH).optional(),
});
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
const AgendaAskSchema = z.union([
  z.strictObject({ kind: z.literal('permission') }),
  MultipleChoiceAskSchema,
  z.strictObject({ kind: z.literal('answer-review') }),
  z.strictObject({ kind: z.literal('open-question') }),
  /** "Do this": the owner does something and nothing is chosen. Its answers are Done and Need more info. */
  z.strictObject({ kind: z.literal('task') }),
]);
type AgendaAsk = z.infer<typeof AgendaAskSchema>;
const AgendaKindSchema = z.enum(['task', 'yesno', 'permission', 'choice', 'review', 'info', 'reply', 'form', 'input']);
type AgendaKind = z.infer<typeof AgendaKindSchema>;
const AgendaDirectionSchema = z.enum(['left', 'up', 'right']);
const AgendaAnswerEffectSchema = z.enum([
  'choose',
  'approve',
  'reject',
  'good',
  'clarify',
  'done',
  'needs-info',
  'dismiss',
]);
type AgendaAnswerEffect = z.infer<typeof AgendaAnswerEffectSchema>;
const AgendaCardAnswerSchema = z.strictObject({
  direction: AgendaDirectionSchema,
  label: singleLine(MAX_AGENDA_ASK_OPTION_LENGTH),
  does: AgendaAnswerEffectSchema,
  description: singleLine(MAX_AGENDA_ASK_OPTION_DETAIL_LENGTH).optional(),
});
type AgendaCardAnswer = z.infer<typeof AgendaCardAnswerSchema>;
const ASK_EFFECTS: Readonly<Record<AgendaAsk['kind'] | 'none', readonly AgendaAnswerEffect[]>> = {
  permission: ['approve', 'reject'],
  'multiple-choice': ['choose'],
  'answer-review': ['good', 'clarify'],
  'open-question': [],
  task: [],
  none: [],
};
const ANY_CARD_EFFECTS: readonly AgendaAnswerEffect[] = ['done', 'needs-info', 'dismiss'];
function agendaAnswerProblems(
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
const AgendaCardShape = {
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
const AgendaFormAnswerSchema = z.strictObject({
  id: z.string().trim().min(1).max(MAX_AGENDA_FIELD_ID_LENGTH),
  picked: z.union([
    z.string().trim().min(1).max(MAX_AGENDA_DETAIL_LENGTH),
    z.array(singleLine(MAX_AGENDA_ASK_OPTION_LENGTH)).min(1).max(MAX_AGENDA_ASK_OPTIONS),
  ]),
});
const AgendaResponseSchema = z.union([
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
const MAX_AGENDA_TERMS = 12;
const MAX_AGENDA_TERM_LENGTH = 80;
const MAX_AGENDA_TERM_MEANING_LENGTH = 400;
const MAX_AGENDA_QUESTIONS = 6;
const MAX_AGENDA_QUESTION_LENGTH = 600;
const MAX_AGENDA_REASON_LENGTH = 1_024;
const MAX_AGENDA_URGENCY_LENGTH = 120;
const MAX_AGENDA_LINKS = 10;
const MAX_AGENDA_LINK_LABEL_LENGTH = 120;
const MAX_AGENDA_LINK_TARGET_LENGTH = 1_024;
const MAX_AGENDA_STEPS = 20;
const MAX_AGENDA_STEP_LENGTH = 2_000;
const MAX_AGENDA_BODY_LENGTH = 8_000;
const MAX_AGENDA_OPTION_DETAIL_MARKDOWN_LENGTH = 1_000;
const prose = (maximum: number) => z.string().trim().min(1).max(maximum);
const LIST_MARKER = /^\s*(?:[-*•]|\d+[.)])\s+/u;
const NESTED_MARKER = /^(\s*(?:[-*•]|\d+[.)])\s+)(?:(?:[-*•]|\d+[.)])\s+)+/u;
const stripListMarker = (point: string): string => {
  const stripped = point.replace(LIST_MARKER, '').trim();
  return stripped === '' ? point.trim() : stripped;
};
const toBullets = (points: readonly string[]): string =>
  points
    .map(point => stripListMarker(point.replaceAll(/\s+/gu, ' ').trim()))
    .filter(point => point !== '')
    .map(point => `- ${point}`)
    .join('\n');
const unnestBullets = (text: string): string => {
  const lines = text.split(/\r?\n/u).filter(line => line.trim() !== '');
  if (lines.length === 0 || !lines.every(line => LIST_MARKER.test(line))) return text;
  return text.replaceAll(new RegExp(NESTED_MARKER.source, 'gmu'), '$1');
};
const asBullets = (value: unknown): unknown =>
  Array.isArray(value) && value.every((point): point is string => typeof point === 'string')
    ? toBullets(value)
    : typeof value === 'string'
      ? unnestBullets(value)
      : value;
const AgendaTermSchema = z.strictObject({
  term: singleLine(MAX_AGENDA_TERM_LENGTH),
  meaning: prose(MAX_AGENDA_TERM_MEANING_LENGTH),
});
const AgendaQuestionSchema = z
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
type AgendaQuestion = z.infer<typeof AgendaQuestionSchema>;
const AgendaFieldTypeSchema = z.enum(['one', 'many', 'yesno', 'text']);
const AgendaFormFieldSchema = z
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
type AgendaFormField = z.infer<typeof AgendaFormFieldSchema>;
const AgendaRecommendationSchema = z.strictObject({
  decision: prose(MAX_AGENDA_QUESTION_LENGTH),
  why: prose(MAX_AGENDA_REASON_LENGTH).optional(),
});
const AgendaOptionDetailSchema = z.strictObject({
  label: singleLine(MAX_AGENDA_ASK_OPTION_LENGTH),
  detail: prose(MAX_AGENDA_OPTION_DETAIL_MARKDOWN_LENGTH),
});
type AgendaOptionDetail = z.infer<typeof AgendaOptionDetailSchema>;
const AgendaLinkSchema = z.strictObject({
  label: singleLine(MAX_AGENDA_LINK_LABEL_LENGTH).optional(),
  target: singleLine(MAX_AGENDA_LINK_TARGET_LENGTH),
});
const AgendaBriefShape = {
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
const agendaOptionLabels = (item: {
  readonly ask?: AgendaAsk | undefined;
  readonly questions?: readonly AgendaQuestion[] | undefined;
  readonly answers?: readonly AgendaCardAnswer[] | undefined;
}): readonly string[] => [
  ...(item.ask?.kind === 'multiple-choice' ? item.ask.options.map(option => option.label.trim()) : []),
  ...(item.questions ?? []).flatMap(question => (question.options ?? []).map(option => option.label.trim())),
  ...(item.answers ?? []).filter(answer => answer.does === 'choose').map(answer => answer.label.trim()),
];
const agendaOptionDetailProblems = (item: {
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
const agendaFormProblems = (item: {
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
const MAX_AGENDA_HISTORY = 20;
const AgendaHistoryEntrySchema = z.strictObject({
  at: InstantSchema,
  kind: z.enum(['needs-info', 'discuss', 'updated', 'surfaced', 'replied', 'gate-answered']),
  note: z.string().trim().min(1).max(MAX_AGENDA_DETAIL_LENGTH).optional(),
});
const AgendaParkedSchema = z.discriminatedUnion('reason', [
  z.strictObject({ reason: z.literal('snoozed'), at: InstantSchema, until: InstantSchema }),
  z.strictObject({ reason: z.literal('replied'), at: InstantSchema }),
]);
const MAX_AGENDA_REVISIONS = 10;
const AgendaRevisableFieldSchema = z.enum([
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
const AgendaRevisionSchema = z.strictObject({
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
const AgendaDispositionSchema = z.enum(['done', 'dismissed', 'replied']);
const AgendaIdSchema = z.string().regex(/^A[1-9][0-9]*$/u);
const AgendaUndeliveredReplySchema = z.discriminatedUnion('action', [
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
const AgendaUndeliveredSchema = z.strictObject({
  at: InstantSchema,
  reply: AgendaUndeliveredReplySchema,
  /** Why it did not arrive, in words a person reads. */
  reason: z.string().trim().min(1).max(MAX_AGENDA_DETAIL_LENGTH),
});
const MAX_AGENDA_CONFIRMS_PATH_LENGTH = 256;
const MAX_AGENDA_CONFIRMS_CHANGES = 12;
const AgendaConfirmsSchema = z.strictObject({
  path: singleLine(MAX_AGENDA_CONFIRMS_PATH_LENGTH),
  etag: singleLine(MAX_AGENDA_CONFIRMS_PATH_LENGTH),
  changes: z.array(singleLine(MAX_AGENDA_WARNING_LENGTH)).min(1).max(MAX_AGENDA_CONFIRMS_CHANGES),
  restated: z.literal(true).optional(),
});
const AgendaInputRefSchema = z.strictObject({ requestId: z.string().regex(/^[0-9a-f]{32}$/u) });
const AgendaCopyPlanRefSchema = z.strictObject({ planId: z.string().regex(/^[0-9a-f]{32}$/u) });
const AgendaTaskPlanRefSchema = z.strictObject({ planId: z.string().regex(/^[0-9a-f]{32}$/u) });
const AgendaPhoneApprovalRefSchema = z.strictObject({
  id: z.string().regex(/^pa_[0-9a-f]{24}$/u, 'a phone approval id is pa_ and 24 hex digits'),
});
const MAX_AGENDA_CARDS = 12;
const AgendaCardRowSchema = z.strictObject({
  task: TaskRefSchema,
  line: z.string().trim().min(1).max(MAX_AGENDA_SUBJECT_LENGTH),
});
const AgendaTwoFactorSeedRefSchema = z.strictObject({
  stage: TwoFactorStageIdSchema,
  /**
   * The account, only on an item an older daemon raised. This daemon leaves it out: an account's handle is often its
   * label and username, and agenda items are every ferret's to read. The app reads the stage, and its account, by the
   * stage id (`GET /v1/accounts/seed-stages/:stage`, a secrets-gated route).
   */
  account: AccountIdSchema.optional(),
});
const AgendaSignInRuleSuggestionRefSchema = z.strictObject({ suggestion: SignInRuleSuggestionIdSchema });
const AgendaSignInRuleSuspendedRefSchema = z.strictObject({ rule: SignInRuleIdSchema });
const agendaInputProblems = (value: {
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
const MAX_AGENDA_GATE_OPTION_LENGTH = 24;
const AgendaGateOutcomeSchema = z.enum(['next', 'lane', 'reopen-with-agenda', 'close']);
const AgendaGateOptionSchema = z.strictObject({
  id: z.string().min(1).max(MAX_AGENDA_GATE_OPTION_LENGTH),
  label: singleLine(MAX_AGENDA_GATE_OPTION_LENGTH),
  outcome: AgendaGateOutcomeSchema,
});
const AgendaGateSchema = z.strictObject({
  cardId: z.string().min(1).max(64),
  laneId: z.string().min(1).max(64),
  laneName: z.string().min(1).max(80),
  /** The card history's `seq` of the event that put the card in the lane: one item per entry. */
  entry: PositiveIntegerSchema,
  projectId: z.string().min(1).max(128),
  projectName: z.string().min(1).max(120).optional(),
  /** The card's title, so a thread carrying this gate can name the card: "Badge colour is ready to test". */
  cardTitle: z.string().min(1).max(MAX_AGENDA_TITLE_LENGTH).optional(),
  options: z.array(AgendaGateOptionSchema).min(1).max(MAX_AGENDA_CARD_ANSWERS),
});
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
  /** The board cards a machine notice lists, each with Open, Start and Close (`AgendaCardRow`); only the daemon raises them. */
  cards: z.array(AgendaCardRowSchema).min(1).max(MAX_AGENDA_CARDS).readonly().optional(),
  /** The staged 2FA seed a card asks the owner to save with a passkey; answered by that ceremony, never the generic answer. */
  twoFactorSeed: AgendaTwoFactorSeedRefSchema.optional(),
  /** A ferret's suggested standing rule: its card opens the create sheet with nothing ticked, never the generic answer. */
  signInRuleSuggestion: AgendaSignInRuleSuggestionRefSchema.optional(),
  /** A standing rule a fill suspended; only an `info` item carries one, and no answer resumes it. */
  signInRuleSuspended: AgendaSignInRuleSuspendedRefSchema.optional(),
  /** The card gate this item asks about (`AgendaGate`); only the daemon raises one, and only the owner answers it. */
  gate: AgendaGateSchema.optional(),
  /**
   * The card gate this THREAD answers for (docs/agenda.md § One ask per thing): a ferret's open, owner-facing thread
   * about a card whose gate is asking carries it instead of a gate item of its own. Only the daemon sets or clears it.
   */
  gateAttached: AgendaGateSchema.optional(),
};
const AgendaItemSchema = z
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
    if (value.cards !== undefined && value.kind !== 'info') {
      context.addIssue({ code: 'custom', message: 'only an info card lists cards', path: ['cards'] });
    }
    if (value.signInRuleSuspended !== undefined && value.kind !== 'info') {
      context.addIssue({
        code: 'custom',
        message: 'only an info card says a standing rule was suspended',
        path: ['signInRuleSuspended'],
      });
    }
    if (value.gate !== undefined && value.raisedBy !== 'daemon') {
      context.addIssue({ code: 'custom', message: 'only the daemon raises a gate item', path: ['gate'] });
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
const ResolvedAgendaBaseShape = {
  resolvedAt: InstantSchema,
  resolutionNote: z.string().max(MAX_AGENDA_DETAIL_LENGTH).nullable(),
  response: AgendaResponseSchema.optional(),
  /** A SHA-256 of everything a gate answer said, kept with the answered item so an exact repeat reads as one. */
  answerReceipt: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
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
function responseKindFitsAsk(ask: string | undefined, response: string): boolean {
  if (response === 'other') return ask !== undefined && ask !== 'open-question' && ask !== 'task';
  return ask === response;
}
const ResolvedAgendaItemSchema = z
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
const AgendaRepliesSchema = z.strictObject({
  pending: z.array(AgendaIdSchema).min(1).max(MAX_AGENDA_RESOLUTIONS),
  dueAt: InstantSchema,
  /**
   * Present once `dueAt` has passed while the ferret is still mid-turn: the batch is held until that turn
   * ends, so answers given meanwhile join it. "Send now" still delivers at once.
   */
  heldForTurn: z.literal(true).optional(),
});
const AgendaDeliverySchema = z.strictObject({
  /** Items whose answer was handed to the ferret and is not yet proven in its transcript: "Sending…". */
  sending: z.array(AgendaIdSchema).max(MAX_AGENDA_RESOLUTIONS),
  /**
   * Present while held answers are due but the ferret's composer holds text (a person's draft) or could
   * not be read: nothing is typed into it until it is empty.
   */
  heldForComposer: z.literal(true).optional(),
});
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
    /** What the daemon did to the request that the caller should know, not advice on its writing (a card link left off). */
    notes: z.array(z.string().trim().min(1).max(MAX_AGENDA_DETAIL_LENGTH)).max(MAX_AGENDA_WARNINGS).optional(),
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
