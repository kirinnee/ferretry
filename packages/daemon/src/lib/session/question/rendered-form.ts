import type { PendingQuestion, StructuredQuestionAnswer } from '@ferretry/protocol';

/**
 * Reading a harness's native question form off a captured pane.
 *
 * The answer driver types into whatever this file says is on screen, so it is pure and it refuses to
 * guess. Every shape below was captured from a real pane (fixtures `tests/fixtures/question-forms/`):
 *
 *   Claude Code 2.1.281   `❯ 1. Label` rows with the description indented beneath; a single question
 *                          is drawn with a `│` gutter on every wrapped line of its text; the free-form
 *                          row is `Type something.` and is its own text field; a multi-select row is
 *                          `[ ] Label`, Enter TOGGLES it, and a separate unnumbered `Submit` row ends
 *                          the page; a multi-select or multi-question form ends on a "Review your
 *                          answers" page whose `Submit answers` row must be chosen as well.
 *                          Such a form is TABBED: a strip `←  ☒ Colour  ☐ Extras  ✔ Submit  →` above
 *                          the question ticks each question once it has an answer, ←/→ move between
 *                          tabs, answering a tab moves to the next one, and a tab revisited after it
 *                          was answered marks its chosen row `Label ✔`. The review page lists every
 *                          answered question as `● question` then `→ answer`, and warns when any is
 *                          still unanswered.
 *   Codex 0.156.1          `› 1. Label  description` — two columns flattened onto one line; a
 *                          `Question 1/2` header; the free-form row is `None of the above` and takes
 *                          its text as a note opened with Tab.
 *
 * WHY THE SCROLLBACK IS READ AS WELL AS THE SCREEN. A form taller than the pane pushes its own header —
 * the question text — off the top of the screen, while its rows and cursor stay at the bottom. The rows
 * are bound ONLY on the visible screen, because a form that has closed leaves its rows in the scrollback
 * and a stale row must never be mistaken for a live one; the question text is searched for upward from
 * those rows, through the scrollback if it has to be, but never past the form's own top border.
 */

export type RenderedQuestion = PendingQuestion['questions'][number];

/**
 * How the harness takes free-form text, read off the row it rendered for it.
 *
 * `inline`: the row is itself a text field (Claude) — paste on it, then Enter.
 * `notes`: Tab opens a note under the row (Codex) — Tab, paste, then Enter.
 * `page`: Enter opens a separate free-form page that is bound again before the text is pasted.
 */
type FreeFormEntry = 'inline' | 'notes' | 'page';

/** The label a free-form answer is driven as, whatever the harness calls its row. */
const FREE_FORM_LABEL = 'Other';

export interface BoundQuestionForm {
  /** Every navigable row, in Up/Down order; the free-form row is named {@link FREE_FORM_LABEL}. */
  readonly labels: readonly string[];
  /** Whether each row's multi-select box is ticked; `false` for a row without one. */
  readonly checked: readonly boolean[];
  /** The navigation index the cursor is on, or `undefined` when no bound row carries it. */
  readonly cursor: number | undefined;
  readonly freeForm?: { readonly index: number; readonly entry: FreeFormEntry };
  /** The navigation index of a separate Submit row that ends a multi-select page. */
  readonly submit?: number;
  /** The row a revisited, already answered tab marks `✔` as its answer. */
  readonly chosen?: number;
}

export interface ReviewPage {
  /** The navigation index of the cursor, or `undefined` when it is not on a bound row. */
  readonly cursor: number | undefined;
  /** The navigation index of the row that submits the reviewed answers. */
  readonly submit: number;
  /** The answer the page lists for each pending question, in question order; `undefined` when unlisted. */
  readonly shown: readonly (string | undefined)[];
}

/** A tabbed form's strip, bound to the pending questions. */
export interface TabStrip {
  /** Whether each pending question's tab is ticked as answered, in question order. */
  readonly answered: readonly boolean[];
}

/** The pane as the binder reads it: scrollback above the screen, and where the screen begins. */
export interface QuestionScreen {
  readonly lines: readonly string[];
  readonly visibleFrom: number;
}

interface Row {
  readonly line: number;
  readonly cursor: boolean;
  readonly checked: boolean | undefined;
  /** Marked `✔` as a revisited tab's answer. */
  readonly chosen: boolean;
  readonly text: string;
  /** Lines under the row that belong to it (a wrapped label, then its description). */
  readonly continuation: readonly string[];
}

interface Block {
  readonly rows: readonly Row[];
  readonly submit?: { readonly line: number; readonly cursor: boolean };
  /** The lines between the form's top border and its first row: where its question is drawn. */
  readonly header: readonly string[];
}

const CURSOR = '[❯›>➜▶]';
/** `❯ 1. Label`, `  2. Label`, `  › 1. Label  description`: at most four columns before the number. */
const NUMBERED_ROW = new RegExp(
  `^(?<lead> *)(?<cursor>${CURSOR} ?)?(?<pad> *)(?<number>\\d{1,2})\\.\\s+(?<rest>.*)$`,
  'u',
);
const SUBMIT_ROW = new RegExp(`^\\s*(?<cursor>${CURSOR})?\\s*Submit\\s*$`, 'u');
const CHECKBOX = /^\[(?<mark>.)\]\s+/u;
/** A full-width horizontal rule: the border Claude draws above and inside a form. */
const RULE = /^\s*[─━═]{8,}\s*$/u;
/** Codex's header, `Question 1/2 (2 unanswered)`, which is where its form begins. */
const CODEX_HEADER = /^\s*Question \d+\/\d+\b/u;
/** The gutter a harness draws beside a quoted question, which is not part of its text. */
const GUTTER = /^\s*[│┃▏▎▍]\s?/u;
/** How far above its rows a form's header may be searched for, scrollback included. */
const HEADER_REACH = 200;
/** Claude's tab strip: `←  ☒ Colour  ☐ Extras  ✔ Submit  →`. Codex's `←/→ to navigate` hint never matches. */
const TAB_STRIP = /^\s*←\s+(?<tabs>.+?)\s+→\s*$/u;
const TAB = /^(?<mark>[☐☒])\s+(?<label>.+)$/u;
const SUBMIT_TAB = /^✔\s+Submit$/u;
/** The mark a revisited tab puts after the row it was answered with. */
const CHOSEN = /\s+✔$/u;

const FREE_FORM_ROWS: readonly { readonly pattern: RegExp; readonly entry: FreeFormEntry }[] = [
  { pattern: /^type something\.?$/iu, entry: 'inline' },
  { pattern: /^none of the above$/iu, entry: 'notes' },
  { pattern: /^other(?:…|\.\.\.)?$/iu, entry: 'page' },
];

const compact = (value: string): string => value.replace(/\s+/gu, ' ').trim();
/** Whitespace-free, so a wrap at any column — even inside a word — compares equal to the source. */
const dense = (value: string): string => value.replace(/\s+/gu, '');

function lines(text: string): string[] {
  const split = text.split('\n');
  if (split.at(-1) === '') split.pop();
  return split;
}

/**
 * The scrollback above the screen, then the screen.
 *
 * `history` is a capture of the whole pane (`capture-pane -S -`), which ENDS with the visible screen; only
 * the part above it is new. Two captures are not one instant, so a history that does not end the way the
 * screen does contributes nothing rather than lines that might be out of order.
 */
export function questionScreen(visible: string, history: string): QuestionScreen {
  const screen = lines(visible);
  const all = lines(history);
  const above = all.length > screen.length ? all.slice(0, all.length - screen.length) : [];
  const tail = all.slice(above.length);
  const aligned = tail.length === screen.length && tail.every((line, index) => line === screen[index]);
  const scrollback = aligned ? above : [];
  return { lines: [...scrollback, ...screen], visibleFrom: scrollback.length };
}

function numbered(line: string): Omit<Row, 'continuation' | 'line'> & { readonly number: number } {
  // A revisited tab's `Label ✔` is read as the label plus the mark, so it binds like any other row.
  const match = NUMBERED_ROW.exec(line);
  const groups = match?.groups;
  const none = { number: 0, cursor: false, checked: undefined, chosen: false, text: '' };
  if (groups === undefined) return none;
  const lead = (groups.lead ?? '').length + (groups.cursor ?? '').length + (groups.pad ?? '').length;
  if (lead > 4) return none;
  const rest = groups.rest ?? '';
  const box = CHECKBOX.exec(rest);
  const label = box === null ? rest : rest.slice(box[0].length);
  // Codex flattens its two columns onto one line; only the first is the label.
  const text = compact(label.split(/\s{2,}/u)[0] ?? '');
  return {
    number: Number(groups.number),
    cursor: groups.cursor !== undefined,
    checked: box === null ? undefined : (box.groups?.mark ?? ' ') !== ' ',
    chosen: CHOSEN.test(text),
    text: text.replace(CHOSEN, ''),
  };
}

/**
 * The LAST run of rows numbered 1, 2, 3… whose rows all lie on the visible screen.
 *
 * A rule ends a run (Claude's `Chat about this` sits below one and is not an answer), and so does a
 * number out of sequence. The last run is the live form: whatever a transcript printed above it —
 * including a prompt that quoted the very same options — came earlier.
 */
function lastBlock(screen: QuestionScreen): Block | undefined {
  let found: Block | undefined;
  let rows: Row[] = [];
  let submit: Block['submit'];
  let open = false;
  const close = (): void => {
    if (rows.length > 0 && (rows[0]?.line ?? -1) >= screen.visibleFrom)
      found = { rows, ...(submit === undefined ? {} : { submit }), header: headerAbove(screen, rows[0]?.line ?? 0) };
    rows = [];
    submit = undefined;
    open = false;
  };
  for (let index = 0; index < screen.lines.length; index++) {
    const line = screen.lines[index] ?? '';
    const row = numbered(line);
    if (row.number === 1) {
      close();
      open = true;
    }
    if (open && row.number === rows.length + 1 && submit === undefined) {
      rows.push({
        line: index,
        cursor: row.cursor,
        checked: row.checked,
        chosen: row.chosen,
        text: row.text,
        continuation: [],
      });
      continue;
    }
    if (!open) continue;
    if (row.number > 0 || RULE.test(line)) {
      close();
      continue;
    }
    const submitRow = SUBMIT_ROW.exec(line);
    if (submitRow !== null && submit === undefined) {
      submit = { line: index, cursor: submitRow.groups?.cursor !== undefined };
      continue;
    }
    const last = rows.at(-1);
    if (last !== undefined && submit === undefined && line.trim() !== '')
      rows[rows.length - 1] = { ...last, continuation: [...last.continuation, line] };
  }
  close();
  return found;
}

/**
 * The lines between a form's first row and its top: a rule, Codex's `Question n/m`, or Claude's tab
 * strip. The strip is a top of its own because the rule above it is not always kept: once a re-drawn
 * form has scrolled, the line above the strip can be anything the transcript printed — including a
 * prompt that quotes another of the form's questions.
 */
function headerAbove(screen: QuestionScreen, first: number): readonly string[] {
  const header: string[] = [];
  for (let index = first - 1; index >= Math.max(0, first - HEADER_REACH); index--) {
    const line = screen.lines[index] ?? '';
    if (RULE.test(line)) break;
    header.unshift(line);
    if (CODEX_HEADER.test(line) || TAB_STRIP.test(line)) break;
  }
  return header;
}

function shows(header: readonly string[], text: string): boolean {
  const wanted = dense(text);
  return wanted !== '' && dense(header.map(line => line.replace(GUTTER, '')).join('\n')).includes(wanted);
}

/** Whether a row is this label: its first line, or its first line joined to a wrapped remainder. */
function rowIs(row: Row, label: string): boolean {
  const wanted = dense(label);
  let text = dense(row.text);
  if (text === wanted) return true;
  for (const line of row.continuation.slice(0, 2)) {
    text += dense(line);
    if (text === wanted) return true;
    if (!wanted.startsWith(text)) return false;
  }
  return false;
}

/**
 * The exact pending question, positively bound on the pane — or `undefined`.
 *
 * Bound means: the question's text is drawn in the header of the live form, and EVERY option the
 * transcript recorded is one of its rows. A free-form row is recognised by name and offered as
 * {@link FREE_FORM_LABEL}; any other row the transcript does not name keeps its own text, so it can
 * never be chosen by accident.
 */
export function bindQuestionForm(screen: QuestionScreen, question: RenderedQuestion): BoundQuestionForm | undefined {
  const block = lastBlock(screen);
  if (block === undefined || !shows(block.header, question.question)) return undefined;
  const options = question.options?.map(option => compact(option.label)) ?? [];
  if (options.length === 0) return undefined;
  const labels: string[] = [];
  let freeForm: BoundQuestionForm['freeForm'];
  for (const [index, row] of block.rows.entries()) {
    const option = options.find(label => label !== FREE_FORM_LABEL && rowIs(row, label));
    const entry = FREE_FORM_ROWS.find(candidate => candidate.pattern.test(row.text))?.entry;
    if (option !== undefined) labels.push(option);
    else if (entry !== undefined && freeForm === undefined) {
      labels.push(FREE_FORM_LABEL);
      freeForm = { index, entry };
    } else labels.push(row.text);
  }
  if (!options.every(label => labels.includes(label))) return undefined;
  const submit = block.submit === undefined ? undefined : block.rows.length;
  const onRow = block.rows.findIndex(row => row.cursor);
  const chosen = block.rows.findIndex(row => row.chosen);
  return {
    labels,
    checked: block.rows.map(row => row.checked === true),
    cursor: onRow >= 0 ? onRow : block.submit?.cursor === true ? submit : undefined,
    ...(freeForm === undefined ? {} : { freeForm }),
    ...(submit === undefined ? {} : { submit }),
    ...(chosen < 0 ? {} : { chosen }),
  };
}

/**
 * Which pending question the live form is showing, or `undefined` when none of them is bound.
 *
 * When one question's text contains another's, both bind; the longer one is what the header shows.
 */
export function boundQuestionIndex(screen: QuestionScreen, questions: readonly RenderedQuestion[]): number | undefined {
  let found: number | undefined;
  for (const [index, question] of questions.entries()) {
    if (bindQuestionForm(screen, question) === undefined) continue;
    if (found === undefined || dense(question.question).length > dense(questions[found]?.question ?? '').length)
      found = index;
  }
  return found;
}

/**
 * The live form's tab strip, bound to exactly these questions in order, or `undefined`.
 *
 * Bound only when the strip has one ticked-or-not tab per question, each named by that question's
 * header, and ends on the `✔ Submit` tab. A question without a header is matched by position alone.
 */
export function bindTabStrip(screen: QuestionScreen, questions: readonly RenderedQuestion[]): TabStrip | undefined {
  const block = lastBlock(screen);
  if (block === undefined) return undefined;
  const strip = block.header.findLast(line => TAB_STRIP.test(line));
  const tabs = (strip === undefined ? undefined : TAB_STRIP.exec(strip)?.groups?.tabs)?.trim().split(/\s{2,}/u);
  if (tabs === undefined || tabs.length !== questions.length + 1 || !SUBMIT_TAB.test(tabs.at(-1) ?? ''))
    return undefined;
  const answered: boolean[] = [];
  for (const [index, question] of questions.entries()) {
    const tab = TAB.exec(tabs[index] ?? '')?.groups;
    if (tab === undefined || !tabNames(tab.label ?? '', question.header)) return undefined;
    answered.push(tab.mark === '☒');
  }
  return { answered };
}

function tabNames(label: string, header: string | undefined): boolean {
  if (header === undefined) return true;
  const shown = dense(label);
  // A header too long for its tab is cut with an ellipsis; what is left must still be its start.
  return shown.endsWith('…') ? dense(header).startsWith(shown.slice(0, -1)) : shown === dense(header);
}

/**
 * Claude's closing "Review your answers" page for exactly these questions, or `undefined`.
 *
 * Bound only when the page offers `Submit answers` as a row and is positively this form's: it names
 * every one of the questions, or the tab strip above it binds them (a page with a question still
 * unanswered lists only the answered ones). Choosing `Submit answers` is the one key that finishes a
 * form, so it is never pressed on a page that merely looks similar — and the driver presses it only
 * once {@link ReviewPage.shown} lists exactly the requested answers.
 */
export function bindReviewPage(screen: QuestionScreen, questions: readonly RenderedQuestion[]): ReviewPage | undefined {
  const block = lastBlock(screen);
  if (block === undefined || !block.header.some(line => /review your answers/iu.test(line))) return undefined;
  if (
    !questions.every(question => shows(block.header, question.question)) &&
    bindTabStrip(screen, questions) === undefined
  )
    return undefined;
  const items = reviewed(block.header);
  const indexOf = (item: ReviewItem): number =>
    questions.findIndex(question => dense(question.question) === dense(item.question));
  // A page listing a question this form does not have is some other form's review.
  if (items.some(item => indexOf(item) < 0)) return undefined;
  const submit = block.rows.findIndex(row => /^submit answers$/iu.test(row.text));
  if (submit < 0) return undefined;
  const cursor = block.rows.findIndex(row => row.cursor);
  return {
    cursor: cursor >= 0 ? cursor : undefined,
    submit,
    shown: questions.map((_, index) => items.find(item => indexOf(item) === index)?.answer),
  };
}

interface ReviewItem {
  question: string;
  answer: string | undefined;
}

/** The `● question` / `→ answer` pairs a review page lists, wrapped lines joined. */
function reviewed(header: readonly string[]): readonly ReviewItem[] {
  const items: ReviewItem[] = [];
  let inside = false;
  for (const line of header) {
    const text = line.replace(GUTTER, '').trim();
    if (/^review your answers$/iu.test(text)) inside = true;
    else if (!inside || text === '' || text.startsWith('⚠')) continue;
    else if (/^ready to submit/iu.test(text)) break;
    else if (text.startsWith('●')) items.push({ question: text.slice(1), answer: undefined });
    else {
      const item = items.at(-1);
      if (item === undefined) continue;
      if (text.startsWith('→')) item.answer = text.slice(1).trim();
      else if (item.answer === undefined) item.question += ` ${text}`;
      else item.answer += ` ${text}`;
    }
  }
  return items;
}

/**
 * Whether a review page lists exactly this answer for its question.
 *
 * Several choices are listed comma-separated, in the form's own order or the order they were given;
 * a long typed answer cut with an ellipsis must still be the start of what was asked for.
 */
export function reviewShowsAnswer(
  shown: string | undefined,
  question: RenderedQuestion,
  answer: StructuredQuestionAnswer,
): boolean {
  if (shown === undefined) return false;
  const listed = dense(shown);
  const wanted =
    answer.kind === 'other'
      ? [answer.text]
      : [
          (question.options ?? [])
            .map(option => option.label)
            .filter(label => answer.labels.includes(label))
            .join(','),
          answer.labels.join(','),
        ];
  return wanted.some(text =>
    listed.endsWith('…') ? dense(text).startsWith(listed.slice(0, -1)) : dense(text) === listed,
  );
}

/** Whether the question's text is drawn anywhere on the screen, for a free-form page opened by Enter. */
export function screenShowsQuestion(screen: QuestionScreen, question: string): boolean {
  return shows(screen.lines.slice(screen.visibleFrom), question);
}
