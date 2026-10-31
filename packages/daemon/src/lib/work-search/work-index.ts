/**
 * THE WORK SEARCH INDEX: an inverted index over {@link WorkDocument}s, in memory, updated one document at
 * a time (docs/work-search.md § Ranking).
 *
 * It is a projection and nothing else. It holds no truth of its own — the card files and the agenda
 * ledgers do — and it is rebuilt from them at every boot; {@link WorkSearchService} decides when a
 * document is stale. Every operation is synchronous, so a search never sees half an update.
 *
 * RANKING, in one place so every client agrees:
 * 1. An exact id (`F303`, `&F303`, `#F303`, `A3`, `!A3`) beats any text.
 * 2. Every word must match somewhere (the last as a prefix, so a half-typed word already finds); a word
 *    counts by the best field it is in — title ≫ summary and ask ≫ premise and context ≫ the rest — and the
 *    whole query read as one phrase in the title adds more.
 * 3. Open work, then recent work, is lifted: a match on last week's card beats the same match on one
 *    closed a month ago.
 */
import type { WorkField, WorkHit, WorkRelatedStrength, WorkSearchQuery } from '@ferretry/protocol';
import { WORK_SEARCH_CLOSED_WINDOW_DAYS } from '@ferretry/protocol';
import type { WorkDocument } from './documents.ts';
import { matchLine, meaningfulTokens, normalizePhrase, tokensOf } from './text.ts';

const DAY_MS = 86_400_000;
const CLOSED_WINDOW_MS = WORK_SEARCH_CLOSED_WINDOW_DAYS * DAY_MS;

/** How much a word counts in each field. */
const FIELD_WEIGHT: Readonly<Record<WorkField, number>> = {
  id: 20,
  title: 10,
  summary: 6,
  ask: 5,
  premise: 3,
  context: 3,
  brief: 2,
  howToTest: 2,
  body: 2,
  note: 1.5,
  history: 1.5,
  resolution: 1.5,
};
/** Fields in the order a match line is looked for. */
const MATCH_ORDER: readonly WorkField[] = (Object.keys(FIELD_WEIGHT) as WorkField[]).filter(field => field !== 'id');
/** The fields a related check weighs: what a piece of work is ABOUT, not every word said near it. */
const CORE_FIELDS: ReadonlySet<WorkField> = new Set(['title', 'summary', 'ask']);

const ID_SCORE = 1_000;
const PHRASE_BONUS = 15;
/** A word matched only as a prefix counts for this much of a whole-word match. */
const PREFIX_FACTOR = 0.8;
const OPEN_BOOST = 1.25;
const RECENCY_HALF_LIFE_DAYS = 14;
const RECENCY_BOOST = 0.5;

/** Where a related check draws its lines (see {@link WorkIndex.related}); tuned on a real board of ~500 cards. */
const RELATED_STRONG_TITLE = 0.6;
const RELATED_STRONG_BODY = 0.45;
const RELATED_STRONG_BODY_TITLE = 0.25;
const RELATED_WEAK_TITLE = 0.3;
const RELATED_WEAK_BODY = 0.25;

const TASK_ID = /^[bfic][1-9][0-9]{0,8}$/iu;
const AGENDA_ID = /^a[1-9][0-9]{0,8}$/iu;
const SIGILS = /^[&!#@]+/u;

/** What one document contributes, kept so it can be taken back out exactly. */
interface Indexed {
  readonly document: WorkDocument;
  /** token → the best weight it has in this document. */
  readonly weights: ReadonlyMap<string, number>;
  /** The meaningful tokens of title, summary and ask. */
  readonly core: ReadonlySet<string>;
  readonly title: ReadonlySet<string>;
  readonly phrase: string;
}

export interface WorkSearchResult {
  readonly hits: readonly WorkHit[];
  readonly total: number;
}

export interface WorkRelatedMatch {
  readonly strength: WorkRelatedStrength;
  readonly hit: WorkHit;
}

export class WorkIndex {
  private readonly documents = new Map<string, Indexed>();
  private readonly postings = new Map<string, Map<string, number>>();
  /** How many documents hold each core token, for how much a shared word says. */
  private readonly coreFrequency = new Map<string, number>();
  private readonly byId = new Map<string, Set<string>>();
  /**
   * Every token, sorted, for prefix lookups. A new token waits in {@link added} and is merged in by the next
   * lookup (linear, not a re-sort); a removed one stays as a harmless stale entry with no posting until
   * stale entries are half the list, when the next lookup rebuilds it.
   */
  private vocabulary: readonly string[] = [];
  private added: string[] = [];
  private stale = 0;

  get size(): { readonly tasks: number; readonly agenda: number } {
    let tasks = 0;
    for (const { document } of this.documents.values()) if (document.kind === 'task') tasks += 1;
    return { tasks, agenda: this.documents.size - tasks };
  }

  keys(): IterableIterator<string> {
    return this.documents.keys();
  }

  /** Adds or replaces a document. */
  put(document: WorkDocument): void {
    this.remove(document.key);
    const weights = new Map<string, number>();
    const core = new Set<string>();
    for (const field of document.fields) {
      const weight = FIELD_WEIGHT[field.field];
      for (const token of tokensOf(field.text)) if ((weights.get(token) ?? 0) < weight) weights.set(token, weight);
      if (CORE_FIELDS.has(field.field)) for (const token of meaningfulTokens(field.text)) core.add(token);
    }
    const title = document.fields.find(field => field.field === 'title')?.text ?? '';
    const indexed: Indexed = {
      document,
      weights,
      core,
      title: new Set(meaningfulTokens(title)),
      phrase: normalizePhrase(title),
    };
    this.documents.set(document.key, indexed);
    for (const [token, weight] of weights) {
      let posting = this.postings.get(token);
      if (posting === undefined) {
        posting = new Map();
        this.postings.set(token, posting);
        this.added.push(token);
      }
      posting.set(document.key, weight);
    }
    for (const token of core) this.coreFrequency.set(token, (this.coreFrequency.get(token) ?? 0) + 1);
    const id = document.identity.id.toUpperCase();
    let keys = this.byId.get(id);
    if (keys === undefined) {
      keys = new Set();
      this.byId.set(id, keys);
    }
    keys.add(document.key);
  }

  remove(key: string): void {
    const indexed = this.documents.get(key);
    if (indexed === undefined) return;
    this.documents.delete(key);
    for (const token of indexed.weights.keys()) {
      const posting = this.postings.get(token);
      posting?.delete(key);
      if (posting?.size === 0) {
        this.postings.delete(token);
        this.stale += 1;
      }
    }
    for (const token of indexed.core) {
      const count = (this.coreFrequency.get(token) ?? 1) - 1;
      if (count <= 0) this.coreFrequency.delete(token);
      else this.coreFrequency.set(token, count);
    }
    const id = indexed.document.identity.id.toUpperCase();
    this.byId.get(id)?.delete(key);
    if (this.byId.get(id)?.size === 0) this.byId.delete(id);
  }

  search(query: WorkSearchQuery, nowMs: number): WorkSearchResult {
    const text = query.q.trim();
    const bare = text.replace(SIGILS, '');
    const tokens = tokensOf(text);
    const scores = new Map<string, number>();
    if (TASK_ID.test(bare) || AGENDA_ID.test(bare))
      for (const key of this.byId.get(bare.toUpperCase()) ?? []) scores.set(key, ID_SCORE);
    if (tokens.length > 0)
      for (const [key, score] of this.textScores(tokens, normalizePhrase(text))) {
        scores.set(key, (scores.get(key) ?? 0) + score);
      }
    const ranked = [...scores]
      .map(([key, score]) => ({ indexed: this.documents.get(key), score }))
      .filter((entry): entry is { indexed: Indexed; score: number } => entry.indexed !== undefined)
      .filter(({ indexed }) => passes(query, indexed.document, nowMs))
      .map(({ indexed, score }) => ({ indexed, score: boosted(score, indexed.document, nowMs) }))
      .sort(
        (left, right) =>
          right.score - left.score || right.indexed.document.updatedAtMs - left.indexed.document.updatedAtMs,
      );
    return {
      total: ranked.length,
      hits: ranked
        .slice(0, query.limit)
        .map(({ indexed, score }) => hitOf(indexed.document, score, tokens, scores.get(indexed.document.key) ?? 0)),
    };
  }

  /**
   * The open (and recently closed) work a new title and ask are near, by two similarities weighted by how
   * rare each shared word is: TITLE to title (weighted Jaccard — the share of both titles' words they have
   * in common), and the new title and ask to what the document is about (cosine over title, summary and
   * ask). `strong` — near enough that filing it is probably a duplicate — needs a close title, or a close
   * body with some title in common; a long ask that merely mentions a short title's words is `weak`.
   * Closed work is at most `weak`: a near copy of finished work is more often a follow-up than a mistake.
   */
  related(title: string, ask: string, nowMs: number, limit: number): readonly WorkRelatedMatch[] {
    const newTitle = meaningfulTokens(title);
    const asked = meaningfulTokens(`${title}\n${ask}`);
    if (asked.length === 0) return [];
    const phrase = normalizePhrase(title);
    const total = this.documents.size;
    const idf = (token: string): number => Math.log(1 + total / Math.max(1, this.coreFrequency.get(token) ?? 0));
    const squared = (tokens: Iterable<string>): number => {
      let sum = 0;
      for (const token of tokens) sum += idf(token) ** 2;
      return sum;
    };
    const askedNorm = Math.sqrt(squared(asked));
    const candidates = new Set<string>();
    for (const token of asked) for (const key of this.postings.get(token)?.keys() ?? []) candidates.add(key);
    const matches: { strength: WorkRelatedStrength; closeness: number; indexed: Indexed }[] = [];
    for (const key of candidates) {
      const indexed = this.documents.get(key);
      if (indexed === undefined || !withinWindow(indexed.document, nowMs)) continue;
      const shared = asked.filter(token => indexed.core.has(token));
      if (shared.length === 0) continue;
      const bodySimilarity = squared(shared) / (askedNorm * Math.sqrt(squared(indexed.core)) || 1);
      const titleSimilarity = weightedJaccard(newTitle, indexed.title, idf);
      const samePhrase = phrase.length > 0 && phrase === indexed.phrase;
      const open = indexed.document.identity.state === 'open';
      const strong =
        open &&
        (samePhrase ||
          (titleSimilarity >= RELATED_STRONG_TITLE && new Set([...newTitle, ...indexed.title]).size >= 2) ||
          (bodySimilarity >= RELATED_STRONG_BODY && titleSimilarity >= RELATED_STRONG_BODY_TITLE));
      const weak = samePhrase || titleSimilarity >= RELATED_WEAK_TITLE || bodySimilarity >= RELATED_WEAK_BODY;
      if (!strong && !weak) continue;
      matches.push({
        strength: strong ? 'strong' : 'weak',
        closeness: Math.max(titleSimilarity, bodySimilarity),
        indexed,
      });
    }
    return matches
      .sort(
        (left, right) =>
          rank(right.strength) - rank(left.strength) ||
          right.closeness - left.closeness ||
          right.indexed.document.updatedAtMs - left.indexed.document.updatedAtMs,
      )
      .slice(0, limit)
      .map(({ strength, closeness, indexed }) => ({
        strength,
        hit: hitOf(indexed.document, Math.round(closeness * 100), asked, 0),
      }));
  }

  /** Every document matching every token, with its text score. */
  private textScores(tokens: readonly string[], phrase: string): Map<string, number> {
    const perToken = tokens.map((token, index) => this.matching(token, index === tokens.length - 1));
    perToken.sort((left, right) => left.size - right.size);
    const [first, ...rest] = perToken;
    const scores = new Map<string, number>();
    if (first === undefined) return scores;
    for (const [key, weight] of first) {
      let score = weight;
      let everywhere = true;
      for (const other of rest) {
        const next = other.get(key);
        if (next === undefined) {
          everywhere = false;
          break;
        }
        score += next;
      }
      if (!everywhere) continue;
      if (tokens.length > 1 && this.documents.get(key)?.phrase.includes(phrase) === true) score += PHRASE_BONUS;
      scores.set(key, score);
    }
    return scores;
  }

  /** Documents holding a token (or, for the last word, a token it begins), with its weight in each. */
  private matching(token: string, prefix: boolean): ReadonlyMap<string, number> {
    const exact = this.postings.get(token);
    if (!prefix || token.length < 2) return exact ?? new Map();
    const found = new Map<string, number>(exact ?? []);
    const vocabulary = this.sortedVocabulary();
    for (let at = lowerBound(vocabulary, token); at < vocabulary.length; at += 1) {
      const candidate = vocabulary[at] ?? '';
      if (!candidate.startsWith(token)) break;
      if (candidate === token) continue;
      for (const [key, weight] of this.postings.get(candidate) ?? []) {
        const partial = weight * PREFIX_FACTOR;
        if ((found.get(key) ?? 0) < partial) found.set(key, partial);
      }
    }
    return found;
  }

  private sortedVocabulary(): readonly string[] {
    if (this.stale * 2 > this.vocabulary.length + this.added.length) {
      this.vocabulary = [...this.postings.keys()].sort();
      this.added = [];
      this.stale = 0;
    } else if (this.added.length > 0) {
      this.vocabulary = mergeSorted(this.vocabulary, [...new Set(this.added)].sort());
      this.added = [];
    }
    return this.vocabulary;
  }
}

const rank = (strength: WorkRelatedStrength): number => (strength === 'strong' ? 1 : 0);

/** Two sorted lists as one, a word in both kept once. */
const mergeSorted = (left: readonly string[], right: readonly string[]): readonly string[] => {
  const merged: string[] = [];
  let at = 0;
  let other = 0;
  while (at < left.length || other < right.length) {
    const next =
      other >= right.length || (at < left.length && (left[at] ?? '') <= (right[other] ?? ''))
        ? left[at++]
        : right[other++];
    if (next !== undefined && merged[merged.length - 1] !== next) merged.push(next);
  }
  return merged;
};

const lowerBound = (sorted: readonly string[], value: string): number => {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((sorted[middle] ?? '') < value) low = middle + 1;
    else high = middle;
  }
  return low;
};

// Closed work ages out between sweeps too, not only when its document is next rebuilt.
const withinWindow = (document: WorkDocument, nowMs: number): boolean =>
  document.identity.state === 'open' || nowMs - document.updatedAtMs <= CLOSED_WINDOW_MS;

const passes = (query: WorkSearchQuery, document: WorkDocument, nowMs: number): boolean => {
  if (!withinWindow(document, nowMs)) return false;
  if (query.kind !== undefined && document.kind !== query.kind) return false;
  if (query.open && document.identity.state !== 'open') return false;
  if (query.project !== undefined && document.identity.kind === 'task' && document.identity.projectId !== query.project)
    return false;
  return true;
};

const boosted = (score: number, document: WorkDocument, nowMs: number): number => {
  const ageDays = Math.max(0, nowMs - document.updatedAtMs) / DAY_MS;
  const recency = 1 + RECENCY_BOOST * 0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS);
  return score * recency * (document.identity.state === 'open' ? OPEN_BOOST : 1);
};

/** The answer row: who it is, and the one line that shows why it matched. */
const hitOf = (document: WorkDocument, score: number, tokens: readonly string[], raw: number): WorkHit => {
  const match =
    raw >= ID_SCORE && tokens.length <= 1
      ? { field: 'id' as const, line: document.identity.title }
      : matchOf(document, tokens);
  return { ...document.identity, match, score: Math.round(score * 100) / 100 } as WorkHit;
};

const matchOf = (document: WorkDocument, tokens: readonly string[]): WorkHit['match'] => {
  for (const field of MATCH_ORDER) {
    const found = document.fields.find(candidate => candidate.field === field);
    const line = found === undefined ? undefined : matchLine(found.text, tokens);
    if (line !== undefined) return { field, line };
  }
  return { field: 'title', line: document.identity.title };
};

/** The weight two token sets share over the weight of both together. */
const weightedJaccard = (
  left: readonly string[],
  right: ReadonlySet<string>,
  idf: (token: string) => number,
): number => {
  const union = new Set([...left, ...right]);
  if (union.size === 0) return 0;
  let shared = 0;
  let all = 0;
  for (const token of union) {
    const weight = idf(token);
    all += weight;
    if (right.has(token) && left.includes(token)) shared += weight;
  }
  return all === 0 ? 0 : shared / all;
};
