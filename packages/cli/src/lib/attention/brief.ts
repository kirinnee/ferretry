import {
  type AttentionActionRequest,
  AttentionActionRequestSchema,
  type AttentionAsk,
  type AttentionAskOption,
  type AttentionItem,
  type AttentionLink,
  type AttentionQuestion,
  type AttentionTerm,
  defaultAttentionAnswers,
  MAX_ATTENTION_CARD_ANSWERS,
  MAX_ATTENTION_SUBJECT_LENGTH,
  MAX_ATTENTION_TITLE_LENGTH,
  recommendedAttentionOption,
  toBullets,
  type UpAnswer,
} from '@ferretry/protocol';
import { z } from 'zod';
import { type AskFlags, type CardAsk, parseAsk, parseKind, TOO_MANY_ANSWERS } from './ask.ts';

/** The default `howToResolve` when the raiser did not name a concrete action. */
const DEFAULT_HOW_TO_RESOLVE = 'Answer this item on the attention board (it records who answered).';

/** The flags that describe a new item, beside its one-line summary. */
export interface BriefFlags extends AskFlags {
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
  /** Repeated: the situation, one point each; more than one becomes bullets. */
  readonly premise?: string | readonly string[];
  /** Repeated: why it matters now, one point each; more than one becomes bullets. */
  readonly context?: string | readonly string[];
  /** Repeated: earlier answers that bear on this, one point each. */
  readonly decided?: string | readonly string[];
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
  /** The text of `--body-file`: one Markdown document. */
  readonly body?: string;
}

const OptionInput = z.union([z.string(), z.object({ label: z.string(), description: z.string().optional() })]);
/** Text, or a list of short points that is drawn as bullets. */
const Prose = z.union([z.string(), z.array(z.string())]);
const LinkInput = z.union([z.string(), z.object({ label: z.string().optional(), target: z.string() })]);

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
 * Compose the add request one `fy attention add` describes: the words, the flags and, when given, the
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
): Extract<AttentionActionRequest, { action: 'add' }> {
  const subject = askLineFrom(
    text(words.join(' ')) ?? text(flags.ask) ?? text(flags.summary) ?? text(file.ask) ?? text(file.summary),
  );
  const title = titleFrom(text(flags.title) ?? text(file.title));
  const options = flags.option !== undefined && flags.option.length > 0 ? flags.option : undefined;
  const fileOptions = file.options?.map(option);
  const questions = questionsFrom(flags, file, options);
  const steps = stepsFrom(flags.step) ?? stepsFrom(file.steps);
  const named = flags.kind ?? (flags.task === true ? 'task' : file.kind);
  const card = askFor(named, options ?? fileOptions?.map(each => each.label), questions, steps !== undefined);
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
  const body = text(flags.body) ?? text(file.body);
  const answers = defaultAttentionAnswers(
    card.kind,
    ask,
    recommendedAttentionOption({
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
    howToResolve: text(flags.resolve) ?? text(file.resolve) ?? DEFAULT_HOW_TO_RESOLVE,
    ...(ask === undefined ? {} : { ask }),
    ...(answers.length === 0 ? {} : { answers }),
    ...(terms === undefined || terms.length === 0 ? {} : { terms }),
    ...(questions === undefined ? {} : { questions }),
    ...(recommendation === undefined ? {} : { recommendation }),
    ...(impact === undefined ? {} : { impact }),
    ...(urgency === undefined ? {} : { urgency }),
    ...(links === undefined || links.length === 0 ? {} : { links }),
    ...(steps === undefined ? {} : { steps }),
    ...(body === undefined ? {} : { body }),
  };
  const parsed = AttentionActionRequestSchema.safeParse(request);
  if (!parsed.success) throw new Error(describeIssues(parsed.error));
  if (parsed.data.action !== 'add') throw new Error('not an add request');
  return parsed.data;
}

function askLineFrom(summary: string | undefined): string {
  if (summary === undefined) {
    throw new Error('say what you need as words (or --ask), or choose ls, done, dismiss, notify or history');
  }
  const line = summary.replaceAll(/\s+/gu, ' ').trim();
  if (line.length > MAX_ATTENTION_SUBJECT_LENGTH) {
    throw new Error(
      `the ask must fit one line of ${MAX_ATTENTION_SUBJECT_LENGTH} characters (got ${line.length}) — ` +
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
  if (line.length > MAX_ATTENTION_TITLE_LENGTH) {
    throw new Error(
      `the title may not exceed ${MAX_ATTENTION_TITLE_LENGTH} characters (got ${line.length}) — it is the notification heading; aim for 40`,
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
    throw new Error(`--up only fits --kind task (e.g. "Skip") or --kind permission (e.g. "Always allow"), not ${kind}`);
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
): AttentionQuestion[] | undefined {
  const questions: AttentionQuestion[] | undefined =
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
  questions: readonly AttentionQuestion[] | undefined,
  hasSteps: boolean,
): CardAsk {
  const lone = questions?.length === 1 ? questions[0] : undefined;
  const named = parseKind(kind);
  if (named === 'task' && questions !== undefined) {
    throw new Error('a task asks nothing to answer: drop --question, or drop --task');
  }
  if (named === 'info' && questions !== undefined) {
    throw new Error('an info card asks nothing to answer: drop --question, or use --kind reply');
  }
  if (named === 'yesno' && lone?.options !== undefined) {
    throw new Error('--kind yesno brings its own Yes and No: drop the question options (or use --kind choice)');
  }
  // More than three options is more than the swipes can give, wherever the options were written.
  if ((lone?.options?.length ?? 0) > MAX_ATTENTION_CARD_ANSWERS) throw new Error(TOO_MANY_ANSWERS);
  // Steps and nothing to answer is a to-do: the human does it, then marks it done.
  if (named === undefined && options === undefined && questions === undefined && hasSteps) {
    return parseAsk({ kind: 'task' });
  }
  if (named !== undefined || options !== undefined) {
    if (questions !== undefined && questions.length > 1 && options !== undefined) {
      throw new Error('--option belongs to a single question; give each of several questions its own options');
    }
    // `--kind choice` over a lone question that brought its own options chooses between those.
    const choices = options ?? (named === 'choice' ? lone?.options?.map(each => each.label) : undefined);
    return parseAsk({
      ...(named === undefined ? {} : { kind: named }),
      ...(choices === undefined ? {} : { option: choices }),
    });
  }
  if (lone?.options !== undefined) return parseAsk({ option: lone.options.map(each => each.label) });
  return parseAsk({});
}

/** Whether `--recommend` was taken up as the lone question's own recommendation. */
function onQuestion(questions: readonly AttentionQuestion[] | undefined, flags: BriefFlags): boolean {
  const recommended = text(flags.recommend);
  return recommended !== undefined && questions?.length === 1 && questions[0]?.recommended?.trim() === recommended;
}

/** Option descriptions from the body, carried onto the ask's own options. */
function withOptionDetail(
  ask: AttentionAsk | undefined,
  detailed: readonly AttentionAskOption[] | undefined,
): AttentionAsk | undefined {
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
function fileQuestion(value: NonNullable<BriefFile['questions']>[number]): AttentionQuestion {
  if (typeof value === 'string') return { question: value.trim() };
  return {
    question: value.question,
    ...(value.options === undefined ? {} : { options: value.options.map(option) }),
    ...(value.recommended === undefined ? {} : { recommended: value.recommended }),
    ...(value.why === undefined ? {} : { why: value.why }),
  };
}

/** `TERM=meaning`, split at the first `=`. */
function termFrom(raw: string): AttentionTerm {
  const at = raw.indexOf('=');
  const term = at < 0 ? '' : raw.slice(0, at).trim();
  const meaning = at < 0 ? '' : raw.slice(at + 1).trim();
  if (term === '' || meaning === '') throw new Error(`--term needs TERM=meaning, got "${raw}"`);
  return { term, meaning };
}

function option(value: string | { label: string; description?: string | undefined }): AttentionAskOption {
  if (typeof value === 'string') return { label: value.trim() };
  return { label: value.label.trim(), ...(value.description === undefined ? {} : { description: value.description }) };
}

function link(value: string | { label?: string | undefined; target: string }): AttentionLink {
  if (typeof value === 'string') return { target: value.trim() };
  return { target: value.target.trim(), ...(value.label === undefined ? {} : { label: value.label }) };
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
  return points.length === 1 ? points[0] : toBullets(points);
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

/** The fields `fy attention edit` may change, as flags. */
export interface EditFlags {
  readonly title?: string;
  readonly summary?: string;
  readonly premise?: string | readonly string[];
  readonly context?: string | readonly string[];
  readonly decided?: string | readonly string[];
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
}

/**
 * The edit request one `fy attention edit <id>` describes, merged onto the item as it stands: only the
 * writing changes. New question words replace the old in order and keep each question's options,
 * recommendation and reason, so reading the item again is never needed to reword it.
 */
export function composeEditRequest(
  id: AttentionItem['id'],
  flags: EditFlags,
  current: AttentionItem | undefined,
): Extract<AttentionActionRequest, { action: 'edit' }> {
  const summary = text(flags.summary);
  const title = text(flags.title) === undefined ? undefined : titleFrom(text(flags.title));
  const premise = prose(flags.premise);
  const context = prose(flags.context);
  const decided = prose(flags.decided);
  const impact = prose(flags.impact);
  const urgency = text(flags.urgency);
  const decision = text(flags.recommend);
  const why = text(flags.recommendWhy);
  const terms = flags.term !== undefined && flags.term.length > 0 ? flags.term.map(termFrom) : undefined;
  const links = flags.link !== undefined && flags.link.length > 0 ? flags.link.map(link) : undefined;
  const steps = stepsFrom(flags.step);
  const body = text(flags.body);
  const words = (flags.question ?? []).map(question => question.trim()).filter(question => question !== '');
  if (words.length > 0 && current === undefined) throw new Error(`no unresolved attention item ${id} to reword`);
  const before = current?.questions ?? [];
  if (words.length > 0 && words.length !== before.length) {
    throw new Error(`${id} has ${before.length} question(s); give exactly that many --question texts, in order`);
  }
  const questions =
    words.length === 0
      ? undefined
      : before.map((each, index) => ({ ...each, question: words[index] ?? each.question }));
  const request = {
    action: 'edit' as const,
    id,
    ...(summary === undefined ? {} : { subject: summary }),
    ...(title === undefined ? {} : { title }),
    ...(premise === undefined ? {} : { premise }),
    ...(context === undefined ? {} : { context }),
    ...(decided === undefined ? {} : { decided }),
    ...(terms === undefined ? {} : { terms }),
    ...(questions === undefined ? {} : { questions }),
    ...(decision === undefined ? {} : { recommendation: { decision, ...(why === undefined ? {} : { why }) } }),
    ...(impact === undefined ? {} : { impact }),
    ...(urgency === undefined ? {} : { urgency }),
    ...(links === undefined ? {} : { links }),
    ...(steps === undefined ? {} : { steps }),
    ...(body === undefined ? {} : { body }),
  };
  const parsed = AttentionActionRequestSchema.safeParse(request);
  if (!parsed.success) throw new Error(describeIssues(parsed.error));
  if (parsed.data.action !== 'edit') throw new Error('not an edit request');
  return parsed.data;
}
