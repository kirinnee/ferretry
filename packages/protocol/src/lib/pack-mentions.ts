/**
 * MODEL NAMES IN THE MODELS GUIDE'S PROSE: which words name a model the fleet knows, which name one
 * that is known but not on this machine, and which look like a model name nobody lists — plus the
 * suggestions a field offers while somebody types one.
 *
 * The vocabulary is every model in every catalog in effect (`GET /v1/pack` › `models`), so a guide
 * may recommend a model another machine runs. A word is recognised by its id or its label, ignoring
 * case: `gpt-oss:20b`, `deepseek-flash[1m]`, `~anthropic/claude-opus-latest` and `Claude Opus 5.5`
 * are each one name. A recognised name must stand alone — `gpt-6-astra` inside `gpt-6-astra-mini` is
 * not a mention of `gpt-6-astra`, it is an unknown name that starts the same way.
 *
 * Pure: text and models in, segments out.
 */

import type { PackFleetModel } from './pack.ts';

/** `known`: a model a runtime here can run. `absent`: listed, but nowhere on this machine. */
export type MentionKind = 'text' | 'known' | 'absent' | 'unknown';

export interface MentionSegment {
  readonly kind: MentionKind;
  readonly text: string;
  readonly start: number;
  readonly end: number;
  /** The model a `known` or `absent` segment names. */
  readonly model?: PackFleetModel;
}

interface Term {
  readonly text: string;
  readonly model: PackFleetModel;
}

/** The names a field recognises, longest first so `Claude Opus 5.5` wins over a shorter label. */
export interface ModelVocabulary {
  readonly models: readonly PackFleetModel[];
  readonly terms: readonly Term[];
}

const available = (model: PackFleetModel): boolean => model.runtimes.length > 0;

/** One stable key per catalog entry: the same id may be listed by two providers, or for both CLIs. */
export const modelKey = (model: PackFleetModel): string => `${model.provider}:${model.harness}:${model.id}`;

/** Every id and label, each naming its best model: the one a runtime here can run, when two share it. */
export function modelVocabulary(models: readonly PackFleetModel[]): ModelVocabulary {
  const byTerm = new Map<string, PackFleetModel>();
  for (const model of models) {
    for (const name of [model.id, model.label]) {
      const term = name.trim().toLocaleLowerCase();
      if (term === '') continue;
      const held = byTerm.get(term);
      if (held === undefined || (!available(held) && available(model))) byTerm.set(term, model);
    }
  }
  const terms = [...byTerm].map(([text, model]) => ({ text, model })).sort((a, b) => b.text.length - a.text.length);
  return { models, terms };
}

const TOKEN_CHAR = /[\p{L}\p{N}_\-[\]~@/]/u;
const ALNUM = /[\p{L}\p{N}]/u;

/** Whether the character at `index` belongs to a name: `.` and `:` only between two of its characters. */
const inToken = (text: string, index: number): boolean => {
  const char = text[index];
  if (char === undefined) return false;
  if (TOKEN_CHAR.test(char)) return true;
  if (char !== '.' && char !== ':') return false;
  const before = text[index - 1];
  const after = text[index + 1];
  return before !== undefined && after !== undefined && TOKEN_CHAR.test(before) && ALNUM.test(after);
};

/** Model families whose names a person writes, so `claude-foo` or `glm5` reads as a model name. */
const FAMILY =
  /^~?(?:[\w-]+\/)?(?:gpt|claude|glm|gemini|gemma|llama|qwen|deepseek|mistral|mixtral|kimi|minimax|sonnet|opus|haiku|fable|codex|grok|phi)[-.:_\d[]/iu;
/** Letters, a dash and a digit, or the other way round: how model versions are spelled (`astra-6`, `5-mini`). */
const DIGIT_DASH = /\p{L}-\d|\d-\p{L}/u;
const INTRODUCER = /^(?:--)?models?$/iu;

/** Whether a word nobody lists still looks like somebody meant a model by it. */
export function looksLikeModel(token: string, previousWord: string | null): boolean {
  if (!/\p{L}/u.test(token)) return false;
  if (FAMILY.test(token) || DIGIT_DASH.test(token)) return true;
  return previousWord !== null && INTRODUCER.test(previousWord) && /[\d\-:./[]/u.test(token);
}

/** The name at `start`, if one ends exactly on a word boundary. */
const termAt = (text: string, lower: string, start: number, vocabulary: ModelVocabulary): Term | undefined =>
  vocabulary.terms.find(term => lower.startsWith(term.text, start) && !inToken(text, start + term.text.length));

/**
 * The text cut into plain runs and mentions. Adjacent plain characters form one segment, so joining
 * every segment's text gives the input back unchanged — which is what lets an overlay mirror a field.
 */
export function modelMentions(text: string, vocabulary: ModelVocabulary): readonly MentionSegment[] {
  const lower = text.toLocaleLowerCase();
  const segments: MentionSegment[] = [];
  let plainStart = 0;
  let previousWord: string | null = null;
  const flush = (until: number): void => {
    if (until > plainStart)
      segments.push({ kind: 'text', text: text.slice(plainStart, until), start: plainStart, end: until });
  };
  let index = 0;
  while (index < text.length) {
    if (!inToken(text, index) || (index > 0 && inToken(text, index - 1))) {
      index += 1;
      continue;
    }
    const term = termAt(text, lower, index, vocabulary);
    if (term !== undefined) {
      const end = index + term.text.length;
      flush(index);
      segments.push({
        kind: available(term.model) ? 'known' : 'absent',
        text: text.slice(index, end),
        start: index,
        end,
        model: term.model,
      });
      plainStart = end;
      previousWord = null;
      index = end;
      continue;
    }
    let end = index;
    while (inToken(text, end)) end += 1;
    const word = text.slice(index, end);
    if (looksLikeModel(word, previousWord)) {
      flush(index);
      segments.push({ kind: 'unknown', text: word, start: index, end });
      plainStart = end;
    }
    previousWord = word;
    index = end;
  }
  flush(text.length);
  return segments;
}

/** The mentions alone, each model once, in the order they first appear. */
export function mentionedModels(segments: readonly MentionSegment[]): readonly MentionSegment[] {
  const seen = new Set<string>();
  return segments.filter(segment => {
    if (segment.kind === 'text') return false;
    const key = segment.model === undefined ? `?${segment.text.toLocaleLowerCase()}` : modelKey(segment.model);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Suggestions ──────────────────────────────────────────────────────────────────────────────────

/** The word the caret is in, as far as the caret: what a suggestion replaces, and what it is matched on. */
export interface MentionQuery {
  readonly start: number;
  readonly end: number;
  readonly query: string;
}

/** While typing, `.` and `:` count even at the end — `glm-5.` is a name half written. */
const LOOSE_CHAR = /[\p{L}\p{N}_\-[\]~@/.:]/u;

export function mentionQueryAt(text: string, caret: number): MentionQuery | null {
  const at = Math.max(0, Math.min(text.length, caret));
  let start = at;
  while (start > 0 && LOOSE_CHAR.test(text[start - 1] ?? '')) start -= 1;
  let end = at;
  while (end < text.length && LOOSE_CHAR.test(text[end] ?? '')) end += 1;
  const query = text.slice(start, at);
  return query.length === 0 ? null : { start, end, query };
}

const TIER_ORDER: Readonly<Record<PackFleetModel['tier'], number>> = { best: 0, balanced: 1, fast: 2 };

/**
 * The models a query could mean, best first: an id that starts with it, then a label that does, then
 * either containing it; within each, a model this machine runs before one it does not, then by tier.
 * `minimum` characters must be typed first, so a field does not pop a list on every letter.
 */
export function suggestModels(
  models: readonly PackFleetModel[],
  query: string,
  { limit = 8, minimum = 2 }: { readonly limit?: number; readonly minimum?: number } = {},
): readonly PackFleetModel[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle.length < minimum) return [];
  const rank = (model: PackFleetModel): number => {
    const id = model.id.toLocaleLowerCase();
    const label = model.label.toLocaleLowerCase();
    if (id.startsWith(needle)) return 0;
    if (label.startsWith(needle)) return 1;
    if (id.includes(needle)) return 2;
    return label.includes(needle) ? 3 : -1;
  };
  return models
    .map(model => ({ model, rank: rank(model) }))
    .filter(entry => entry.rank >= 0)
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        Number(available(b.model)) - Number(available(a.model)) ||
        TIER_ORDER[a.model.tier] - TIER_ORDER[b.model.tier] ||
        a.model.label.localeCompare(b.model.label),
    )
    .slice(0, limit)
    .map(entry => entry.model);
}

/** Whether a list would only repeat what is already typed: the one suggestion IS the word. */
export const suggestionsAreSettled = (suggestions: readonly PackFleetModel[], word: string): boolean => {
  const typed = word.toLocaleLowerCase();
  return (
    suggestions.length > 0 &&
    suggestions.every(model => model.id.toLocaleLowerCase() === typed || model.label.toLocaleLowerCase() === typed)
  );
};

/** The text with the word replaced by a model's id, and where the caret goes after it. */
export function applyModelSuggestion(
  text: string,
  range: Pick<MentionQuery, 'start' | 'end'>,
  model: PackFleetModel,
): { readonly text: string; readonly caret: number } {
  const next = `${text.slice(0, range.start)}${model.id}${text.slice(range.end)}`;
  return { text: next, caret: range.start + model.id.length };
}

/** The model a candidate's model field names exactly, by id or label, preferring one this machine runs. */
export function modelNamed(vocabulary: ModelVocabulary, name: string): PackFleetModel | undefined {
  const term = name.trim().toLocaleLowerCase();
  return vocabulary.terms.find(entry => entry.text === term)?.model;
}

// ── The models a routing prompt names, in order ─────────────────────────────────────────────────

/** One model a routing prompt names: where it first does, and the effort it names right after it. */
export interface NamedModel {
  readonly model: PackFleetModel;
  /** 1 for the first model the prompt names. */
  readonly position: number;
  /** One of the model's own efforts, written right after its name: `opus at max`, `opus @high`, `opus (low)`. */
  readonly effort?: string;
}

const EFFORT_AFTER = /^\s*(?:@\s*|\(\s*|at\s+|on\s+|,\s*)?([\p{L}]+)/iu;

/** The effort written right after a name, when it is one the model takes. */
function effortAfter(text: string, end: number, model: PackFleetModel): string | undefined {
  const word = EFFORT_AFTER.exec(text.slice(end, end + 32))?.[1]?.toLocaleLowerCase();
  return word === undefined ? undefined : model.efforts.find(effort => effort.toLocaleLowerCase() === word);
}

/**
 * Every model a routing prompt names — by id or label, as the editor highlights it — each once, in the order
 * it first appears, with the effort named after it. This order is what `fy new --auto` tries, so the
 * highlighter and the router can never disagree about which word named which model.
 */
export function namedModels(text: string, vocabulary: ModelVocabulary): readonly NamedModel[] {
  const segments = modelMentions(text, vocabulary);
  return mentionedModels(segments)
    .flatMap(segment => {
      const model = segment.model;
      if (model === undefined) return [];
      const effort = effortAfter(text, segment.end, model);
      return [{ model, effort }];
    })
    .map(({ model, effort }, index) => ({ model, position: index + 1, ...(effort === undefined ? {} : { effort }) }));
}
