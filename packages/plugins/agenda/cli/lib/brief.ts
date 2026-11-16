import {
  AGENDA_SHAPE_ERRORS,
  type AgendaActionRequest,
  AgendaActionRequestSchema,
  type AgendaAsk,
  type AgendaAskOption,
  type AgendaCardAnswer,
  type AgendaItem,
  type AgendaKind,
  type AgendaLink,
  type AgendaOptionDetail,
  type AgendaQuestion,
  type AgendaStage,
  AgendaStageSchema,
  type AgendaTerm,
  agendaEditShapeProblems,
  agendaShapeProblems,
  defaultAgendaAnswers,
  MAX_AGENDA_CARD_ANSWERS,
  MAX_AGENDA_SUBJECT_LENGTH,
  MAX_AGENDA_TITLE_LENGTH,
  recommendedAgendaOption,
  stripListMarker,
  toBullets,
  type UpAnswer,
} from '@ferretry/core-asks/contract';
import { z } from 'zod';
import { type AskFlags, type CardAsk, parseAsk, parseKind, TOO_MANY_ANSWERS } from './ask.ts';
import { type FieldInput, fieldsFrom } from './fields.ts';
import { DEFAULT_HOW_TO_RESOLVE } from './how-to-resolve.ts';

/** The flags that describe a new item, beside its one-line summary. */
export interface BriefFlags extends AskFlags {
  /** `--stage`: what the item needs from the owner now (explainer, question, plan, tracker, test). */
  readonly stage?: string;
  /** `--where`, repeated: the main tab, "Where we are now", as points, one each (`--where-file` gives it whole). */
  readonly where?: string | readonly string[];
  /** `--detail`: the context explained from zero, as Markdown (drawn folded away). */
  readonly detail?: string;
  /** The card's heading and the push's title: what this is about, in a few plain words. Required. */
  readonly title?: string;
  /** The one-line ask, when it is not given as words; `summary` is the older name for it. */
  readonly ask?: string;
  readonly summary?: string;
  /** The extra up-swipe answer a task (does dismiss) or a permission (does approve) takes. */
  readonly up?: string;
  /** One line that describes the `up` answer. */
  readonly upWhy?: string;
  readonly why?: string;
  /** The ferret is stopped until the owner answers. */
  readonly blocking?: boolean;
  /** What this will block, in a few words. */
  readonly willBlock?: string;
  /** The instant it is needed by, already read from `--by`. */
  readonly neededBy?: string;
  /** Repeated: the situation, one point each; more than one becomes bullets. */
  readonly premise?: string | readonly string[];
  /** Repeated: the facts around the situation, one point each; more than one becomes bullets. */
  readonly context?: string | readonly string[];
  /** Repeated: earlier answers that bear on this, one point each. */
  readonly decided?: string | readonly string[];
  /** Repeated: what is still open to decide, one point each. */
  readonly stillOpen?: string | readonly string[];
  readonly resolve?: string;
  /** `TERM=meaning`, repeated. */
  readonly term?: readonly string[];
  /** One question each, repeated. */
  readonly question?: readonly string[];
  /** The suggested decision: an option label, or the answer in words. */
  readonly recommend?: string;
  readonly recommendWhy?: string;
  /** Repeated: more than one becomes bullets. */
  readonly impact?: string | readonly string[];
  readonly urgency?: string;
  /** A URL, a path or a reference, repeated. */
  readonly link?: readonly string[];
  /** One Markdown step each, in order, repeated. */
  readonly step?: readonly string[];
  /** The text of `--body-file`: the body, the item's live document, as one Markdown document. */
  readonly body?: string;
  /** A configuration file whose held change the owner's Allow puts into effect (`--confirms`). */
  readonly confirms?: string;
  /** `label=markdown`, repeated: the longer explanation of one option. */
  readonly optionDetail?: readonly string[];
  /** `id|type|Question|option…`, repeated: one field of a form (`fields.ts`). */
  readonly field?: readonly string[];
}

const OptionInput = z.union([z.string(), z.object({ label: z.string(), description: z.string().optional() })]);
/** Text, or a list of short points that is drawn as bullets. */
const Prose = z.union([z.string(), z.array(z.string())]);
const LinkInput = z.union([
  z.string(),
  z.object({ label: z.string().optional(), target: z.string(), meaning: z.string().optional() }),
]);

/**
 * The JSON body `--json-file` reads: the same fields as the flags, in the protocol's own shapes where it
 * has one. Unknown keys are refused, so a misspelt field is said rather than silently dropped.
 */
const BriefFileSchema = z.strictObject({
  title: z.string().optional(),
  ask: z.string().optional(),
  summary: z.string().optional(),
  up: z.union([z.string(), z.object({ label: z.string(), description: z.string().optional() })]).optional(),
  why: z.string().optional(),
  premise: Prose.optional(),
  context: Prose.optional(),
  decided: Prose.optional(),
  stillOpen: Prose.optional(),
  resolve: z.string().optional(),
  kind: z.string().optional(),
  options: z.array(OptionInput).optional(),
  terms: z.array(z.object({ term: z.string(), meaning: z.string() })).optional(),
  questions: z
    .array(
      z.union([
        z.string(),
        z.object({
          question: z.string(),
          options: z.array(OptionInput).optional(),
          recommended: z.string().optional(),
          why: z.string().optional(),
        }),
      ]),
    )
    .optional(),
  recommendation: z.union([z.string(), z.object({ decision: z.string(), why: z.string().optional() })]).optional(),
  impact: Prose.optional(),
  urgency: z.string().optional(),
  links: z.array(LinkInput).optional(),
  steps: z.array(z.string()).optional(),
  body: z.string().optional(),
  blocking: z.boolean().optional(),
  willBlock: z.string().optional(),
  neededBy: z.string().optional(),
  confirms: z.string().optional(),
  stage: z.string().optional(),
  whereWeAre: Prose.optional(),
  detail: z.string().optional(),
  optionDetails: z.array(z.object({ label: z.string(), detail: z.string() })).optional(),
  fields: z
    .array(
      z.strictObject({
        id: z.union([z.string(), z.number()]),
        type: z.string(),
        label: z.string(),
        name: z.string().optional(),
        options: z.array(OptionInput).optional(),
        recommended: z.union([z.string(), z.array(z.string())]).optional(),
        required: z.boolean().optional(),
      }),
    )
    .optional(),
});
export type BriefFile = z.infer<typeof BriefFileSchema>;

/** Parse the text `--json-file` read, naming what is wrong with it. */
export function parseBriefFile(text: string): BriefFile {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`--json-file is not JSON: ${(error as Error).message}`);
  }
  const parsed = BriefFileSchema.safeParse(json);
  if (!parsed.success) throw new Error(`--json-file: ${describeIssues(parsed.error)}`);
  return parsed.data;
}

/**
 * Compose the add request one `fy agenda add` describes: the words, the flags and, when given, the
 * JSON body. A flag wins over the same field in the body, so a script can reuse a body and change one
 * thing.
 *
 * THE ASK FOLLOWS THE QUESTIONS when `--kind` does not say: exactly one question with options is a
 * choice between them (and its options are the swipe deck's); several questions are answered in words,
 * one answer each; otherwise the old rules (`--option` implies a choice, the default is open).
 */
export function composeAddRequest(
  words: readonly string[],
  flags: BriefFlags,
  file: BriefFile = {},
): Extract<AgendaActionRequest, { action: 'add' }> {
  const subject = askLineFrom(
    text(words.join(' ')) ?? text(flags.ask) ?? text(flags.summary) ?? text(file.ask) ?? text(file.summary),
  );
  const title = titleFrom(text(flags.title) ?? text(file.title));
  const picked = (flags.option ?? []).map(splitOption);
  const options = picked.length > 0 ? picked.map(each => each.label) : undefined;
  const optionDetails = optionDetailsFrom(
    [
      ...(file.optionDetails ?? []),
      ...picked.flatMap(each => (each.detail === undefined ? [] : [{ label: each.label, detail: each.detail }])),
    ],
    flags.optionDetail,
  );
  const fileOptions = file.options?.map(option);
  const questions = questionsFrom(flags, file, options);
  const steps = stepsFrom(flags.step) ?? stepsFrom(file.steps);
  const fields = fieldsFrom(flags.field, file.fields as readonly FieldInput[] | undefined);
  const named =
    flags.kind ?? (flags.task === true ? 'todo' : (file.kind ?? (fields === undefined ? undefined : 'form')));
  const confirms = confirmsFrom(flags, file, named, options ?? fileOptions, questions);
  const card = askFor(
    named,
    options ?? fileOptions?.map(each => each.label),
    questions,
    steps !== undefined && confirms === undefined,
  );
  const ask = withOptionDetail(card.ask, fileOptions);
  // A recommendation that is the lone question's own pick is said once, on the question.
  const recommendation = onQuestion(questions, flags) ? undefined : recommendationFrom(flags, file);
  const terms = flags.term !== undefined && flags.term.length > 0 ? flags.term.map(termFrom) : file.terms;
  const links = flags.link !== undefined && flags.link.length > 0 ? flags.link.map(link) : file.links?.map(link);
  const impact = prose(flags.impact) ?? prose(file.impact);
  const urgency = text(flags.urgency) ?? text(file.urgency);
  const premise = prose(flags.premise) ?? prose(file.premise);
  const context = prose(flags.context) ?? prose(file.context);
  const decided = prose(flags.decided) ?? prose(file.decided);
  const stillOpen = prose(flags.stillOpen) ?? prose(file.stillOpen);
  const body = text(flags.body) ?? text(file.body);
  const blocking = flags.blocking === true || file.blocking === true;
  const willBlock = text(flags.willBlock) ?? text(file.willBlock);
  const neededBy = text(flags.neededBy) ?? text(file.neededBy);
  const stage = stageFrom(text(flags.stage) ?? text(file.stage));
  const whereWeAre = prose(flags.where) ?? prose(file.whereWeAre);
  const detail = text(flags.detail) ?? text(file.detail);
  const answers = defaultAgendaAnswers(
    card.kind,
    ask,
    recommendedAgendaOption({
      ask,
      ...(questions === undefined ? {} : { questions }),
      ...(recommendation === undefined ? {} : { recommendation }),
    }),
    upFrom(card.kind, flags, file),
  );

  const request = {
    action: 'add' as const,
    source: 'agent-raised' as const,
    sourceRef: null,
    subject,
    title,
    kind: card.kind,
    why: text(flags.why) ?? text(file.why) ?? subject,
    context: context ?? null,
    ...(premise === undefined ? {} : { premise }),
    ...(decided === undefined ? {} : { decided }),
    ...(stillOpen === undefined ? {} : { stillOpen }),
    howToResolve: text(flags.resolve) ?? text(file.resolve) ?? DEFAULT_HOW_TO_RESOLVE,
    ...(ask === undefined ? {} : { ask }),
    ...(answers.length === 0 ? {} : { answers }),
    ...(terms === undefined || terms.length === 0 ? {} : { terms }),
    ...(questions === undefined ? {} : { questions }),
    ...(recommendation === undefined ? {} : { recommendation }),
    ...(optionDetails === undefined ? {} : { optionDetails }),
    ...(fields === undefined ? {} : { fields }),
    ...(impact === undefined ? {} : { impact }),
    ...(urgency === undefined ? {} : { urgency }),
    ...(links === undefined || links.length === 0 ? {} : { links }),
    ...(steps === undefined ? {} : { steps }),
    ...(body === undefined ? {} : { body }),
    ...(blocking ? { blockingNow: true as const } : {}),
    ...(willBlock === undefined ? {} : { willBlock }),
    ...(neededBy === undefined ? {} : { neededBy }),
    ...(stage === undefined ? {} : { stage }),
    ...(whereWeAre === undefined ? {} : { whereWeAre }),
    ...(detail === undefined ? {} : { detail }),
  };
  // ONE ANSWER SHAPE PER KIND: the daemon refuses a mix with the same words, so it is said here first.
  const shape = confirms === undefined ? agendaShapeProblems(request) : [];
  if (shape.length > 0) throw new Error(shape.join('; '));
  const parsed = AgendaActionRequestSchema.safeParse(
    confirms === undefined ? request : confirmationRequest(request, confirms),
  );
  if (!parsed.success) throw new Error(describeIssues(parsed.error));
  if (parsed.data.action !== 'add') throw new Error('not an add request');
  return parsed.data;
}

/**
 * The file `--confirms` names, when it names one. The daemon writes a confirmation's card itself — Allow,
 * Deny and Discard change — so the flags that choose a card's kind or answers are refused beside it.
 */
function confirmsFrom(
  flags: BriefFlags,
  file: BriefFile,
  kind: string | undefined,
  options: readonly unknown[] | undefined,
  questions: readonly AgendaQuestion[] | undefined,
): string | undefined {
  const path = text(flags.confirms) ?? text(file.confirms);
  if (path === undefined) return undefined;
  const clashing = [
    ...(kind === undefined ? [] : ['--kind']),
    ...(options === undefined ? [] : ['--option']),
    ...(questions === undefined ? [] : ['--question']),
    ...(text(flags.up) === undefined && file.up === undefined ? [] : ['--up']),
  ];
  if (clashing.length > 0) {
    throw new Error(
      `--confirms writes the card's answers itself (Allow, Deny, Discard change): drop ${clashing.join(', ')}`,
    );
  }
  return path;
}

/** The add request for a confirmation: the card's own kind, ask and answers left to the daemon. */
function confirmationRequest<T extends { readonly kind?: unknown; readonly ask?: unknown; readonly answers?: unknown }>(
  request: T,
  confirms: string,
): Omit<T, 'kind' | 'ask' | 'answers'> & { readonly confirms: string } {
  const { kind: _kind, ask: _ask, answers: _answers, ...rest } = request;
  return { ...rest, confirms };
}

function askLineFrom(summary: string | undefined): string {
  if (summary === undefined) {
    throw new Error('say what you need as words (or --ask), or choose ls, done, dismiss or history');
  }
  const line = summary.replaceAll(/\s+/gu, ' ').trim();
  if (line.length > MAX_AGENDA_SUBJECT_LENGTH) {
    throw new Error(
      `the ask must fit one line of ${MAX_AGENDA_SUBJECT_LENGTH} characters (got ${line.length}) — ` +
        'put the detail in --context',
    );
  }
  return line;
}

/** The card's title: required, one line, and short enough to head a notification. */
function titleFrom(raw: string | undefined): string {
  if (raw === undefined) {
    throw new Error(
      'give the card a title: --title "<what this is about, ≤40 chars, plain words, no IDs>" — it is the notification heading',
    );
  }
  const line = raw.replaceAll(/\s+/gu, ' ').trim();
  if (line.length > MAX_AGENDA_TITLE_LENGTH) {
    throw new Error(
      `the title may not exceed ${MAX_AGENDA_TITLE_LENGTH} characters (got ${line.length}) — it is the notification heading; aim for 40`,
    );
  }
  return line;
}

/**
 * The up answer a task or a permission may carry. It fits no other kind, and `--up-why` only describes it.
 */
function upFrom(kind: CardAsk['kind'], flags: BriefFlags, file: BriefFile): UpAnswer | undefined {
  const fromFile = typeof file.up === 'string' ? { label: file.up } : file.up;
  const label = text(flags.up) ?? text(fromFile?.label);
  const description = text(flags.upWhy) ?? (text(flags.up) === undefined ? text(fromFile?.description) : undefined);
  if (label === undefined) {
    if (text(flags.upWhy) !== undefined) throw new Error('--up-why describes --up: give --up "<label>" too');
    return undefined;
  }
  if (kind !== 'task' && kind !== 'permission') {
    throw new Error(`--up only fits --kind todo (e.g. "Skip") or --kind permission (e.g. "Always allow"), not ${kind}`);
  }
  return { label, ...(description === undefined ? {} : { description }) };
}

/**
 * The questions: `--question` flags, or the body's. A lone question takes the item's `--option`s and,
 * when `--recommend` names one of them, that recommendation.
 */
function questionsFrom(
  flags: BriefFlags,
  file: BriefFile,
  options: readonly string[] | undefined,
): AgendaQuestion[] | undefined {
  const questions: AgendaQuestion[] | undefined =
    flags.question !== undefined && flags.question.length > 0
      ? flags.question.map(question => ({ question: question.trim() }))
      : file.questions?.map(fileQuestion);
  if (questions === undefined || questions.length === 0) return undefined;
  const [only] = questions;
  if (questions.length !== 1 || only === undefined || options === undefined) return questions;
  if (only.options !== undefined) throw new Error('give the options with --option or in the question, not both');
  const recommended = text(flags.recommend);
  const labels = options.map(label => label.trim());
  return [
    {
      ...only,
      options: labels.map(label => ({ label })),
      ...(recommended !== undefined && labels.includes(recommended) ? { recommended } : {}),
      ...(recommended !== undefined && labels.includes(recommended) && text(flags.recommendWhy) !== undefined
        ? { why: text(flags.recommendWhy) }
        : {}),
    },
  ];
}

function askFor(
  kind: string | undefined,
  options: readonly string[] | undefined,
  questions: readonly AgendaQuestion[] | undefined,
  hasSteps: boolean,
): CardAsk {
  const lone = questions?.length === 1 ? questions[0] : undefined;
  const named = parseKind(kind);
  if (named === 'task' && questions !== undefined) throw new Error(AGENDA_SHAPE_ERRORS.todoAsksNothing);
  if (named === 'info' && questions !== undefined) throw new Error(AGENDA_SHAPE_ERRORS.infoAsksNothing);
  // Several questions are answered in one reply, as a numbered list: never options, never another kind.
  const several = (questions?.length ?? 0) > 1;
  if (several && (options !== undefined || questions?.some(each => each.options !== undefined) === true)) {
    throw new Error(AGENDA_SHAPE_ERRORS.severalQuestions);
  }
  if (several && named !== undefined && named !== 'reply') throw new Error(AGENDA_SHAPE_ERRORS.severalQuestions);
  if (named === 'yesno' && lone?.options !== undefined) {
    throw new Error('--kind yesno brings its own Yes and No: drop the question options (or use --kind choice)');
  }
  // More than three options is more than the swipes can give, wherever the options were written.
  if ((lone?.options?.length ?? 0) > MAX_AGENDA_CARD_ANSWERS) throw new Error(TOO_MANY_ANSWERS);
  // Steps and nothing to answer is a to-do: the human does it, then marks it done.
  if (named === undefined && options === undefined && questions === undefined && hasSteps) {
    return parseAsk({ kind: 'todo' });
  }
  if (named !== undefined || options !== undefined) {
    // `--kind choice` over a lone question that brought its own options chooses between those.
    const choices = options ?? (named === 'choice' ? lone?.options?.map(each => each.label) : undefined);
    return parseAsk({
      ...(named === undefined || kind === undefined ? {} : { kind }),
      ...(choices === undefined ? {} : { option: choices }),
    });
  }
  if (lone?.options !== undefined) return parseAsk({ option: lone.options.map(each => each.label) });
  return parseAsk({});
}

/** Whether `--recommend` was taken up as the lone question's own recommendation. */
function onQuestion(questions: readonly AgendaQuestion[] | undefined, flags: BriefFlags): boolean {
  const recommended = text(flags.recommend);
  return recommended !== undefined && questions?.length === 1 && questions[0]?.recommended?.trim() === recommended;
}

/** Option descriptions from the body, carried onto the ask's own options. */
function withOptionDetail(
  ask: AgendaAsk | undefined,
  detailed: readonly AgendaAskOption[] | undefined,
): AgendaAsk | undefined {
  if (ask?.kind !== 'multiple-choice' || detailed === undefined) return ask;
  const byLabel = new Map(detailed.map(each => [each.label.trim(), each]));
  return { ...ask, options: ask.options.map(each => byLabel.get(each.label.trim()) ?? each) };
}

function recommendationFrom(flags: BriefFlags, file: BriefFile): { decision: string; why?: string } | undefined {
  const decision = text(flags.recommend);
  if (decision !== undefined) {
    const why = text(flags.recommendWhy);
    return { decision, ...(why === undefined ? {} : { why }) };
  }
  if (file.recommendation === undefined) return undefined;
  return typeof file.recommendation === 'string' ? { decision: file.recommendation } : file.recommendation;
}

/** A body's question, plain words or the protocol's shape with plain-string options allowed. */
function fileQuestion(value: NonNullable<BriefFile['questions']>[number]): AgendaQuestion {
  if (typeof value === 'string') return { question: value.trim() };
  return {
    question: value.question,
    ...(value.options === undefined ? {} : { options: value.options.map(option) }),
    ...(value.recommended === undefined ? {} : { recommended: value.recommended }),
    ...(value.why === undefined ? {} : { why: value.why }),
  };
}

/** The longest label part `--option "Label: detail"` is read as; a longer lead is a sentence, not a label. */
const OPTION_LABEL_SPLIT_MAX = 40;

/** `--option "Label: detail"`: the label, and its detail when the text before the first ": " is short. */
function splitOption(raw: string): { readonly label: string; readonly detail?: string } {
  const at = raw.indexOf(': ');
  const label = at < 0 ? '' : raw.slice(0, at).trim();
  const detail = at < 0 ? '' : raw.slice(at + 2).trim();
  if (label === '' || label.length > OPTION_LABEL_SPLIT_MAX || detail === '') return { label: raw.trim() };
  return { label, detail };
}

/** `label=markdown`, split at the first `=`. */
function optionDetailFrom(raw: string): AgendaOptionDetail {
  const at = raw.indexOf('=');
  const label = at < 0 ? '' : raw.slice(0, at).trim();
  const detail = at < 0 ? '' : raw.slice(at + 1).trim();
  if (label === '' || detail === '') throw new Error(`--option-detail needs label=markdown, got "${raw}"`);
  return { label, detail };
}

/** Every option's detail, however it was given; one option said twice keeps its last words, in first-said order. */
function optionDetailsFrom(
  said: readonly AgendaOptionDetail[],
  flags: readonly string[] | undefined,
): AgendaOptionDetail[] | undefined {
  const byLabel = new Map<string, AgendaOptionDetail>();
  for (const each of [...said, ...(flags ?? []).map(optionDetailFrom)]) {
    byLabel.set(each.label.trim(), { label: each.label.trim(), detail: each.detail.trim() });
  }
  return byLabel.size === 0 ? undefined : [...byLabel.values()];
}

/** `TERM=meaning`, split at the first `=`. */
function termFrom(raw: string): AgendaTerm {
  const at = raw.indexOf('=');
  const term = at < 0 ? '' : raw.slice(0, at).trim();
  const meaning = at < 0 ? '' : raw.slice(at + 1).trim();
  if (term === '' || meaning === '') throw new Error(`--term needs TERM=meaning, got "${raw}"`);
  return { term, meaning };
}

function option(value: string | { label: string; description?: string | undefined }): AgendaAskOption {
  if (typeof value === 'string') return { label: value.trim() };
  return { label: value.label.trim(), ...(value.description === undefined ? {} : { description: value.description }) };
}

function link(
  value: string | { label?: string | undefined; target: string; meaning?: string | undefined },
): AgendaLink {
  if (typeof value === 'string') return linkFrom(value);
  const meaning = text(value.meaning);
  return {
    target: value.target.trim(),
    ...(value.label === undefined ? {} : { label: value.label }),
    ...(meaning === undefined ? {} : { meaning }),
  };
}

/**
 * `--link`: a bare target, `label=target`, or `label=target=meaning` (the meaning is the plain words the item view's
 * terms-and-references table shows). The label is read only when it looks like one: a word or two, never a URL or a path,
 * so a bare target that carries an `=` of its own (`https://host/page?a=b`) stays a target. The meaning starts at the
 * last `=` whose tail is a sentence (an address never holds a space), skipping an `=` inside the meaning when the
 * target before the first `=` holds none. With no sentence, the first `=` opens the meaning unless it plausibly belongs
 * to the target: a `?` before it (a query) or an address after it (`docs/a=b.md`). One trailing `=` is an empty meaning.
 */
function linkFrom(raw: string): AgendaLink {
  const value = raw.trim();
  const first = value.indexOf('=');
  const label = first < 0 ? '' : value.slice(0, first).trim();
  if (first < 0 || label === '' || /[/?&\\]/u.test(label)) return { target: value };
  const rest = value.slice(first + 1).replace(/=\s*$/u, '');
  const cut = meaningStart(rest);
  const head = rest.slice(0, cut).trim();
  // A doubled `==` before a meaning is an empty target-side `=`; a query target may end in one legitimately.
  const target = cut < rest.length && head.endsWith('=') && !head.includes('?') ? head.slice(0, -1).trim() : head;
  if (target === '') throw new Error(`--link needs label=target or label=target=meaning, got "${raw}"`);
  const meaning = text(rest.slice(cut + 1));
  return { label, target, ...(meaning === undefined ? {} : { meaning }) };
}

/**
 * What the person is told when a labelled `--link` keeps an `=` in its target and no meaning was read: the part after
 * the last `=` may have been a one-word meaning that cannot be told from the address's own `=`, and `--json-file` says it unambiguously.
 */
export function linkFlagNotices(flags: readonly string[] | undefined): string[] {
  return (flags ?? []).flatMap(raw => {
    const { label, target, meaning } = linkFrom(raw);
    if (label === undefined || meaning !== undefined || !target.includes('=')) return [];
    const tail = target.slice(target.lastIndexOf('=') + 1);
    if (tail === '') return [];
    return [
      `read "${target}" as the whole target of "${label}"; if "${tail}" is its meaning, give the link through --json-file`,
    ];
  });
}

/** Where the `=` that opens a link's meaning sits in `target[=meaning]`, or its length when there is none. */
function meaningStart(rest: string): number {
  const first = rest.indexOf('=');
  if (first < 0) return rest.length;
  const skipSpaced = !/\s/u.test(rest.slice(0, first));
  for (let at = rest.lastIndexOf('='); at >= 0; at = rest.lastIndexOf('=', at - 1)) {
    if (/\s/u.test(rest.slice(at + 1).trim()) && !(skipSpaced && /\s/u.test(rest.slice(0, at).trim()))) return at;
    if (at === 0) break;
  }
  const belongs = rest.slice(0, first).includes('?') || /[/?.:&\\]/u.test(rest.slice(first + 1));
  return belongs ? rest.length : first;
}

/**
 * Text, or points: one value is kept as written; several are bullets, one per point. Nothing when
 * every value is blank.
 */
function prose(value: string | readonly string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return text(value);
  const points = value.map(point => point.trim()).filter(point => point !== '');
  if (points.length === 0) return undefined;
  return points.length === 1
    ? /[\r\n]/u.test(points[0] as string)
      ? points[0]
      : stripListMarker(points[0] as string)
    : toBullets(points);
}

/** The steps, in order, with blank ones dropped; nothing when none are left. */
function stepsFrom(value: readonly string[] | undefined): string[] | undefined {
  const steps = (value ?? []).map(step => step.trim()).filter(step => step !== '');
  return steps.length === 0 ? undefined : steps;
}

/** A trimmed value, or nothing when it was absent or blank. */
function text(value: string | undefined): string | undefined {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? undefined : trimmed;
}

/** Each schema complaint as `path: message`, so a too-long field is named. */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map(issue => {
      const path = issue.path.map(String).join('.');
      return path === '' ? issue.message : `${path}: ${issue.message}`;
    })
    .join('; ');
}

/** The fields `fy agenda edit` may change, as flags. */
export interface EditFlags {
  /** `--stage`: what the item needs from the owner now. */
  readonly stage?: string;
  /** `--where`, repeated: replaces where things stand now. */
  readonly where?: string | readonly string[];
  /** `--detail`: replaces the context explained from zero. */
  readonly detail?: string;
  /** `--clear-question-answer`: takes a stale answer to the owner's question off the item. */
  readonly clearQuestionAnswer?: boolean;
  /**
   * `--kind`: REPLACES THE ASK with a new one of this kind (`agenda.asks.1`), composed as `add` composes one:
   * `--option` and `--question` then name its options and questions. The item asks again, fresh.
   */
  readonly kind?: string;
  readonly title?: string;
  readonly summary?: string;
  readonly premise?: string | readonly string[];
  readonly context?: string | readonly string[];
  readonly decided?: string | readonly string[];
  /** Repeated: what is still open to decide, one point each. */
  readonly stillOpen?: string | readonly string[];
  readonly term?: readonly string[];
  /** The new wording of the item's questions, in order — as many as it has. */
  readonly question?: readonly string[];
  readonly recommend?: string;
  readonly recommendWhy?: string;
  readonly impact?: string | readonly string[];
  readonly urgency?: string;
  readonly link?: readonly string[];
  /** Replaces the steps, in order; repeat. Clears any ticks. */
  readonly step?: readonly string[];
  /** The text of `--body-file`: replaces the body. */
  readonly body?: string;
  /** `--question-answer`: the answer to the owner's question about the item, shown above its options. */
  readonly questionAnswer?: string;
  readonly blocking?: boolean;
  readonly notBlocking?: boolean;
  readonly willBlock?: string;
  readonly clearWillBlock?: boolean;
  /** The instant it is needed by, already read from `--by`. */
  readonly neededBy?: string;
  readonly clearBy?: boolean;
  /** `Label: detail`: the longer explanation of one of the item's options (an edit never changes the options). */
  readonly option?: readonly string[];
  /** `label=markdown`, repeated: the longer explanation of one option. */
  readonly optionDetail?: readonly string[];
  /** Replaces a form's fields: `id|type|Question|option…`, repeated, all of them. */
  readonly field?: readonly string[];
}

/** A typed `--stage`, read as one of the stages, or `undefined` when none was given. */
function stageFrom(typed: string | undefined): AgendaStage | undefined {
  if (typed === undefined) return undefined;
  const parsed = AgendaStageSchema.safeParse(typed.trim().toLowerCase());
  if (!parsed.success || parsed.data === 'done') {
    throw new Error(
      `--stage is one of ${AgendaStageSchema.options.filter(each => each !== 'done').join(', ')} (done is \`agenda done\`), not "${typed}"`,
    );
  }
  return parsed.data;
}

/** The ask an edit's `--kind` REPLACES the item's with, composed from `--option` and `--question` as `add` does. */
function replacementOf(flags: EditFlags):
  | {
      readonly kind: AgendaKind;
      readonly ask?: AgendaAsk;
      readonly answers?: AgendaCardAnswer[];
      readonly questions?: AgendaQuestion[];
      readonly optionDetails?: { label: string; detail: string }[];
    }
  | undefined {
  const named = text(flags.kind);
  if (named === undefined) return undefined;
  const picked = (flags.option ?? []).map(splitOption);
  const options = picked.length > 0 ? picked.map(each => each.label) : undefined;
  const asked: BriefFlags = {
    ...(flags.question === undefined ? {} : { question: flags.question }),
    ...(flags.recommend === undefined ? {} : { recommend: flags.recommend }),
    ...(flags.recommendWhy === undefined ? {} : { recommendWhy: flags.recommendWhy }),
  };
  const questions = questionsFrom(asked, {}, options);
  const card = askFor(named, options, questions, stepsFrom(flags.step) !== undefined);
  const answers = defaultAgendaAnswers(
    card.kind,
    card.ask,
    recommendedAgendaOption({ ask: card.ask, ...(questions === undefined ? {} : { questions }) }),
    undefined,
  );
  const optionDetails = optionDetailsFrom(
    picked.flatMap(each => (each.detail === undefined ? [] : [{ label: each.label, detail: each.detail }])),
    flags.optionDetail,
  );
  return {
    kind: card.kind,
    ...(card.ask === undefined ? {} : { ask: card.ask }),
    ...(answers.length === 0 ? {} : { answers }),
    ...(questions === undefined ? {} : { questions }),
    ...(optionDetails === undefined ? {} : { optionDetails }),
  };
}

/**
 * The edit request one `fy agenda edit <id>` describes, merged onto the item as it stands: only the
 * writing changes. New question words replace the old in order and keep each question's options,
 * recommendation and reason, so reading the item again is never needed to reword it.
 */
export function composeEditRequest(
  id: AgendaItem['id'],
  flags: EditFlags,
  current: AgendaItem | undefined,
): Extract<AgendaActionRequest, { action: 'edit' }> {
  const summary = text(flags.summary);
  const title = text(flags.title) === undefined ? undefined : titleFrom(text(flags.title));
  const premise = prose(flags.premise);
  const context = prose(flags.context);
  const decided = prose(flags.decided);
  const stillOpen = prose(flags.stillOpen);
  const impact = prose(flags.impact);
  const urgency = text(flags.urgency);
  const decision = text(flags.recommend);
  const why = text(flags.recommendWhy);
  const terms = flags.term !== undefined && flags.term.length > 0 ? flags.term.map(termFrom) : undefined;
  const links = flags.link !== undefined && flags.link.length > 0 ? flags.link.map(link) : undefined;
  const steps = stepsFrom(flags.step);
  const stepProblem = current === undefined ? undefined : agendaEditShapeProblems(current, { steps })[0];
  if (stepProblem !== undefined) throw new Error(stepProblem);
  const body = text(flags.body);
  const questionAnswer = text(flags.questionAnswer);
  const fields = fieldsFrom(flags.field, undefined);
  const willBlock = text(flags.willBlock);
  const neededBy = text(flags.neededBy);
  const stage = stageFrom(text(flags.stage));
  const whereWeAre = prose(flags.where);
  const detail = text(flags.detail);
  if (questionAnswer !== undefined && flags.clearQuestionAnswer === true) {
    throw new Error('--question-answer and --clear-question-answer contradict');
  }
  const replaced = replacementOf(flags);
  const optionDetails =
    replaced !== undefined
      ? replaced.optionDetails
      : optionDetailsFrom(
          (flags.option ?? []).map(raw => {
            const picked = splitOption(raw);
            if (picked.detail === undefined) {
              throw new Error(
                `an edit keeps the options unless it replaces the ask: give --option "Label: detail" or --option-detail for ${raw.trim()}, or --kind with the new options`,
              );
            }
            return { label: picked.label, detail: picked.detail };
          }),
          flags.optionDetail,
        );
  if (flags.blocking === true && flags.notBlocking === true)
    throw new Error('--blocking and --not-blocking contradict');
  if (willBlock !== undefined && flags.clearWillBlock === true) {
    throw new Error('--will-block and --clear-will-block contradict');
  }
  if (neededBy !== undefined && flags.clearBy === true) throw new Error('--by and --clear-by contradict');
  const clear = [
    ...(flags.notBlocking === true ? ['blockingNow' as const] : []),
    ...(flags.clearWillBlock === true ? ['willBlock' as const] : []),
    ...(flags.clearBy === true ? ['neededBy' as const] : []),
    ...(flags.clearQuestionAnswer === true ? ['questionAnswer' as const] : []),
  ];
  const words = (flags.question ?? []).map(question => question.trim()).filter(question => question !== '');
  if (replaced === undefined && words.length > 0 && current === undefined) {
    throw new Error(`no open agenda item ${id} to reword`);
  }
  const before = current?.questions ?? [];
  if (replaced === undefined && words.length > 0 && words.length !== before.length) {
    throw new Error(
      `${id} has ${before.length} question(s); give exactly that many --question texts, in order (or --kind to replace the ask)`,
    );
  }
  const questions =
    replaced !== undefined
      ? replaced.questions
      : words.length === 0
        ? undefined
        : before.map((each, index) => ({ ...each, question: words[index] ?? each.question }));
  const request = {
    action: 'edit' as const,
    id,
    ...(replaced === undefined
      ? {}
      : {
          kind: replaced.kind,
          ...(replaced.ask === undefined ? {} : { ask: replaced.ask }),
          ...(replaced.answers === undefined ? {} : { answers: replaced.answers }),
        }),
    ...(stage === undefined ? {} : { stage }),
    ...(whereWeAre === undefined ? {} : { whereWeAre }),
    ...(detail === undefined ? {} : { detail }),
    ...(summary === undefined ? {} : { subject: summary }),
    ...(title === undefined ? {} : { title }),
    ...(premise === undefined ? {} : { premise }),
    ...(context === undefined ? {} : { context }),
    ...(decided === undefined ? {} : { decided }),
    ...(stillOpen === undefined ? {} : { stillOpen }),
    ...(terms === undefined ? {} : { terms }),
    ...(questions === undefined ? {} : { questions }),
    ...(decision === undefined ? {} : { recommendation: { decision, ...(why === undefined ? {} : { why }) } }),
    ...(optionDetails === undefined ? {} : { optionDetails }),
    ...(fields === undefined ? {} : { fields }),
    ...(impact === undefined ? {} : { impact }),
    ...(urgency === undefined ? {} : { urgency }),
    ...(links === undefined ? {} : { links }),
    ...(steps === undefined ? {} : { steps }),
    ...(body === undefined ? {} : { body }),
    ...(questionAnswer === undefined ? {} : { questionAnswer }),
    ...(flags.blocking === true ? { blockingNow: true as const } : {}),
    ...(willBlock === undefined ? {} : { willBlock }),
    ...(neededBy === undefined ? {} : { neededBy }),
    ...(clear.length === 0 ? {} : { clear }),
  };
  const parsed = AgendaActionRequestSchema.safeParse(request);
  if (!parsed.success) throw new Error(describeIssues(parsed.error));
  if (parsed.data.action !== 'edit') throw new Error('not an edit request');
  return parsed.data;
}
