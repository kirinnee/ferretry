import {
  ATTENTION_ASK_TARGET_LENGTH,
  ATTENTION_PUSH_TITLE_LENGTH,
  type AttentionAsk,
  type AttentionBrief,
  type AttentionCardAnswer,
  type AttentionKind,
  attentionCardAnswers,
  attentionCardKind,
} from '@ferretry/protocol';

/** What an item says, as the lint reads it: its title, its ask, the context, its answers and the brief. */
export interface AttentionWriting extends AttentionBrief {
  /** The one-line ask (the item's summary). */
  readonly subject: string;
  readonly title?: string | undefined;
  readonly kind?: AttentionKind | undefined;
  readonly ask?: AttentionAsk | undefined;
  readonly answers?: readonly AttentionCardAnswer[] | undefined;
  readonly context?: string | null | undefined;
}

const TICKET_ID = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/gu;
const NUMBERED_REFERENCE = /(?:^|[\s(])#[A-Za-z]?\d+\b/gu;
const URL = /\bhttps?:\/\/\S+/giu;
const FILE_PATH =
  /(?:^|[\s(`"'])(?:~|\.{1,2})?\/[\w.@-]+(?:\/[\w.@-]+)+|\b[\w.@-]+(?:\/[\w.@-]+)+\.(?:ts|tsx|js|jsx|json|md|ya?ml|sh|rs|go|toml|nix)\b/gu;
const ACRONYM = /\b[A-Z]{2,6}\b/gu;
/**
 * Words that point at something the card does not carry: an earlier message, a thread, "the PR we
 * discussed". A card is read cold, so whatever they point at has to be said on the card instead.
 */
const BACK_REFERENCE = new RegExp(
  [
    String.raw`\b(?:as|see|per)\s+(?:(?:I\s+)?(?:mentioned|noted|said|discussed|agreed|described|explained|shown)\s+)?(?:above|before|earlier|previously)\b`,
    String.raw`\bas\s+(?:we\s+|you\s+|I\s+)?(?:discussed|agreed|mentioned|planned)\b`,
    String.raw`\bper\s+(?:our|your|the)\s+(?:discussion|conversation|chat|thread|call)\b`,
    String.raw`\b(?:the|that|this)\s+(?:earlier|previous|prior|last|above|aforementioned|same)\s+(?:PR|pull request|message|ticket|issue|thread|comment|item|plan|change|fix|discussion|conversation|question|one)\b`,
    String.raw`\b(?:the|that)\s+(?:PR|pull request|ticket|issue|plan|change|fix|thing|idea|approach|option)\s+(?:we|you|I)\s+(?:discussed|talked about|mentioned|agreed on|agreed)\b`,
  ].join('|'),
  'giu',
);
/** An id that says what it is right after it, in brackets: `#812 (the push worker fix)`. */
const DESCRIBED_ID = /^\s*\(\S+\s+\S[^)]*\)/u;
/** An option label that names nothing: a letter, a number, "Option 2". */
const BARE_OPTION = /^(?:[A-Za-z0-9]|(?:option|choice|plan|approach)\s*[A-Za-z0-9]{1,2})$/iu;
/** Fewer characters than this, with no description, does not say what choosing it does. */
const MIN_OPTION_LENGTH = 3;
/** Short words that need no description. */
const PLAIN_OPTIONS: ReadonlySet<string> = new Set(['yes', 'no', 'ok']);
/** The kinds of card that put a decision to the owner, so a cold reader needs the situation to make it. */
const DECISION_KINDS: ReadonlySet<AttentionKind> = new Set(['permission', 'choice', 'yesno', 'reply']);
/** Capitals a reader already knows. */
const PLAIN_CAPITALS: ReadonlySet<string> = new Set(['OK', 'AM', 'PM', 'UTC', 'ASAP', 'FYI', 'TODO', 'API']);

const SHOWN_EXAMPLES = 3;

interface Field {
  readonly name: string;
  readonly text: string;
}

/**
 * Every piece of prose the item carries, named for the warning that points at it. `steps` and `body`
 * are left out on purpose: instructions legitimately carry commands, paths and links.
 */
function fieldsOf(item: AttentionWriting): Field[] {
  const fields: Field[] = [{ name: 'ask', text: item.subject }];
  const push = (name: string, text: string | null | undefined): void => {
    if (text !== undefined && text !== null && text.trim() !== '') fields.push({ name, text });
  };
  push('title', item.title);
  push('premise', item.premise);
  push('context', item.context);
  push('decided', item.decided);
  item.questions?.forEach((question, index) => {
    const label = item.questions?.length === 1 ? 'question' : `question ${index + 1}`;
    push(label, [question.question, question.why ?? ''].join(' '));
  });
  push('recommendation', [item.recommendation?.decision ?? '', item.recommendation?.why ?? ''].join(' '));
  push('impact', item.impact);
  push('urgency', item.urgency);
  attentionCardAnswers(item).forEach(answer => {
    push(`answer "${answer.label}"`, [answer.label, answer.description ?? ''].join(' '));
  });
  return fields;
}

/** The words a `terms` entry defines, upper-cased so `oci` defines `OCI`. */
function definedTerms(item: AttentionWriting): ReadonlySet<string> {
  return new Set((item.terms ?? []).map(entry => entry.term.trim().toUpperCase()));
}

/** Whether the item asks the owner to decide something: a permission, a choice, a question or an open question. */
function isDecision(item: AttentionWriting): boolean {
  return (item.questions?.length ?? 0) > 0 || DECISION_KINDS.has(attentionCardKind(item));
}

function isBlank(text: string | null | undefined): boolean {
  return text === undefined || text === null || text.trim() === '';
}

function quoted(values: readonly string[]): string {
  const shown = values.slice(0, SHOWN_EXAMPLES).map(value => `"${value}"`);
  return values.length > SHOWN_EXAMPLES ? `${shown.join(', ')} …` : shown.join(', ');
}

/** Where in the item each hit sits, once each, in reading order. */
function whereFound(hits: ReadonlyMap<string, Set<string>>): string {
  return [...new Set([...hits.values()].flatMap(fields => [...fields]))].join(', ');
}

function collect(
  fields: readonly Field[],
  pattern: RegExp,
  keep: (match: string, after: string) => boolean = () => true,
): Map<string, Set<string>> {
  const hits = new Map<string, Set<string>>();
  for (const field of fields) {
    for (const match of field.text.matchAll(pattern)) {
      const found = match[0].trim().replace(/^[("'`]+/u, '');
      if (!keep(found, field.text.slice((match.index ?? 0) + match[0].length))) continue;
      hits.set(found, (hits.get(found) ?? new Set<string>()).add(field.name));
    }
  }
  return hits;
}

/**
 * The choice options that name nothing on their own — a letter, a number, "Option 2", two characters — and
 * carry no description. Yes and No are plain words and a yes-or-no card's own.
 */
function vagueOptions(item: AttentionWriting): string[] {
  if (attentionCardKind(item) !== 'choice' || item.ask?.kind !== 'multiple-choice') return [];
  return item.ask.options
    .filter(option => option.description === undefined)
    .map(option => option.label.trim())
    .filter(label => !PLAIN_OPTIONS.has(label.toLowerCase()))
    .filter(label => BARE_OPTION.test(label) || label.length < MIN_OPTION_LENGTH);
}

/** A term like `OCI work login` explains the capitals `OCI` that start it. */
function isCoveredByTerm(word: string, defined: ReadonlySet<string>): boolean {
  return [...defined].some(term => term.split(/\s+/u).includes(word));
}

/**
 * Advice on how an item is written, never a refusal: the item is already on the board and the owner
 * has been told. Each line names what to change, so the ferret can fix the item with `agenda edit`.
 *
 * The owner reads cold — often on a phone, days later — so THE RULE IS ISOLATION: could the owner answer
 * with nothing else open? Everything needed to decide is on the card. (Premise, the situation, and context,
 * why it matters now, are how a card gets there — a decision card with neither draws the strongest warning,
 * but is never refused.) A short plain title (the push's heading) and ask (its text); no pointing at an
 * earlier message; no ticket or PR ids, links, file paths or capitals nobody has explained; options that
 * say what choosing them does. Anything in `terms` counts as explained, and an id followed by what it is
 * in brackets — `#812 (the push worker fix)` — counts as described.
 */
export function lintAttentionWriting(item: AttentionWriting): string[] {
  const warnings: string[] = [];
  const fields = fieldsOf(item);
  const defined = definedTerms(item);
  const ask = item.subject.trim();
  const title = item.title?.trim() ?? '';

  if (title === '') {
    warnings.push(
      `no title: add one with \`agenda edit <id> --title "<what this is about>"\` — a few plain words, under ${ATTENTION_PUSH_TITLE_LENGTH} characters; it is the notification heading`,
    );
  } else if (title.length > ATTENTION_PUSH_TITLE_LENGTH) {
    warnings.push(
      `title is ${title.length} characters; keep it under ${ATTENTION_PUSH_TITLE_LENGTH} so a lock screen shows it whole: what the item is about, not the question (--title)`,
    );
  }

  if (ask.length > ATTENTION_ASK_TARGET_LENGTH) {
    warnings.push(
      `ask is ${ask.length} characters; keep it under ${ATTENTION_ASK_TARGET_LENGTH}: the one question or action, answer first; move the rest to --context`,
    );
  }

  if (isDecision(item) && isBlank(item.premise) && isBlank(item.context)) {
    warnings.push(
      'a reader opening this cold cannot tell what is going on — add --premise points (the situation, one bullet each) with `agenda edit <id> --premise "<what is going on>"`, and --context for why it matters now',
    );
  }

  const backReferences = collect(fields, BACK_REFERENCE);
  if (backReferences.size > 0) {
    warnings.push(
      `points elsewhere (${quoted([...backReferences.keys()])}) in ${whereFound(backReferences)}: the owner reads this card alone, often days later; say the thing itself on the card instead`,
    );
  }

  const unexplained = (id: string, after: string): boolean =>
    !defined.has(id.toUpperCase()) && !DESCRIBED_ID.test(after);
  const ids = new Map([
    ...collect(fields, TICKET_ID, unexplained),
    ...collect(fields, NUMBERED_REFERENCE, unexplained),
  ]);
  if (ids.size > 0) {
    warnings.push(
      `ticket or PR ids (${quoted([...ids.keys()])}) in ${whereFound(ids)}: the reader may not know them; say what each is in words — "#812 (the push worker fix)" — or define it in terms`,
    );
  }

  const vague = vagueOptions(item);
  if (vague.length > 0) {
    warnings.push(
      `options ${quoted(vague)} do not say what choosing them does: give each a few words ("Ship it today") or a description, so the card can be answered without reading anything else`,
    );
  }

  const urls = collect(fields, URL);
  if (urls.size > 0) {
    warnings.push(
      `links (${quoted([...urls.keys()])}) in ${whereFound(urls)}: put URLs in links and name them in words in the text`,
    );
  }

  const paths = collect(fields, FILE_PATH);
  if (paths.size > 0) {
    warnings.push(
      `file paths (${quoted([...paths.keys()])}) in ${whereFound(paths)}: say what the file does in words; put the path in links`,
    );
  }

  const prose = fields.map(field => ({
    ...field,
    text: field.text.replaceAll(TICKET_ID, ' ').replaceAll(URL, ' ').replaceAll(FILE_PATH, ' '),
  }));
  const acronyms = collect(
    prose,
    ACRONYM,
    word => !PLAIN_CAPITALS.has(word) && !defined.has(word) && !isCoveredByTerm(word, defined),
  );
  if (acronyms.size > 0) {
    warnings.push(
      `unexplained capitals (${quoted([...acronyms.keys()])}) in ${whereFound(acronyms)}: spell them out, or add each to terms with its meaning`,
    );
  }
  return warnings;
}
