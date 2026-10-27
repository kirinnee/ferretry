import { ATTENTION_SUMMARY_TARGET_LENGTH, type AttentionBrief } from '@ferretry/protocol';

/** What an item says, as the lint reads it: the summary, the context and the structured brief. */
export interface AttentionWriting extends AttentionBrief {
  readonly subject: string;
  readonly context?: string | null | undefined;
}

const TICKET_ID = /\b[A-Z][A-Z0-9]{1,9}-\d+\b/gu;
const NUMBERED_REFERENCE = /(?:^|[\s(])#[A-Za-z]?\d+\b/gu;
const URL = /\bhttps?:\/\/\S+/giu;
const FILE_PATH =
  /(?:^|[\s(`"'])(?:~|\.{1,2})?\/[\w.@-]+(?:\/[\w.@-]+)+|\b[\w.@-]+(?:\/[\w.@-]+)+\.(?:ts|tsx|js|jsx|json|md|ya?ml|sh|rs|go|toml|nix)\b/gu;
const ACRONYM = /\b[A-Z]{2,6}\b/gu;
/** Capitals a reader already knows. */
const PLAIN_CAPITALS: ReadonlySet<string> = new Set(['OK', 'AM', 'PM', 'UTC', 'ASAP', 'FYI', 'TODO', 'API']);

const SHOWN_EXAMPLES = 3;

interface Field {
  readonly name: string;
  readonly text: string;
}

/** Every piece of prose the item carries, named for the warning that points at it. */
function fieldsOf(item: AttentionWriting): Field[] {
  const fields: Field[] = [{ name: 'summary', text: item.subject }];
  const push = (name: string, text: string | null | undefined): void => {
    if (text !== undefined && text !== null && text.trim() !== '') fields.push({ name, text });
  };
  push('context', item.context);
  item.questions?.forEach((question, index) => {
    const label = item.questions?.length === 1 ? 'question' : `question ${index + 1}`;
    push(label, [question.question, question.why ?? ''].join(' '));
  });
  push('recommendation', [item.recommendation?.decision ?? '', item.recommendation?.why ?? ''].join(' '));
  push('impact', item.impact);
  push('urgency', item.urgency);
  return fields;
}

/** The words a `terms` entry defines, upper-cased so `oci` defines `OCI`. */
function definedTerms(item: AttentionWriting): ReadonlySet<string> {
  return new Set((item.terms ?? []).map(entry => entry.term.trim().toUpperCase()));
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
  keep: (match: string) => boolean = () => true,
): Map<string, Set<string>> {
  const hits = new Map<string, Set<string>>();
  for (const field of fields) {
    for (const match of field.text.matchAll(pattern)) {
      const found = match[0].trim().replace(/^[("'`]+/u, '');
      if (!keep(found)) continue;
      hits.set(found, (hits.get(found) ?? new Set<string>()).add(field.name));
    }
  }
  return hits;
}

/** A term like `OCI work login` explains the capitals `OCI` that start it. */
function isCoveredByTerm(word: string, defined: ReadonlySet<string>): boolean {
  return [...defined].some(term => term.split(/\s+/u).includes(word));
}

/**
 * Advice on how an item is written, never a refusal: the item is already on the board and the owner
 * has been told. Each line names what to change, so the ferret can fix the item with `attention edit`.
 *
 * The owner reads cold — often on a phone, days later — so an item must stand alone: a short plain
 * summary, no ticket or PR ids, links, file paths or capitals nobody has explained. Anything in
 * `terms` counts as explained.
 */
export function lintAttentionWriting(item: AttentionWriting): string[] {
  const warnings: string[] = [];
  const fields = fieldsOf(item);
  const defined = definedTerms(item);
  const summary = item.subject.trim();

  if (summary.length > ATTENTION_SUMMARY_TARGET_LENGTH) {
    warnings.push(
      `summary is ${summary.length} characters; keep it under ${ATTENTION_SUMMARY_TARGET_LENGTH}: one plain sentence, answer first, detail in context`,
    );
  }

  const unexplained = (id: string): boolean => !defined.has(id.toUpperCase());
  const ids = new Map([
    ...collect(fields, TICKET_ID, unexplained),
    ...collect(fields, NUMBERED_REFERENCE, unexplained),
  ]);
  if (ids.size > 0) {
    warnings.push(
      `ticket or PR ids (${quoted([...ids.keys()])}) in ${whereFound(ids)}: the reader may not know them; say what each is in words, or define it in terms`,
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
