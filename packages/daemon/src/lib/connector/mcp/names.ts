/**
 * Matching a spoken or typed name to the thing it names — pure, and the one place the connector decides
 * "which ferret did they mean".
 *
 * WHY THIS IS NOT JUST `===`. Every name a tool receives has been through speech recognition: "lizzette"
 * arrives as "lizet", "Build MCP Connector" as "build m c p connector". So a name is first NORMALISED
 * (case, spaces, hyphens, a leading `:`, doubled letters and a few spelling-alike letter groups are all
 * ignored) and then matched in tiers:
 *
 *   1. EXACT   — the normalised names are equal. May act.
 *   2. PREFIX / SUBSTRING — the query is the start of, or inside, a name (3+ characters). May act, but only
 *      when exactly ONE thing matches at that tier; two matches are a question, never a guess.
 *   3. CLOSE   — a small edit distance away ("lizet" → "lizzette"). NEVER acts: it is offered back as
 *      "Did you mean …?", because the next sentence might be "stop it" and a misheard name must not stop
 *      the wrong ferret.
 *
 * Callsign: in Ferretry v4 every session has a first name, its CALLSIGN (`config.teammate`, e.g. `lizzette`).
 * People say that name; the task title (`config.name`) is the second thing they say.
 */

/** What one candidate answers to. `exact` keys are identifiers (never fuzzily matched); `names` are words. */
export interface NameKeys {
  readonly exact: readonly string[];
  readonly names: readonly string[];
}

export type NameMatch<T> =
  | { readonly kind: 'one'; readonly item: T }
  | { readonly kind: 'many'; readonly items: readonly T[] }
  | { readonly kind: 'none'; readonly suggestions: readonly T[] };

/** Lower-case, drop a leading `:`, fold spelling-alikes, drop everything that is not a letter or digit, collapse doubles. */
export function normalizeName(value: string): string {
  const folded = value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/^[:\s]+/u, '')
    .replace(/ph/gu, 'f')
    .replace(/ck/gu, 'k')
    .replace(/y/gu, 'i')
    .replace(/[^\p{L}\p{N}]/gu, '');
  return folded.replace(/(.)\1+/gu, '$1');
}

/** Optimal-string-alignment (Damerau–Levenshtein with adjacent transpositions) distance. */
export function editDistance(left: string, right: string): number {
  if (left === right) return 0;
  const rows = left.length + 1;
  const columns = right.length + 1;
  const table: number[][] = Array.from({ length: rows }, (_, row) => {
    const line = new Array<number>(columns).fill(0);
    line[0] = row;
    return line;
  });
  for (let column = 0; column < columns; column += 1) (table[0] as number[])[column] = column;
  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      const above = (table[row - 1] as number[])[column] as number;
      const beside = (table[row] as number[])[column - 1] as number;
      const diagonal = (table[row - 1] as number[])[column - 1] as number;
      let best = Math.min(above + 1, beside + 1, diagonal + cost);
      if (row > 1 && column > 1 && left[row - 1] === right[column - 2] && left[row - 2] === right[column - 1]) {
        best = Math.min(best, ((table[row - 2] as number[])[column - 2] as number) + 1);
      }
      (table[row] as number[])[column] = best;
    }
  }
  return (table[rows - 1] as number[])[columns - 1] as number;
}

const MIN_PARTIAL = 3;

/** How close the query is to one normalised name: 0 exact, 1 prefix, 2 substring, else the distance + 2, or undefined when far. */
function nameScore(query: string, name: string): number | undefined {
  if (name === '') return undefined;
  if (name === query) return 0;
  if (query.length >= MIN_PARTIAL && name.startsWith(query)) return 1;
  if (query.length >= MIN_PARTIAL && name.includes(query)) return 2;
  // A query longer than the name that CONTAINS it ("lizzette build" for "lizzette") is a close miss, not a hit.
  if (name.length >= MIN_PARTIAL && query.length > name.length && query.startsWith(name)) return 3;
  const allowed = Math.max(1, Math.floor(Math.min(query.length, name.length) / 3));
  const distance = editDistance(query, name);
  if (distance <= allowed) return 3 + distance;
  // A misheard first name inside a long title: compare against each word, and each word-prefix of the query.
  return undefined;
}

/** Task titles read `[Lizzette] Build MCP Connector`: also answer to the title without its bracket tag. */
export function titleVariants(title: string): readonly string[] {
  const stripped = title.replace(/^\s*\[[^\]]*\]\s*/u, '');
  return stripped === title ? [title] : [title, stripped];
}

/**
 * Resolve `query` among `items`. `keysOf` says what each item answers to.
 *
 * `exact` keys match only by normalised equality (an id, a short id). `names` keys go through the tiers above.
 * `suggestions` is at most three items, best first, and only ever present for `none`.
 */
export function matchName<T>(query: string, items: readonly T[], keysOf: (item: T) => NameKeys): NameMatch<T> {
  const wanted = normalizeName(query);
  if (wanted === '') return { kind: 'none', suggestions: [] };
  const scored: { item: T; score: number; order: number }[] = [];
  items.forEach((item, order) => {
    const keys = keysOf(item);
    let best: number | undefined;
    for (const key of keys.exact) {
      if (normalizeName(key) === wanted) best = 0;
    }
    for (const key of keys.names) {
      const score = nameScore(wanted, normalizeName(key));
      if (score !== undefined && (best === undefined || score < best)) best = score;
    }
    if (best !== undefined) scored.push({ item, score: best, order });
  });
  scored.sort((a, b) => a.score - b.score || a.order - b.order);
  for (const tier of [0, 1, 2]) {
    const hits = scored.filter(entry => entry.score === tier);
    if (hits.length === 1) return { kind: 'one', item: (hits[0] as { item: T }).item };
    if (hits.length > 1) return { kind: 'many', items: hits.map(entry => entry.item) };
  }
  return { kind: 'none', suggestions: scored.slice(0, 3).map(entry => entry.item) };
}

/**
 * Everything whose identity IS the query: an `exact` key (id, short id) or a name that normalises to the same
 * words — no prefix, no substring, no edit distance. A caller that must not act on a near miss (stop, restart,
 * send) asks this first, over EVERY candidate whatever its state, so a retried call finds the same thing again.
 */
export function matchExact<T>(query: string, items: readonly T[], keysOf: (item: T) => NameKeys): readonly T[] {
  const wanted = normalizeName(query);
  if (wanted === '') return [];
  return items.filter(item => {
    const keys = keysOf(item);
    return [...keys.exact, ...keys.names].some(key => normalizeName(key) === wanted);
  });
}
