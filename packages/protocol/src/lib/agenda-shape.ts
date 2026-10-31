/**
 * ONE CLEAR ANSWER SHAPE PER KIND — the words every surface says it with, in ONE place: the line a ferret's prompt
 * carries (`AGENDA_SHAPE_LINE`), the `fy agenda add --help` table with an example per kind (`AGENDA_SHAPE_HELP`),
 * the refusals the CLI and the daemon give when a raise mixes shapes (`AGENDA_SHAPE_ERRORS`), and what the owner's
 * card says in its "What I need from you" segment (`AGENDA_NEED_HEADING`, `AGENDA_SHAPE_LEADS`).
 *
 * The owner's rule (docs/agenda.md, "What I need from you"):
 *
 * | the ferret wants           | the card shows                                        | the buttons                |
 * | -------------------------- | ----------------------------------------------------- | -------------------------- |
 * | one option picked          | the question, then each option with what it means     | the options (≤3 on the row)|
 * | an open answer             | the question                                          | none: the reply box        |
 * | several answers, or a mix  | a numbered list of each answer wanted                 | none: the reply box        |
 * | steps followed             | the steps, numbered, each ticked                      | Mark as done               |
 * | to be read                 | the message                                           | Got it                     |
 * | permission                 | what is approved, and its effect                      | Approve · Deny             |
 * | a review                   | what to review                                        | Approve · Request changes  |
 *
 * The shape itself is `agendaShape` (agenda-card.ts), read from an item's stored fields, so an item raised before
 * this rule reads in its shape too; this module only says it and refuses a new raise that does not fit one.
 */

import type { AgendaAsk, AgendaKind, AgendaQuestion } from './agenda.ts';
import { type AgendaShape, kindOfAsk } from './agenda-card.ts';

/** The heading of the card's segment that holds exactly the ask. */
export const AGENDA_NEED_HEADING = 'What I need from you';

/** What the owner is told to do, under the ask, by the card's shape. Plain words, one line each. */
export const AGENDA_SHAPE_LEADS: Readonly<Record<AgendaShape, string>> = {
  choice: 'Pick one option.',
  yesno: 'Answer yes or no.',
  approval: 'Approve or deny.',
  review: 'Review it, then approve or request changes.',
  reply: 'Type your answer below.',
  answers: 'Reply with your answers below, numbered.',
  todo: 'Do these steps, then tap Mark as done.',
  info: 'Nothing to decide. Tap Got it once you have read it.',
  input: 'Type the value below.',
};

/**
 * The refusals a raise that mixes shapes gets, from the CLI and from the daemon alike: each says what was wrong
 * AND the shape to write instead, so a ferret fixes the item in one go.
 */
export const AGENDA_SHAPE_ERRORS = {
  severalQuestions:
    'several questions → write them as a numbered list for the owner to answer in the reply: one --question each, --kind reply; no --option',
  optionsOnlyChoice:
    '--option is only for a choice: ONE question, 2–3 options, each explained (--kind choice). Several questions or a mix → one --question each, --kind reply, the owner answers in the reply',
  stepsOnlyTodo:
    '--step is only for a to-do (--kind todo): steps, then Mark as done. Steps AND a question are a mix → put each answer you need in a --question (--kind reply) and the instructions in --body-file',
  todoAsksNothing:
    'a to-do asks nothing: steps, then Mark as done. To ask something as well → one --question each, --kind reply (the instructions in --body-file)',
  infoAsksNothing:
    'an info card only tells: no --question, --option or --step; the owner taps Got it. To ask → --kind reply',
} as const;

/** One kind as `fy agenda add --help` teaches it: what the owner sees, and an example raise. */
interface ShapeHelp {
  readonly kind: string;
  readonly shows: string;
  readonly example: string;
}

/** Every kind a ferret raises, with the shape it is drawn in and an example of each. */
const SHAPE_HELP: readonly ShapeHelp[] = [
  {
    kind: 'choice',
    shows: 'ONE question, then each option with what it means; the owner taps one (≤3, recommended tagged)',
    example: `-k choice "Which region should the deploy use?" -o "EU: data stays in Europe" -o "US: cheapest" --recommend EU`,
  },
  {
    kind: 'yesno',
    shows: 'one yes-or-no question; the owner taps Yes or No',
    example: `-k yesno "Restart the build box tonight?"`,
  },
  {
    kind: 'permission',
    shows: 'what is being approved and its effect (--impact); the owner taps Approve or Deny',
    example: `-k permission "Delete the old backups?" --impact "Frees 40 GB; they cannot be restored"`,
  },
  {
    kind: 'review',
    shows: 'what to review (--link, --body-file); the owner taps Approve or Request changes',
    example: `-k review "Is the new sign-in page right?" --link https://example.com/preview`,
  },
  {
    kind: 'reply',
    shows: 'an open question, no buttons; the owner types the answer in the reply box',
    example: `-k reply "What should the welcome email say?"`,
  },
  {
    kind: 'reply',
    shows: 'SEVERAL questions or a mix: a numbered list of each answer wanted, no buttons; one reply answers all',
    example: `-k reply "Three answers for the deploy" -q "Which region?" -q "OK to restart?" -q "Your work email?"`,
  },
  {
    kind: 'todo',
    shows: 'numbered steps the owner ticks, then one Mark as done button',
    example: `-k todo "Sign in to the work account" --step "Open **Settings › Logins**" --step "Run \`fy login work\`"`,
  },
  {
    kind: 'info',
    shows: 'something to know, nothing to decide; one Got it button',
    example: `-k info "The nightly build is fixed"`,
  },
];

/**
 * The `fy agenda add --help` table: each kind, what the owner's card shows, and an example (every example also
 * needs `-t`, `--premise` and `--context`).
 */
export const agendaShapeHelp = (fy: string): string =>
  [
    'ONE ANSWER SHAPE PER KIND — the card shows exactly what you need, and nothing else:',
    ...SHAPE_HELP.flatMap(each => [
      `  ${each.kind.padEnd(11)}${each.shows}`,
      `             e.g. ${fy} agenda add -t "<topic>" --premise … --context … ${each.example}`,
    ]),
    'Options are ONLY for a choice; steps ONLY for a to-do. Several questions, or a question mixed with anything',
    'else, is --kind reply with one --question each: never options; the owner answers them all in one reply.',
  ].join('\n');

/**
 * The one line a ferret's prompt carries (`AGENDA_INSTRUCTION`): kind → shape, short on purpose — it is in every
 * prompt that turns Agenda mode on.
 */
export const AGENDA_SHAPE_LINE =
  'Kinds: choice=ONE question+2–3 `-o "Label: why"`, `--recommend`; reply=open question or several/mixed asks (one `-q` each, no options); todo=`--step`s; info=Got it; permission=Approve/Deny.';

/** What a new raise says about its shape: the fields `agendaShapeProblems` reads. */
export interface AgendaShapeRaise {
  readonly kind?: AgendaKind | undefined;
  readonly ask?: AgendaAsk | undefined;
  readonly questions?: readonly AgendaQuestion[] | undefined;
  readonly steps?: readonly string[] | undefined;
  readonly notice?: true | undefined;
  readonly confirms?: unknown;
}

const OPTION_KINDS: ReadonlySet<AgendaKind> = new Set(['choice', 'yesno']);

/**
 * Everything wrong with a NEW ferret raise's shape, each with the shape to write instead — empty when it fits one.
 * A notice and a confirmation have their own fixed shapes (`agendaNoticeProblems`, `agendaConfirmsProblems`), and
 * an item already on the board is never re-read through this: only a raise is.
 */
export const agendaShapeProblems = (raise: AgendaShapeRaise): string[] => {
  if (raise.notice === true || raise.confirms !== undefined) return [];
  const kind = raise.kind ?? kindOfAsk(raise.ask);
  const questions = raise.questions ?? [];
  const hasOptions = raise.ask?.kind === 'multiple-choice' || questions.some(each => each.options !== undefined);
  const problems = new Set<string>();
  if (questions.length > 1 && (kind !== 'reply' || hasOptions)) problems.add(AGENDA_SHAPE_ERRORS.severalQuestions);
  else if (hasOptions && !OPTION_KINDS.has(kind)) problems.add(AGENDA_SHAPE_ERRORS.optionsOnlyChoice);
  if (kind === 'info' && (questions.length > 0 || (raise.steps?.length ?? 0) > 0)) {
    problems.add(AGENDA_SHAPE_ERRORS.infoAsksNothing);
  } else if (kind === 'task' && questions.length > 0) problems.add(AGENDA_SHAPE_ERRORS.todoAsksNothing);
  else if ((raise.steps?.length ?? 0) > 0 && kind !== 'task') problems.add(AGENDA_SHAPE_ERRORS.stepsOnlyTodo);
  return [...problems];
};

/** What an EDIT may not do to an item's shape: give steps to anything but a to-do. */
export const agendaEditShapeProblems = (
  item: { readonly kind?: AgendaKind | undefined; readonly ask?: AgendaAsk | undefined },
  edit: { readonly steps?: readonly string[] | undefined },
): string[] =>
  edit.steps !== undefined && (item.kind ?? kindOfAsk(item.ask)) !== 'task' ? [AGENDA_SHAPE_ERRORS.stepsOnlyTodo] : [];
