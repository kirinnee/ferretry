import {
  AskItemSchema as AgendaItemSchema,
  AskBoardSnapshotSchema as AgendaSnapshotSchema,
  AskListSnapshotSchema as AgendaListSnapshotSchema,
  type AskItem as AgendaItem,
  type AskBoardSnapshot as AgendaSnapshot,
  type AskListSnapshot as AgendaListSnapshot,
} from '@ferretry/core-asks/contract';

export { AgendaItemSchema, AgendaSnapshotSchema, AgendaListSnapshotSchema };
export type { AgendaItem, AgendaSnapshot, AgendaListSnapshot };

import { z } from 'zod';
import {
  AccountIdSchema,
  SignInRuleIdSchema,
  SignInRuleSuggestionIdSchema,
  TwoFactorStageIdSchema,
} from './account-ids.ts';
import {
  AgendaRestingSchema,
  AgendaStageSchema,
  type AgendaStateSource,
  agendaState,
  MAX_AGENDA_REST_WHY_LENGTH,
} from './agenda-state.ts';
import { BoardReopenAttachmentsSchema, TaskRefSchema } from './board-refs.ts';
import { InstantSchema, NonNegativeIntegerSchema, PositiveIntegerSchema } from './common.ts';

export const AGENDA_SCHEMA_VERSION = 1 as const;

/**
 * The request header a caller sends to say it reads the whole channel shape (`agenda.channel.1`); its value is the
 * channel version. The CLI and the app send it on every agenda read. A machine that has not been updated yet serves
 * the older, clipped shape to a caller that does not send it, so a new caller keeps sending it.
 */
export const AGENDA_CHANNEL_HEADER = 'x-fy-agenda-channel';
/** Current reader version: channel fields plus resolved headers on list reads. */
export const AGENDA_CHANNEL_VERSION = '2';

/** Only channel 2 readers can parse resolved headers in list responses. */
export const readsAgendaHeaders = (headers: { get(name: string): string | null | undefined }): boolean =>
  headers.get(AGENDA_CHANNEL_HEADER)?.trim() === AGENDA_CHANNEL_VERSION;
export const MAX_AGENDA_PER_SESSION = 20;
export const MAX_AGENDA_RESOLUTIONS = 100;
export const MAX_AGENDA_SUBJECT_LENGTH = 240;
export const MAX_AGENDA_DETAIL_LENGTH = 2_048;
/**
 * THE TRANSPORT BOUND (docs/agenda.md § No size limit): an agenda item has no size limit a reader meets, only this
 * bound on what one item may weigh on the wire, as the length of its JSON. Each field keeps its own explicit bound
 * below it, so every schema stays bounded; together they may add up to more, and the item's own check refuses that.
 */
export const MAX_AGENDA_ITEM_LENGTH = 1_000_000;
/**
 * What an item's OWN content (everything but its control metadata and versions) may weigh, as JSON. It is held well
 * under the transport bound so the room that is left always covers what closing, resting or answering adds
 * (`agendaContentLength`), and so every accepted item stays closable and shortenable: its revisions and history are
 * the only things compacted to fit (`fitAgendaItem`); the daemon archives owner history before removing it.
 */
export const MAX_AGENDA_CONTENT_LENGTH = 560_000;
/** The most one owner response weighs, as JSON: it is kept on the item (`ownerAnswer`), in its history and on its close. */
export const MAX_AGENDA_RESPONSE_LENGTH = 70_000;
/** Complete response plus note, as JSON, before its copies in history, ownerAnswer and Retry. */
export const MAX_AGENDA_REPLY_ENVELOPE_LENGTH = 136_000;
/** Gate receipts cannot be shed: reserve half the 32k control budget for them. */
export const MAX_AGENDA_GATE_HISTORY_LENGTH = 16_000;

export function agendaReplyEnvelopeLength(reply: {
  readonly response?: AgendaResponse;
  readonly note?: string | null;
}): number {
  return JSON.stringify({
    ...(reply.response === undefined ? {} : { response: reply.response }),
    ...(reply.note == null ? {} : { note: reply.note }),
  }).length;
}
/** The longest context an item carries: the facts around the situation, as Markdown. */
export const MAX_AGENDA_CONTEXT_LENGTH = 64_000;
/** The longest the owner's own words are — an answer, a reply, a note — so every reply shows whole. */
export const MAX_AGENDA_REPLY_LENGTH = 64_000;
/** The longest a point-form segment is (premise, decided, still open, impact). */
export const MAX_AGENDA_POINTS_LENGTH = 16_000;
/** The longest "where we are now" and the longest folded from-zero detail, as Markdown. */
export const MAX_AGENDA_WHERE_LENGTH = 200_000;
export const MAX_AGENDA_FOLDED_DETAIL_LENGTH = 200_000;
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
/** The push body is the card's ask, clipped here; an ask meant to stay under `AGENDA_ASK_TARGET_LENGTH` fits whole. */
export const AGENDA_PUSH_BODY_LENGTH = 120;
/** The longest title an item may carry at all; past the target it is advice, past this a refusal. */
export const MAX_AGENDA_TITLE_LENGTH = 60;
/** The most a card's ASK should say: a short title-like line, which is the push's text; the detail goes in `--body`. */
export const AGENDA_ASK_TARGET_LENGTH = 80;
/** A segment (premise, context, answer, body…) is short points; one paragraph past this many characters is a wall of text the lint warns about. */
export const AGENDA_SEGMENT_PARAGRAPH_LENGTH = 280;
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
    clarification: z.string().trim().min(1).max(MAX_AGENDA_REPLY_LENGTH),
  }),
]);

/** One answered form field: the field's id and its value — the picked label(s), Yes or No, or the typed text. */
export const AgendaFormAnswerSchema = z.strictObject({
  id: z.string().trim().min(1).max(MAX_AGENDA_FIELD_ID_LENGTH),
  picked: z.union([
    z.string().trim().min(1).max(MAX_AGENDA_REPLY_LENGTH),
    z.array(singleLine(MAX_AGENDA_ASK_OPTION_LENGTH)).min(1).max(MAX_AGENDA_ASK_OPTIONS),
  ]),
});
export type AgendaFormAnswer = z.infer<typeof AgendaFormAnswerSchema>;

export const AgendaResponseSchema = z
  .union([
    z.strictObject({ kind: z.literal('permission'), decision: z.enum(['approve', 'reject']) }),
    z.strictObject({
      kind: z.literal('multiple-choice'),
      choice: singleLine(MAX_AGENDA_ASK_OPTION_LENGTH),
    }),
    AnswerReviewResponseSchema,
    z.strictObject({
      kind: z.literal('open-question'),
      answer: z.string().trim().min(1).max(MAX_AGENDA_REPLY_LENGTH),
    }),
    /**
     * A form answered: each field the owner filled in, by id (`AgendaFormAnswerSchema`). Any subset, at least one:
     * a form answered with only words is an `open-question` answer to its ask, the shape every app already reads
     * (&F922).
     */
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
      answer: z.string().trim().min(1).max(MAX_AGENDA_REPLY_LENGTH),
    }),
  ])
  .refine(response => JSON.stringify(response).length <= MAX_AGENDA_RESPONSE_LENGTH, {
    message: `an answer is at most ${MAX_AGENDA_RESPONSE_LENGTH} characters as JSON`,
  });
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
export const MAX_AGENDA_STEP_LENGTH = 16_000;
/** The longest instruction document an item carries, as one block of Markdown. */
export const MAX_AGENDA_BODY_LENGTH = 200_000;
/** The longest Markdown explanation one option carries (`optionDetails`). */
export const MAX_AGENDA_OPTION_DETAIL_MARKDOWN_LENGTH = 16_000;

const prose = (maximum: number) => z.string().trim().min(1).max(maximum);

const characters = (count: number): string => count.toLocaleString('en-US');

/**
 * Why a long document is refused, in words that name the count and the remedy: the body is where a ferret
 * is tempted to trim the end off, and a trimmed report loses its sections. A report past the cap belongs behind a link,
 * and the body keeps the current state.
 */
export const agendaTooLongMessage = (field: string, length: number, maximum: number): string =>
  `${field} is ${characters(length)} characters; the most is ${characters(maximum)}. Do not trim it: put the full report in a file or artifact, add it with --link, and keep ${field} to the current state and the choice.`;

/** Prose that, over `maximum`, is refused with `agendaTooLongMessage` rather than a bare "too big". */
const longProse = (field: string, maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .superRefine((value, ctx) => {
      if (value.length > maximum)
        ctx.addIssue({ code: 'custom', message: agendaTooLongMessage(field, value.length, maximum) });
    });

/**
 * THE ITEM'S TABS (&F923; docs/agenda.md § The tabs). An item's live document is a row of tabs: the MAIN tab, "Where
 * we are now" (`whereWeAre`, always first), "The full picture" (`body`), then up to `MAX_AGENDA_TABS` of the ferret's
 * own (Overview, Status, Decisions…), each a whole Markdown document the ferret rewrites when it changes. `id` is the
 * name's slug when the tab is made and never changes, so a rename is not a new tab.
 */
export const MAX_AGENDA_TABS = 6;
export const MAX_AGENDA_TAB_NAME_LENGTH = 32;
/** The ferret's own tabs TOGETHER: under the unchanged whole-item bound, so the item's worst case does not move. */
export const MAX_AGENDA_TABS_LENGTH = 200_000;
/** The most tab operations one edit carries; they apply in order, as one version. */
export const MAX_AGENDA_TAB_EDITS = 16;
const MAX_AGENDA_TAB_ID_LENGTH = 32;
/** The fixed tabs' names: a ferret's own tab never takes one. */
export const AGENDA_MAIN_TAB_NAME = 'Where we are now';
export const AGENDA_BODY_TAB_NAME = 'The full picture';
export const AGENDA_REVIEW_BODY_TAB_NAME = 'Reasoning';
const RESERVED_TAB_NAMES = [AGENDA_MAIN_TAB_NAME, AGENDA_BODY_TAB_NAME, AGENDA_REVIEW_BODY_TAB_NAME];
/** The fixed tabs' ids, which `fy agenda show --tab` also takes. */
export const AGENDA_MAIN_TAB_ID = 'main';
export const AGENDA_BODY_TAB_ID = 'body';

const TAB_ID = /^[a-z0-9][a-z0-9-]{0,31}$/u;

/** What is wrong with a tab's name, in plain words; `undefined` when it is fine. */
export const agendaTabNameProblem = (name: string): string | undefined => {
  if (name !== name.trim()) return `the tab name "${name}" starts or ends with a space`;
  if (name.length === 0) return 'a tab needs a name';
  if (name.length > MAX_AGENDA_TAB_NAME_LENGTH)
    return `the tab name "${name}" is ${name.length} characters; the most is ${MAX_AGENDA_TAB_NAME_LENGTH}`;
  if (/[\r\n]/u.test(name)) return `the tab name "${name}" must be one line`;
  if (/[=#]/u.test(name)) return `the tab name "${name}" cannot hold "=" or "#"`;
  if (
    [...RESERVED_TAB_NAMES, AGENDA_MAIN_TAB_ID, AGENDA_BODY_TAB_ID].some(
      reserved => reserved.toLowerCase() === name.toLowerCase(),
    )
  )
    return `"${name}" is a fixed tab: the main tab is --where-file, the full picture is --body-file`;
  return undefined;
};

export const AgendaTabSchema = z.strictObject({
  id: z
    .string()
    .regex(TAB_ID, 'must be a-z, 0-9 or -, starting with a letter or digit')
    .max(MAX_AGENDA_TAB_ID_LENGTH)
    // The fixed tabs' ids are theirs: an own tab with one would draw twice under one id and could not be named.
    .refine(id => id !== AGENDA_MAIN_TAB_ID && id !== AGENDA_BODY_TAB_ID, 'main and body are the fixed tabs’ ids'),
  name: z.string().superRefine((value, ctx) => {
    const problem = agendaTabNameProblem(value);
    if (problem !== undefined) ctx.addIssue({ code: 'custom', message: problem });
  }),
  body: longProse('a tab', MAX_AGENDA_TABS_LENGTH),
});
export type AgendaTab = z.infer<typeof AgendaTabSchema>;

/** Everything wrong with a set of the ferret's own tabs, each in plain words: empty when it fits. */
export const agendaTabProblems = (tabs: readonly AgendaTab[]): string[] => {
  const problems: string[] = [];
  if (tabs.length > MAX_AGENDA_TABS)
    problems.push(`an item has at most ${MAX_AGENDA_TABS} tabs of its own besides the main tab and the full picture`);
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const tab of tabs) {
    const name = tab.name.toLowerCase();
    if (names.has(name)) problems.push(`two tabs are called "${tab.name}"`);
    if (ids.has(tab.id)) problems.push(`two tabs have the id "${tab.id}"`);
    names.add(name);
    ids.add(tab.id);
  }
  // A name is never ANOTHER tab's id, so a reference by name or by id always means one tab.
  for (const tab of tabs) {
    const other = tabs.find(each => each !== tab && each.id === tab.name.toLowerCase());
    if (other !== undefined)
      problems.push(`the name "${tab.name}" is the id of the tab "${other.name}": pick another name`);
  }
  const length = tabs.reduce((sum, tab) => sum + tab.body.length, 0);
  if (length > MAX_AGENDA_TABS_LENGTH)
    problems.push(agendaTooLongMessage('the tabs together', length, MAX_AGENDA_TABS_LENGTH));
  return problems;
};

/** The ferret's own tabs, as an item stores them: 1 to `MAX_AGENDA_TABS`, unique, together within their bound. */
const AgendaTabsSchema = z
  .array(AgendaTabSchema)
  .min(1)
  .max(MAX_AGENDA_TABS)
  .superRefine((tabs, ctx) => {
    for (const message of agendaTabProblems(tabs)) ctx.addIssue({ code: 'custom', message });
  });

/**
 * ONE TAB OPERATION of an edit (`--tab-file`, `--rename-tab`, `--move-tab`, `--remove-tab`). `tab` names a tab by
 * its name (any case) or its id; a name that is not a tab yet makes one, and then needs a `body`. `remove` goes alone.
 * `position` counts from 1 among the ferret's own tabs.
 */
export const AgendaTabEditSchema = z
  .strictObject({
    tab: z.string().trim().min(1).max(MAX_AGENDA_TAB_NAME_LENGTH),
    body: longProse('a tab', MAX_AGENDA_TABS_LENGTH).optional(),
    rename: z.string().trim().min(1).max(MAX_AGENDA_TAB_NAME_LENGTH).optional(),
    position: z.number().int().min(1).max(MAX_AGENDA_TABS).optional(),
    remove: z.literal(true).optional(),
  })
  .refine(
    edit =>
      edit.remove !== true || (edit.body === undefined && edit.rename === undefined && edit.position === undefined),
    {
      message: 'a tab that is removed takes no body, name or position',
    },
  )
  .refine(
    edit => edit.remove === true || edit.body !== undefined || edit.rename !== undefined || edit.position !== undefined,
    {
      message: 'a tab edit says what to do: a body, a new name, a position or remove',
    },
  );
export type AgendaTabEdit = z.infer<typeof AgendaTabEditSchema>;

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
 * or No for `yesno`. Every field is optional to the owner, who may send any subset (&F922): `required` is kept so an
 * older raise still parses, and says nothing the app enforces.
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

/**
 * A PR, a file or a reference the reader may want to open. The target is a URL, a path or a reference; the
 * `meaning` says in plain words what it is, so the item view's terms-and-references table explains it
 * (`agenda.link-meaning.1`).
 */
export const AgendaLinkSchema = z.strictObject({
  label: singleLine(MAX_AGENDA_LINK_LABEL_LENGTH).optional(),
  target: singleLine(MAX_AGENDA_LINK_TARGET_LENGTH),
  meaning: prose(MAX_AGENDA_TERM_MEANING_LENGTH).optional(),
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
  premise: z.preprocess(asBullets, prose(MAX_AGENDA_POINTS_LENGTH)).optional(),
  /** Earlier answers that bear on this one, in point form: what the owner already decided. */
  decided: z.preprocess(asBullets, prose(MAX_AGENDA_POINTS_LENGTH)).optional(),
  /**
   * What is STILL OPEN after the discussion so far, in point form: it shrinks as `decided` grows, so a card read
   * after several rounds of talk says where things stand, not where they started.
   */
  stillOpen: z.preprocess(asBullets, prose(MAX_AGENDA_POINTS_LENGTH)).optional(),
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
  impact: z.preprocess(asBullets, prose(MAX_AGENDA_POINTS_LENGTH)).optional(),
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
  steps: z.array(longProse('a step', MAX_AGENDA_STEP_LENGTH)).min(1).max(MAX_AGENDA_STEPS).optional(),
  /** Instructions that are not a list, as one Markdown document. */
  body: longProse('the body', MAX_AGENDA_BODY_LENGTH).optional(),
  /**
   * The ferret's answer to the owner's QUESTION about the item, shown above the item's own options, which stay live:
   * the ask is still waiting for the owner's own answer, and this block never closes it.
   */
  questionAnswer: longProse('the question answer', MAX_AGENDA_BODY_LENGTH).optional(),
  /**
   * WHERE WE ARE NOW — THE MAIN TAB (&F923), as Markdown and fy-render, as long and rich as it needs to be: the
   * current situation, in the reader's terms. It opens first, under the ferret's answer to the owner's question,
   * what is decided and what is still open (`agendaTabs`).
   */
  whereWeAre: longProse('where we are', MAX_AGENDA_WHERE_LENGTH).optional(),
  /** The ferret's own tabs (Overview, Status, Decisions…), after the main tab and the full picture (`agendaTabs`). */
  tabs: AgendaTabsSchema.optional(),
  /** The context explained from zero, as Markdown, for a reader who knows nothing of the topic: drawn folded away. */
  detail: longProse('the detail', MAX_AGENDA_FOLDED_DETAIL_LENGTH).optional(),
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
  ...(value.whereWeAre === undefined ? {} : { whereWeAre: value.whereWeAre }),
  ...(value.tabs === undefined ? {} : { tabs: value.tabs }),
  ...(value.detail === undefined ? {} : { detail: value.detail }),
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

/**
 * The agenda fields an edit clears before `agenda.patch.1`: they have no empty value to write, so clearing is named.
 * `questionAnswer` is the ferret's stale answer to the owner's question (`--clear-question-answer`, `agenda.asks.1`).
 */
export const AGENDA_FLAG_CLEARABLE_FIELDS = ['blockingNow', 'willBlock', 'neededBy', 'questionAnswer'] as const;

/**
 * The agenda fields an edit can clear. A PATCH's `null` (`fy agenda patch`, `agenda.patch.1`, docs/agenda.md § Patch)
 * also clears the optional writing past {@link AGENDA_FLAG_CLEARABLE_FIELDS}; a daemon without that feature refuses
 * those as malformed, so a client sends them only to one that reports it. Never `title`, `subject`, `premise` or
 * `context` (a cold reader starts from them), nor the ask's shape (a new ask replaces it).
 */
export const AgendaClearableFieldSchema = z.enum([
  ...AGENDA_FLAG_CLEARABLE_FIELDS,
  'decided',
  'stillOpen',
  'terms',
  'recommendation',
  'optionDetails',
  'impact',
  'urgency',
  'links',
  'whereWeAre',
  'body',
  'detail',
]);
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

/**
 * The most entries an item's wire history keeps; owner records are archived before compaction. Kept until the item's
 * conversation and versions move to their own store (the next step of docs/agenda.md § States).
 */
export const MAX_AGENDA_HISTORY = 20;

/**
 * One thing that happened to an item after it was raised, for "You asked for more info 10:42 · updated 10:44":
 * the owner asked for more information (`needs-info`) or to talk it through (`discuss`), the ferret
 * updated it (`updated`), the item left discussion for the queue (`surfaced`, the why as its note), or the
 * owner replied and it was PARKED as replied (`replied`, their words as its note; the ferret's `surface` or
 * `edit` brings it back, its `done` closes it); or the owner answered the CARD GATE asked on this thread
 * (`gate-answered`, the gate's `gate:` reference as its note, docs/agenda.md § One ask per thing), which keeps that
 * gate asked for good, whichever way the thread is closed after.
 */
export const AgendaHistoryEntrySchema = z.strictObject({
  at: InstantSchema,
  kind: z.enum(['needs-info', 'discuss', 'updated', 'surfaced', 'replied', 'gate-answered']),
  note: z.string().trim().min(1).max(MAX_AGENDA_REPLY_LENGTH).optional(),
  /** What the owner picked or typed, on a `replied` entry from an ANSWER: `ownerAnswer` keeps only the latest. */
  response: AgendaResponseSchema.optional(),
});
export type AgendaHistoryEntry = z.infer<typeof AgendaHistoryEntrySchema>;

/**
 * One thing SAID on an item (docs/agenda.md § The conversation): the owner's words or the ferret's, in the order they
 * were said, kept whole. `via` is the path the words took — an owner `reply` in chat, an `answer` with a note, a
 * request for `needs-info` or to `discuss`, the ferret's `question-answer` or `rest` line or its `surface` why, the `close`
 * note, or words the ferret LOGGED from the owner's chat (`chat-log`). `fromChat` names the chat message the words were
 * copied from, which is also how one message is never logged twice.
 */
export const AgendaConversationEntrySchema = z.strictObject({
  at: InstantSchema,
  by: z.enum(['owner', 'ferret', 'daemon']),
  text: z.string().refine(text => text.trim().length > 0, { message: 'words must not be empty' }),
  via: z.enum(['reply', 'answer', 'needs-info', 'discuss', 'question-answer', 'rest', 'surface', 'close', 'chat-log']),
  fromChat: z.strictObject({ messageId: z.string().trim().min(1).max(128), at: InstantSchema }).optional(),
});
export type AgendaConversationEntry = z.infer<typeof AgendaConversationEntrySchema>;

/** The `gate:` references of the card gates the owner answered on this item, as its history records them. */
export const gatesAnsweredOn = (item: { readonly history?: readonly AgendaHistoryEntry[] | undefined }): string[] =>
  (item.history ?? []).flatMap(entry =>
    entry.kind === 'gate-answered' && entry.note !== undefined ? [entry.note] : [],
  );

/**
 * WHY AN OPEN ITEM IS PARKED — off the owner's queue for now, with its way back (docs/agenda.md § Parked items):
 *
 * - `snoozed` — the owner put it away `until` a time ("waiting for approval"); the daemon wakes it then, or at
 *   its `neededBy` when that is sooner, as a fresh item. The ferret's `edit` or `surface` leaves it asleep
 *   unless it says it is urgent (`now`) or newly blocking (`blockingNow`).
 * - `replied` — the item RESTS (`agenda-state.ts`): the owner replied or answered and it waits on the ferret, or the
 *   ferret took it on (`rest`). Its `resting` says which; this reason is what an app from before Resting reads,
 *   so its Replied filter still lists every Resting item. The ferret's answer brings it back; its `done` closes it.
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
 * The number a badge shows for a board: its Needs-you items (`agendaState`), the length of its Needs-you queue
 * (`needsYouQueue`) — never a resting, snoozed or done item, nor a notice. A snapshot's `count` stays every open
 * item — the wire checks `count === items.length`.
 */
export const agendaBadgeCount = (snapshot: { readonly items: readonly AgendaStateSource[] }): number =>
  snapshot.items.filter(item => agendaState(item).state === 'needs-you').length;

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
  'whereWeAre',
  'tabs',
  'detail',
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
    context: z.string().max(MAX_AGENDA_CONTEXT_LENGTH).nullable().optional(),
    howToResolve: z.string().trim().min(1).max(MAX_AGENDA_DETAIL_LENGTH).optional(),
    ask: AgendaAskSchema.optional(),
    ...AgendaCardShape,
    ...AgendaBriefShape,
  }),
});
export type AgendaRevision = z.infer<typeof AgendaRevisionSchema>;

/**
 * How a closed item ended: answered or resolved (`done`), or closed unanswered (`dismissed`). An item the owner wrote
 * about RESTS open (`parked: replied`); it never closes as a reply.
 */
export const AgendaDispositionSchema = z.enum(['done', 'dismissed']);
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
export const AgendaUndeliveredReplySchema = z
  .discriminatedUnion('action', [
    z.strictObject({
      action: z.literal('resolve'),
      note: z.string().max(MAX_AGENDA_REPLY_LENGTH).optional(),
      response: AgendaResponseSchema.optional(),
    }),
    z.strictObject({
      action: z.literal('dismiss'),
      note: z.string().max(MAX_AGENDA_REPLY_LENGTH).optional(),
    }),
    z.strictObject({
      action: z.literal('needs-info'),
      note: z.string().trim().min(1).max(MAX_AGENDA_REPLY_LENGTH).optional(),
    }),
    z.strictObject({
      action: z.literal('discuss'),
      note: z.string().trim().min(1).max(MAX_AGENDA_REPLY_LENGTH).optional(),
    }),
  ])
  .refine(reply => agendaReplyEnvelopeLength(reply) <= MAX_AGENDA_REPLY_ENVELOPE_LENGTH, {
    message: `an answer plus note is at most ${MAX_AGENDA_REPLY_ENVELOPE_LENGTH} characters as JSON`,
  });
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

/** The most cards one machine notice lists, each with its own buttons. */
export const MAX_AGENDA_CARDS = 12;

/**
 * One board card a machine notice lists (the Warden's cards with nobody working on them): the card, and the one line that names
 * it. The app draws Open, Start a ferret on it and Close card under each line; the daemon authorizes each of the
 * three as the owner's own act on that card. An app from before these rows drops the field and shows the notice's
 * own words with Got it.
 */
export const AgendaCardRowSchema = z.strictObject({
  task: TaskRefSchema,
  line: z.string().trim().min(1).max(MAX_AGENDA_SUBJECT_LENGTH),
});
export type AgendaCardRow = z.infer<typeof AgendaCardRowSchema>;

/**
 * A 2FA seed staged at the machine and waiting for the owner's passkey (docs/secrets.md, "2FA keys"): the card's
 * Allow runs the `add-2fa-key` ceremony bound to `stage` and saves it to `account`, and Deny drops it. The generic
 * agenda answer saves nothing, so an app from before these cards shows the daemon's words and cannot save. Only the
 * daemon raises one.
 */
export const AgendaTwoFactorSeedRefSchema = z.strictObject({
  stage: TwoFactorStageIdSchema,
  /**
   * The account, only on an item an older daemon raised. This daemon leaves it out: an account's handle is often its
   * label and username, and agenda items are every ferret's to read. The app reads the stage, and its account, by the
   * stage id (`GET /v1/accounts/seed-stages/:stage`, a secrets-gated route).
   */
  account: AccountIdSchema.optional(),
});
export type AgendaTwoFactorSeedRef = z.infer<typeof AgendaTwoFactorSeedRefSchema>;

/**
 * A FERRET'S SUGGESTION of a standing sign-in rule (sign-in-rules.ts, `account.propose` with `preapprove`): the card's
 * only action opens the owner's create sheet with NOTHING ticked. It names the suggestion, never an account, and the
 * generic agenda answer creates nothing. Only the daemon raises one.
 */
export const AgendaSignInRuleSuggestionRefSchema = z.strictObject({ suggestion: SignInRuleSuggestionIdSchema });
export type AgendaSignInRuleSuggestionRef = z.infer<typeof AgendaSignInRuleSuggestionRefSchema>;

/**
 * A standing sign-in rule a fill in this session SUSPENDED (sign-in-rules.ts): an `info` card that sends the owner to
 * Settings › Secure copy. It names the rule, never an account (the agenda text holds no names), and an agenda answer
 * resumes nothing: only a new passkey does. Only the daemon raises one.
 */
export const AgendaSignInRuleSuspendedRefSchema = z.strictObject({ rule: SignInRuleIdSchema });
export type AgendaSignInRuleSuspendedRef = z.infer<typeof AgendaSignInRuleSuspendedRefSchema>;

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

/** The longest gate option label, as the lane's own gate options are written (`board-lanes.ts`). */
export const MAX_AGENDA_GATE_OPTION_LENGTH = 24;

/**
 * Where a gate option sends the card, as the daemon applies the owner's answer (docs/board.md § Gates ask the
 * owner): on to the next lane of its workflow, to a named lane, back to rework with the owner's words and a
 * follow-up conversation, or to the board's closed lane.
 */
export const AgendaGateOutcomeSchema = z.enum(['next', 'lane', 'reopen-with-agenda', 'close']);
export type AgendaGateOutcome = z.infer<typeof AgendaGateOutcomeSchema>;

/** One of the gate's options: its label is the ask option the owner chooses. */
export const AgendaGateOptionSchema = z.strictObject({
  id: z.string().min(1).max(MAX_AGENDA_GATE_OPTION_LENGTH),
  label: singleLine(MAX_AGENDA_GATE_OPTION_LENGTH),
  outcome: AgendaGateOutcomeSchema,
});
export type AgendaGateOption = z.infer<typeof AgendaGateOptionSchema>;

/**
 * THE GATE AN ITEM ASKS ABOUT: the daemon raised it because an owner-asked card entered a lane whose stage is a
 * gate, and answering it moves the card (docs/board.md § Cards show progress). Only the daemon writes one; an app
 * that predates the field reads an ordinary choice card and answers it by label.
 */
export const AgendaGateSchema = z.strictObject({
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
export type AgendaGate = z.infer<typeof AgendaGateSchema>;

// ---------------------------------------------------------------------------------------------------
// CARD ASKS (docs/agenda.md § Card asks). A card never asks the owner itself: when it reaches a stage that waits on
// the owner (a gate: OK to build, or Done / Not good), the daemon puts a CARD ASK on the agenda that carries the card.
// Kept in a block of its own: the conversation's merge and split carry `cardAsks` as they find them.
// ---------------------------------------------------------------------------------------------------

/** The most card asks one agenda keeps: every open one, then the newest answered ones, so a replay still finds its own. */
export const MAX_AGENDA_CARD_ASKS = 16;

/**
 * The owner's answer to a card ask, kept on the ask: the choice, their words, and a SHA-256 of everything the answer
 * said (`receipt`) with the `askVersion` it was given against, so an exact repeat (a lost response, a second tap) is
 * answered as the first one was and moves nothing again.
 */
export const AgendaCardAskAnswerSchema = z.object({
  at: InstantSchema,
  response: AgendaResponseSchema,
  note: z.string().max(MAX_AGENDA_REPLY_LENGTH).optional(),
  receipt: z.string().regex(/^[0-9a-f]{64}$/u),
  askVersion: PositiveIntegerSchema.optional(),
});
export type AgendaCardAskAnswer = z.infer<typeof AgendaCardAskAnswerSchema>;

/**
 * WHAT A CARD ASK WOKE: the turn a ferret's thread was in when the ask was put on it (since when it waited on the owner,
 * or the park, rest or wait on its ferret the ask ended), so the thread goes back to exactly that if the ask is
 * withdrawn unanswered. Only on a ferret's own thread; the card's agenda the daemon opened has nothing to go back to.
 */
export const AgendaCardAskWokeSchema = z.object({
  waitingSince: InstantSchema,
  parked: AgendaParkedSchema.optional(),
  resting: AgendaRestingSchema.optional(),
  waitingOn: z.literal('ferret').optional(),
  askedAt: InstantSchema.optional(),
  waitingFor: z.enum(['info', 'discussion']).optional(),
});
export type AgendaCardAskWoke = z.infer<typeof AgendaCardAskWokeSchema>;

/**
 * ONE CARD ASK: the card's gate as it stands (the card, its lane, the entry that put it there and the lane's
 * options), when it was put on this agenda, the card's How to test, and — once the owner answered — their answer.
 * Open while it has no answer. Only the daemon writes one; only the owner answers one.
 */
export const AgendaCardAskSchema = z.object({
  gate: AgendaGateSchema,
  at: InstantSchema,
  /** The turn this ask woke the thread out of (`AgendaCardAskWoke`); absent on the card's own agenda and on an ask from before it was kept. */
  woke: AgendaCardAskWokeSchema.optional(),
  /** The card's How to test, as written (Markdown): what the owner tries before they answer. */
  howToTest: z.string().max(MAX_AGENDA_BODY_LENGTH).optional(),
  answer: AgendaCardAskAnswerSchema.optional(),
  /**
   * The owner said "Not yet" (a one-option gate's other answer): the card stays, their words reached its ferret, and
   * the ask stays OPEN for them to answer later. The ferret may rest the agenda now; it still may not close it.
   */
  notYet: z.object({ at: InstantSchema, note: z.string().max(MAX_AGENDA_REPLY_LENGTH).optional() }).optional(),
});
export type AgendaCardAsk = z.infer<typeof AgendaCardAskSchema>;

/**
 * THE OWNER'S LATEST ANSWER TO AN OPEN ITEM'S ASK (docs/agenda.md § States): an answer rests the item, it never
 * closes it, so the answer is kept on the item until the ferret replies or marks it done. `request` is the item's
 * request counter (`infoRequests`) when it was given: it names this answer's one delivery to the ferret.
 */
export const AgendaOwnerAnswerSchema = z
  .object({
    at: InstantSchema,
    response: AgendaResponseSchema,
    note: z.string().max(MAX_AGENDA_REPLY_LENGTH).optional(),
    request: PositiveIntegerSchema,
  })
  .refine(reply => agendaReplyEnvelopeLength(reply) <= MAX_AGENDA_REPLY_ENVELOPE_LENGTH, {
    message: `an answer plus note is at most ${MAX_AGENDA_REPLY_ENVELOPE_LENGTH} characters as JSON`,
  });
export type AgendaOwnerAnswer = z.infer<typeof AgendaOwnerAnswerSchema>;

/** The keys that are about the item's life, not what it says: its versions, its state and how it was closed. */
const AGENDA_CONTROL_KEYS: ReadonlySet<string> = new Set([
  'stage',
  'conversation',
  'conversationCount',
  'conversationLastAt',
  'revisions',
  'history',
  'ownerAnswer',
  'ownAskRepliedTo',
  'undelivered',
  'resting',
  'parked',
  'stages',
  'urgentAt',
  'infoRequests',
  'sourceSeq',
  'waitingSince',
  'waitingOn',
  'askedAt',
  'waitingFor',
  'stepsDone',
  'stage',
  'resolvedAt',
  'resolutionNote',
  'response',
  'answerReceipt',
  'disposition',
  'resolvedBy',
  'resolvedBySession',
  'resolvedByName',
]);

/** How much an item's own content weighs as JSON: the item without its control metadata (`MAX_AGENDA_CONTENT_LENGTH`). */
export function agendaContentLength(item: object): number {
  const content = Object.fromEntries(Object.entries(item).filter(([key]) => !AGENDA_CONTROL_KEYS.has(key)));
  return JSON.stringify(content).length;
}

/**
 * An item that fits the transport bound: when it weighs more than `MAX_AGENDA_ITEM_LENGTH`, its oldest revisions go
 * first, then its oldest history (a card gate's `gate-answered` entry never goes: it keeps that gate asked for good).
 * The daemon must archive owner records removed here in the same ledger write. The history count is bounded too;
 * an item already within both bounds is returned as it is.
 */
export function fitAgendaItem<
  T extends {
    readonly revisions?: readonly unknown[] | undefined;
    readonly history?: readonly { readonly kind: string }[] | undefined;
  },
>(item: T): T {
  const weighs = (candidate: T) => JSON.stringify(candidate).length;
  let fitted = item;
  while ((fitted.history?.length ?? 0) > MAX_AGENDA_HISTORY) {
    const history = fitted.history ?? [];
    const oldest = history.findIndex(entry => entry.kind !== 'gate-answered');
    if (oldest < 0) break;
    fitted = { ...fitted, history: history.filter((_, index) => index !== oldest) } as T;
  }
  while (weighs(fitted) > MAX_AGENDA_ITEM_LENGTH && (fitted.revisions?.length ?? 0) > 0) {
    const { revisions, ...rest } = fitted;
    const kept = (revisions ?? []).slice(1);
    fitted = (kept.length === 0 ? rest : { ...rest, revisions: kept }) as T;
  }
  while (weighs(fitted) > MAX_AGENDA_ITEM_LENGTH) {
    const history = fitted.history ?? [];
    const oldest = history.findIndex(entry => entry.kind !== 'gate-answered');
    if (oldest < 0) break;
    const kept = history.filter((_, index) => index !== oldest);
    const { history: _history, ...rest } = fitted;
    fitted = (kept.length === 0 ? rest : { ...rest, history: kept }) as T;
  }
  return fitted;
}

// Wire items are owned by Asks; the app only names their public projections.
export const StoredAgendaItemSchema = AgendaItemSchema;
export const ResolvedAgendaItemSchema = AgendaSnapshotSchema.shape.resolved.element;
export const StoredResolvedAgendaItemSchema = ResolvedAgendaItemSchema;
export type ResolvedAgendaItem = AgendaSnapshot['resolved'][number];

/**
 * The owner's answers a machine is holding for one ferret, to deliver them as ONE message once the owner
 * stops answering (docs/agenda.md § The loop). Present on the board while anything is held, so the app
 * can say "sending in 8 s" and offer "Send now" (`POST /v1/ferrets/:ferretId/agenda/replies`).
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

export const AgendaListRecordSchema = AgendaListSnapshotSchema.shape.resolved.element;
export type AgendaListRecord = AgendaListSnapshot['resolved'][number];
export const ResolvedAgendaHeaderSchema = AgendaListRecordSchema.options[0];
export type ResolvedAgendaHeader = z.infer<typeof ResolvedAgendaHeaderSchema>;

export const AgendaReadItemSchema = z.union([
  ResolvedAgendaItemSchema,
  z.intersection(AgendaItemSchema, z.object({ resolvedAt: z.never().optional(), projection: z.never().optional() })),
]);
export type AgendaReadItem = z.infer<typeof AgendaReadItemSchema>;

export const isAgendaHeader = (item: AgendaItem | AgendaListRecord): item is ResolvedAgendaHeader =>
  'projection' in item && item.projection === 'header';

const AddAgendaRequestSchema = z.strictObject({
  action: z.literal('add'),
  ...AgendaCardShape,
  source: z.literal('agent-raised').default('agent-raised'),
  sourceRef: z.string().max(MAX_AGENDA_SOURCE_REF_LENGTH).nullable().default(null),
  subject: singleLine(MAX_AGENDA_SUBJECT_LENGTH),
  why: z.string().trim().min(1).max(MAX_AGENDA_DETAIL_LENGTH),
  context: z.preprocess(asBullets, z.string().max(MAX_AGENDA_CONTEXT_LENGTH)).nullable().optional(),
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
  /** What the item needs from the owner (`--stage`); read from its kind when absent. Only for `agenda.channel.1`. */
  stage: AgendaStageSchema.optional(),
  ...AgendaBriefShape,
});

/** The new item a split writes: an ordinary add, minus what a split never carries. */
export const SplitAgendaItemSchema = AddAgendaRequestSchema.omit({
  action: true,
  source: true,
  sourceRef: true,
  confirms: true,
  notice: true,
  ping: true,
  task: true,
  offerClose: true,
  surface: true,
});
export type SplitAgendaItem = z.infer<typeof SplitAgendaItemSchema>;

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

/** Rewrite an open item in place: its writing, its stage, or — replacing the ask — what it asks; never who raised it. */
export const AgendaEditRequestSchema = z.strictObject({
  action: z.literal('edit'),
  id: AgendaIdSchema,
  subject: singleLine(MAX_AGENDA_SUBJECT_LENGTH).optional(),
  /**
   * The WHY line and the HOW-TO-RESOLVE line the owner reads (`agenda.patch.1`): rewritten, never removed, so a line
   * written for the item's first ask can follow the ask it carries now.
   */
  why: prose(MAX_AGENDA_DETAIL_LENGTH).optional(),
  howToResolve: prose(MAX_AGENDA_DETAIL_LENGTH).optional(),
  /**
   * READ BEFORE WRITE (`agenda.patch.1`, `fy agenda patch`): the item's revision (`agendaItemRevision`) as the writer
   * read it. When the item has changed since, the edit is refused `stale` and nothing is written: read it again.
   */
  revision: z
    .string()
    .regex(/^[0-9a-z]{1,32}$/u)
    .optional(),
  title: AgendaCardShape.title,
  /**
   * What the item needs from the owner now (`--stage`); a change is kept in its `stages`. Only a daemon that
   * reports `agenda.channel.1` takes it.
   */
  stage: AgendaStageSchema.optional(),
  /**
   * A REPLACED ASK (`agenda.asks.1`): a new ask, kind, answers or questions (their options too). The item asks
   * again, fresh, as its one entry in the Needs-you queue; its `askVersion` moves on, so an answer to the old ask
   * is refused, and the ferret's answer to an earlier question is cleared unless this edit sets a new one.
   */
  ask: AgendaAskSchema.optional(),
  kind: AgendaCardShape.kind,
  answers: AgendaCardShape.answers,
  context: z.preprocess(asBullets, z.string().max(MAX_AGENDA_CONTEXT_LENGTH)).nullable().optional(),
  ...AgendaBriefShape,
  /**
   * TAB OPERATIONS (`agenda.tabs.1`), applied in order as ONE edit (one version): make or rewrite a tab, rename,
   * move or remove one (`applyAgendaTabEdits`). Never with `tabs`, which replaces them all.
   */
  tabEdits: z.array(AgendaTabEditSchema).min(1).max(MAX_AGENDA_TAB_EDITS).optional(),
  /** Agenda fields to take off the item (`--not-blocking`, `--clear-will-block`, `--clear-by`). */
  clear: z
    .array(AgendaClearableFieldSchema)
    .min(1)
    .max(AgendaClearableFieldSchema.options.length)
    .refine(fields => new Set(fields).size === fields.length, 'clear names each field once')
    .optional(),
  /** `--now`: it is urgent — an item the owner SNOOZED wakes too, at most once an hour (`AGENDA_URGENT_WAKE_MS`). */
  now: z.literal(true).optional(),
});

export const AgendaActionRequestSchema = z
  .discriminatedUnion('action', [
    AddAgendaRequestSchema,
    AgendaEditRequestSchema,
    z.strictObject({
      action: z.literal('resolve'),
      id: AgendaIdSchema,
      note: z.string().max(MAX_AGENDA_REPLY_LENGTH).optional(),
      response: AgendaResponseSchema.optional(),
      /** The response picks one of the attached card gate's options, not one of the thread's own answers. */
      gate: z.literal(true).optional(),
      /**
       * WHICH card ask the response answers (`agenda.card-asks.1`): its gate reference (`gate:<card>:<lane>:<entry>`).
       */
      cardAsk: z.string().min(1).max(MAX_AGENDA_SOURCE_REF_LENGTH).optional(),
      /**
       * The `askVersion` of the item the answer — or the Done given from its ask — was given to (`agenda.asks.1`):
       * when the ferret has replaced the ask since, it is refused `ask_changed` instead of being applied to the new
       * one. Absent: not checked, which is how the owner closes the item as it stands now.
       */
      askVersion: PositiveIntegerSchema.optional(),
      /**
       * Files the owner sent with a Not good on a card's gate (`from` is this agenda's own session, where the app
       * uploaded them): carried to the card's ferret with the reopen. Only an answer to a gate takes them, and only a
       * daemon that reports `agenda.gate.attachments.1`; any other answer is refused.
       */
      attachments: BoardReopenAttachmentsSchema.optional(),
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
      note: z.string().trim().min(1).max(MAX_AGENDA_REPLY_LENGTH).optional(),
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
      note: z.string().trim().min(1).max(MAX_AGENDA_REPLY_LENGTH).optional(),
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
    /**
     * The raising ferret TAKES AN ITEM ON without asking anything yet (`fy agenda rest --why`, `agenda.channel.1`):
     * it rests as `working`, quiet and never nudged, until the ferret answers on it (it then asks again, fresh) or
     * marks it done.
     */
    z.strictObject({
      action: z.literal('rest'),
      id: AgendaIdSchema,
      why: z.string().trim().min(1).max(MAX_AGENDA_REST_WHY_LENGTH),
    }),
    /**
     * The ferret LOGS THE OWNER'S CHAT WORDS on an item (`fy agenda log`, `agenda.conversation.1`): the daemon copies
     * them verbatim from this session's own message store — the owner's latest chat message, or `messageId` — and
     * the ferret never retypes them. `reply` returns the item to its old place as an answer does; `rest` (what the
     * ferret is doing) leaves it resting as working.
     */
    z.strictObject({
      action: z.literal('log'),
      id: AgendaIdSchema,
      mode: z.enum(['reply', 'rest']),
      /**
       * The FERRET's words: with `reply`, its answer to what the owner said (kept as its answer on the item); with `rest`,
       * what it is doing (held to the length of a rest line). The owner's words are never in the request.
       */
      text: z.string().trim().min(1).max(MAX_AGENDA_BODY_LENGTH),
      messageId: z.string().trim().min(1).max(128).optional(),
    }),
    /** Merge `from` into `id` (`agenda.conversation.1`): both conversations, all cards and links kept; `from` closes. */
    z.strictObject({
      action: z.literal('merge'),
      id: AgendaIdSchema,
      from: AgendaIdSchema,
    }),
    /**
     * Split a NEW item off `id` (`agenda.conversation.1`): its own writing, linked both ways, the named cards moved to it.
     */
    z.strictObject({
      action: z.literal('split'),
      id: AgendaIdSchema,
      /** The new item, written as an add is (its ask, title, premise and context), raised by the same ferret. */
      item: SplitAgendaItemSchema,
      /** Cards of `id` that go to the new item: its `task` and `relatedTasks`. */
      moveCards: z.array(TaskRefSchema).min(1).max(MAX_AGENDA_CARDS).optional(),
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
      note: z.string().max(MAX_AGENDA_REPLY_LENGTH).optional(),
      /** The `askVersion` of the ask this Skip was given from (`agenda.asks.1`); see `resolve`. Absent: not checked. */
      askVersion: PositiveIntegerSchema.optional(),
    }),
  ])
  .superRefine((value, context) => {
    if (
      ['resolve', 'dismiss', 'needs-info', 'discuss'].includes(value.action) &&
      agendaReplyEnvelopeLength(value as { response?: AgendaResponse; note?: string }) >
        MAX_AGENDA_REPLY_ENVELOPE_LENGTH
    ) {
      context.addIssue({
        code: 'custom',
        message: `an answer plus note is at most ${MAX_AGENDA_REPLY_ENVELOPE_LENGTH} characters as JSON`,
      });
    }
    if (value.action === 'resolve' && value.attachments !== undefined && value.response === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'files go with an answer, not with a bare close',
        path: ['attachments'],
      });
    }
    if (value.action === 'edit') {
      for (const field of value.clear ?? []) {
        if (value[field] !== undefined)
          context.addIssue({ code: 'custom', message: `${field} cannot be set and cleared at once`, path: ['clear'] });
      }
      return;
    }
    if (value.action !== 'add') return;
    if (JSON.stringify(value).length > MAX_AGENDA_CONTENT_LENGTH) {
      context.addIssue({
        code: 'custom',
        message: `an agenda item's own content is at most ${MAX_AGENDA_CONTENT_LENGTH} characters as JSON: move the long part to a file and link it`,
      });
    }
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
  ferrets: z.number().int().nonnegative(),
});
export type AgendaClearAgentsResult = z.infer<typeof AgendaClearAgentsResultSchema>;

/** `GET /v1/agenda/open` (`agenda.open.1`): the most items one page carries, and the one it carries when `limit` is absent. */
export {
  AGENDA_OPEN_MAX_LIMIT,
  AGENDA_OPEN_DEFAULT_LIMIT,
  AgendaOpenQuerySchema,
  AgendaOpenSessionSchema,
  AgendaOpenPageSchema,
  type AgendaOpenQuery,
  type AgendaOpenSession,
  type AgendaOpenPage,
} from '../../contract/index.ts';

export const AgendaCountResponseSchema = z.object({
  sessionId: z.string().min(1),
  count: NonNegativeIntegerSchema,
});
export type AgendaCountResponse = z.infer<typeof AgendaCountResponseSchema>;

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
  /** An answer named an ask the ferret has since replaced (`askVersion`): the item asks something else now. */
  'ask_changed',
  /** An edit named the revision it read (`revision`), and the item has changed since: read it again (`agenda.patch.1`). */
  'stale',
]);
export type AgendaErrorCode = z.infer<typeof AgendaErrorCodeSchema>;

/**
 * A session's open Attention, as its list row carries it: what makes a conversation read as UNREAD
 * until the owner has dealt with it. The daemon rewrites it after every board change that moves the
 * open set, and removes it when nothing is open — so its absence means "nothing waits on the owner",
 * never "unknown". The board itself (`GET /v1/ferrets/:id/agenda`) has every item in full.
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

/** The query parameter a conversation link names an ask by: `?ask=A3` (the one spelling; pushes write it too). */
export const ASK_LINK_PARAMETER = 'ask';

/**
 * Where a push about a conversation opens, RELATIVE TO THE MACHINE'S OWN PAGES: the daemon names the
 * session, and the browser's per-machine push worker puts it under that machine — the daemon never
 * names an origin or the browser's address for itself (`packages/pwa/src/lib/push-scope.ts`). A push
 * with no item to point at (`fy attention notify`) opens here.
 */
export const sessionNotificationPath = (sessionId: string): string => `/session/${encodeURIComponent(sessionId)}`;

/** Where an Agenda notification opens: its conversation, AT the ask (`?ask=A3`). */
export const agendaNotificationPath = (sessionId: string, id: AgendaId): string =>
  `${sessionNotificationPath(sessionId)}?${ASK_LINK_PARAMETER}=${encodeURIComponent(id)}`;

/**
 * The id the MACHINE AGENDA goes by (docs/agenda.md § The machine agenda): the daemon's own ledger for notices that
 * belong to no ferret. The daemon keys its ledger and its snapshot by it and the app reads that snapshot as the
 * conversation of this name, so it lives here, once, for both. No ferret can hold it: sessions are minted by the
 * daemon from `<base36 ms>-<hex>`.
 */
export const MACHINE_AGENDA_ID = 'machine-agenda';

export const isMachineAgendaId = (sessionId: string): boolean => sessionId === MACHINE_AGENDA_ID;
