/**
 * THE ENHANCER — deterministic, client-side, whole-word-only repair of a raw
 * transcript. Shared verbatim by the daemon engine and the browser engine, so
 * the two modes cannot drift into producing different text from the same audio.
 *
 * WHAT IT ACTUALLY FIXES, and why that is the whole ambition:
 *
 *   A speech model gets ordinary English right and proper nouns wrong. It has
 *   never heard of `ferretry`, `tmux`, `fyd` or `Parakeet`, so it emits the
 *   nearest thing in its vocabulary: "ferret tree", "team ux", "fide",
 *   "paraquet". Everything else in the sentence is already correct. So the
 *   enhancer's entire job is: take the tokens that are *nearly* a term this
 *   reader actually uses, and make them that term. Nothing else.
 *
 * WHAT IT WILL NEVER DO — enforced structurally here, and re-checked from
 * scratch by the independent `word-only-verifier.ts`:
 *
 *   - It never touches a separator. Punctuation, spacing and newlines come out
 *     byte-identical, because the output is rebuilt from the ORIGINAL separator
 *     array with only word slots substituted.
 *   - It never changes the token count. No insertion, no deletion, no joining
 *     two spoken words into one. Multi-word aliases are therefore refused at
 *     parse time rather than silently ignored here (see `parseDictionary`).
 *   - It never rewrites a sentence, reflows, re-punctuates or "cleans up".
 *   - It abstains on ambiguity. Two candidate terms at the same edit distance
 *     produce NO substitution: silence beats a confident wrong guess.
 *   - It abstains on case-only differences, so it cannot churn the text with
 *     changes the reader cannot see coming.
 *
 * It is pure, dependency-free and synchronous — microseconds, offline, and no
 * model of any kind.
 */

/** One term the reader cares about, plus the ways a speech model mishears it. */
export interface DictionaryEntry {
  /** Canonical spelling, emitted verbatim when a substitution fires. */
  readonly term: string;
  /**
   * Exact (case-insensitive) mishearings that map to `term`. Single words
   * only — see `parseDictionary`.
   */
  readonly aliases: readonly string[];
}

export type SubstitutionReason =
  /** An exact, case-insensitive hit on a declared alias. Highest confidence. */
  | 'dictionary-alias'
  /** A near-miss against a dictionary term. */
  | 'dictionary-fuzzy'
  /** A near-miss against a word from the reader's own free-text context. */
  | 'user-context-fuzzy'
  /** A near-miss against a word mined from the recent conversation. */
  | 'context-fuzzy';

export interface Substitution {
  /** Index into the word-token sequence, not a character offset. */
  readonly index: number;
  readonly from: string;
  readonly to: string;
  readonly reason: SubstitutionReason;
}

export interface EnhanceInput {
  readonly text: string;
  readonly dictionary: readonly DictionaryEntry[];
  /**
   * The last 5–10 user/assistant messages, oldest first. Used only to mine
   * vocabulary; never quoted, never inserted.
   */
  readonly context: readonly string[];
  /**
   * Free text the reader typed into settings — project jargon, names, a
   * pasted glossary. Mined for single-word vocabulary exactly like `context`,
   * but trusted more (the reader put it there deliberately) and less than the
   * dictionary (which names the exact spelling wanted). Never quoted, never
   * inserted.
   */
  readonly userContext?: string;
}

export interface EnhanceResult {
  /** Strictly equal to `input.text` when nothing fired. */
  readonly text: string;
  readonly substitutions: readonly Substitution[];
}

/**
 * Words shorter than this are never fuzzy-matched in either direction: at
 * three characters an edit distance of one reaches half the language.
 */
export const MIN_FUZZY_LENGTH = 4;

/**
 * A context word must be said at least this many times before it is treated as
 * this conversation's vocabulary. One mention is as likely to be a typo as a
 * term of art.
 */
export const MIN_CONTEXT_OCCURRENCES = 2;

/**
 * Hard ceiling on mined vocabulary, so a pasted log cannot turn into a
 * thousand-entry fuzzy dictionary that slows every utterance.
 */
export const MAX_CONTEXT_VOCABULARY = 400;

/**
 * Longest free-text context the extractor will read. A glossary fits with
 * room to spare; anything longer is truncated, not refused, because the first
 * 8 000 characters of a pasted document are still useful vocabulary.
 */
export const MAX_USER_CONTEXT_CHARS = 8_000;

/**
 * Ceiling on vocabulary extracted from the free-text context. Half the mined
 * cap: this field is a curated paste, not a transcript dump.
 */
export const MAX_USER_CONTEXT_VOCABULARY = 200;

/**
 * Longest transcript this will read. Dictation utterances are seconds
 * long; beyond this the input is returned untouched.
 */
export const MAX_ENHANCE_CHARS = 20_000;

/**
 * A fresh matcher per scan. kteam kept one module-level regex and reset
 * `lastIndex` at each entry point, which is correct only for as long as no
 * caller ever interleaves two scans.
 */
const wordPattern = (): RegExp => /[\p{L}\p{N}'’_-]+/gu;

/** Ordinary words that must never become vocabulary, or every "there" in the
 *  transcript becomes a near-miss for every "three" someone typed. Deliberately
 *  short and boring: the length and occurrence floors do most of the work. */
const STOPWORDS = new Set([
  'about',
  'after',
  'again',
  'against',
  'because',
  'been',
  'before',
  'being',
  'below',
  'between',
  'both',
  'came',
  'come',
  'could',
  'currently',
  'does',
  'doing',
  'done',
  'down',
  'during',
  'each',
  'even',
  'every',
  'first',
  'from',
  'further',
  'give',
  'good',
  'have',
  'having',
  'here',
  'here’s',
  'itself',
  'just',
  'know',
  'left',
  'like',
  'look',
  'made',
  'make',
  'many',
  'more',
  'most',
  'much',
  'must',
  'need',
  'next',
  'once',
  'only',
  'other',
  'over',
  'own',
  'part',
  'please',
  'right',
  'same',
  'seem',
  'should',
  'since',
  'some',
  'such',
  'sure',
  'take',
  'than',
  'that',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'thing',
  'think',
  'this',
  'those',
  'through',
  'time',
  'under',
  'until',
  'used',
  'using',
  'very',
  'want',
  'well',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'will',
  'with',
  'work',
  'would',
  'your',
  'yours',
  'okay',
  'also',
  'into',
  'them',
]);

/** Ordinary English that the FREE-TEXT context extractor must never treat as
 *  vocabulary. The mined-conversation path can stay with the short `STOPWORDS`
 *  list because its occurrence floor (a word must be said twice) filters most
 *  prose on its own; the context field has no such floor — a glossary names
 *  each term once — so the common-word screen has to carry the weight instead.
 *  Everything here is a frequent word of four letters or more; anything the
 *  reader capitalises mid-word, hyphenates or numbers bypasses this list (see
 *  `looksLikeTermOfArt`). */
const COMMON_WORDS = new Set([
  'able',
  'above',
  'across',
  'actually',
  'added',
  'almost',
  'along',
  'already',
  'always',
  'another',
  'answer',
  'anything',
  'area',
  'around',
  'asked',
  'away',
  'back',
  'based',
  'basically',
  'become',
  'begin',
  'behind',
  'best',
  'better',
  'body',
  'book',
  'both',
  'bring',
  'build',
  'call',
  'called',
  'cannot',
  'care',
  'case',
  'certain',
  'change',
  'changed',
  'check',
  'city',
  'clear',
  'close',
  'coming',
  'common',
  'company',
  'complete',
  'consider',
  'correct',
  'country',
  'course',
  'create',
  'current',
  'data',
  'days',
  'different',
  'difficult',
  'directly',
  'door',
  'early',
  'easy',
  'either',
  'else',
  'end',
  'enough',
  'entire',
  'especially',
  'example',
  'exactly',
  'expect',
  'face',
  'fact',
  'family',
  'feel',
  'field',
  'file',
  'final',
  'find',
  'fine',
  'follow',
  'following',
  'form',
  'found',
  'free',
  'full',
  'general',
  'getting',
  'given',
  'gives',
  'going',
  'gone',
  'great',
  'group',
  'hand',
  'happen',
  'happened',
  'hard',
  'head',
  'hear',
  'help',
  'high',
  'hold',
  'home',
  'hope',
  'hour',
  'hours',
  'house',
  'however',
  'idea',
  'important',
  'include',
  'including',
  'information',
  'inside',
  'instead',
  'issue',
  'item',
  'keep',
  'kind',
  'knew',
  'known',
  'large',
  'last',
  'later',
  'learn',
  'least',
  'leave',
  'less',
  'level',
  'life',
  'line',
  'list',
  'little',
  'live',
  'long',
  'longer',
  'looking',
  'lost',
  'love',
  'main',
  'makes',
  'making',
  'matter',
  'maybe',
  'mean',
  'means',
  'meet',
  'might',
  'mind',
  'minute',
  'minutes',
  'moment',
  'money',
  'month',
  'morning',
  'move',
  'name',
  'near',
  'nearly',
  'never',
  'news',
  'night',
  'nothing',
  'number',
  'often',
  'open',
  'order',
  'others',
  'otherwise',
  'outside',
  'page',
  'paper',
  'people',
  'perhaps',
  'person',
  'place',
  'plan',
  'play',
  'point',
  'possible',
  'power',
  'probably',
  'problem',
  'process',
  'program',
  'provide',
  'public',
  'question',
  'quite',
  'rather',
  'read',
  'real',
  'really',
  'reason',
  'recent',
  'recently',
  'remember',
  'rest',
  'result',
  'return',
  'room',
  'running',
  'said',
  'says',
  'school',
  'second',
  'section',
  'seem',
  'seemed',
  'seems',
  'seen',
  'send',
  'sense',
  'sent',
  'several',
  'shall',
  'short',
  'show',
  'shown',
  'side',
  'simple',
  'simply',
  'small',
  'someone',
  'something',
  'sometimes',
  'soon',
  'sort',
  'sound',
  'special',
  'stand',
  'start',
  'started',
  'state',
  'stay',
  'step',
  'still',
  'stop',
  'story',
  'system',
  'talk',
  'team',
  'tell',
  'text',
  'thank',
  'thanks',
  'thought',
  'times',
  'today',
  'together',
  'told',
  'took',
  'toward',
  'tried',
  'true',
  'turn',
  'type',
  'understand',
  'update',
  'upon',
  'value',
  'version',
  'water',
  'ways',
  'week',
  'went',
  'whatever',
  'whether',
  'white',
  'whole',
  'without',
  'word',
  'words',
  'working',
  'works',
  'world',
  'write',
  'wrong',
  'year',
  'years',
  'young',
  // Ordinary words of software prose. A speech model already spells these
  // right, so keeping them out of the vocabulary costs nothing and stops
  // near-misses ("motel" → "model") from firing on everyday sentences.
  'apps',
  'branch',
  'browser',
  'build',
  'builds',
  'button',
  'client',
  'code',
  'command',
  'commands',
  'config',
  'deploy',
  'deployed',
  'desktop',
  'device',
  'devices',
  'error',
  'errors',
  'feature',
  'features',
  'files',
  'folder',
  'function',
  'install',
  'installed',
  'laptop',
  'library',
  'login',
  'machine',
  'message',
  'messages',
  'model',
  'models',
  'network',
  'online',
  'password',
  'phone',
  'pipeline',
  'project',
  'projects',
  'release',
  'repo',
  'request',
  'screen',
  'script',
  'scripts',
  'server',
  'servers',
  'service',
  'services',
  'session',
  'sessions',
  'settings',
  'setup',
  'software',
  'speech',
  'storage',
  'terminal',
  'test',
  'tests',
  'tool',
  'tools',
  'user',
  'users',
  'website',
  'window',
  'windows',
]);

/**
 * A single-mention word earns vocabulary status only if it looks deliberate:
 * inner capitals (`kTeam`, `GPU`, `OAuth`), a digit (`sha256`, `GPT4`), or
 * inner `-`/`_` (`sherpa-onnx`, `tool_use`). A leading capital alone is NOT a
 * signal — every sentence starts with one.
 */
export const looksLikeTermOfArt = (token: string): boolean =>
  /\p{Lu}/u.test(token.slice(1)) || /\p{N}/u.test(token) || /[_-]/u.test(token);

/**
 * Turn the reader's free-text context — prose, a glossary, a list of names —
 * into fuzzy-match vocabulary.
 *
 * Unlike `contextVocabulary` there is no occurrence floor: the reader wrote
 * this field on purpose and a glossary says each term once. The screen against
 * "correcting" ordinary English is therefore stricter — a plain lowercase word
 * must clear BOTH the stoplist and `COMMON_WORDS`, while a token with a
 * term-of-art shape (inner caps, digits, hyphens, underscores) is kept on
 * sight. First appearance wins the display form, and the cap keeps the
 * earliest entries, so the front of the field is the part that always counts.
 */
export const userContextVocabulary = (text: string | undefined): readonly string[] => {
  if (text === undefined || text.length === 0) return [];
  const clipped = text.slice(0, MAX_USER_CONTEXT_CHARS);
  const seen = new Map<string, string>();
  const pattern = wordPattern();
  for (let match = pattern.exec(clipped); match !== null; match = pattern.exec(clipped)) {
    const raw = match[0];
    if (raw.length < MIN_FUZZY_LENGTH) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    if (STOPWORDS.has(key)) continue;
    if (!looksLikeTermOfArt(raw) && COMMON_WORDS.has(key)) continue;
    seen.set(key, raw);
    if (seen.size >= MAX_USER_CONTEXT_VOCABULARY) break;
  }
  return [...seen.values()];
};

interface Segmented {
  readonly words: readonly string[];
  /** `separators.length === words.length + 1`. */
  readonly separators: readonly string[];
}

const segment = (text: string): Segmented => {
  const words: string[] = [];
  const separators: string[] = [];
  const pattern = wordPattern();
  let last = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    separators.push(text.slice(last, match.index));
    words.push(match[0]);
    last = match.index + match[0].length;
  }
  separators.push(text.slice(last));
  return { words, separators };
};

/**
 * Damerau-Levenshtein with a hard ceiling.
 *
 * Bounded on purpose: the caller only ever asks "is this within 1 or 2?", and
 * an unbounded distance over a 400-word vocabulary is wasted work. Returns
 * `max + 1` for anything further away, which every caller treats as "no".
 */
export const boundedDamerauLevenshtein = (a: string, b: string, max: number): number => {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i += 1) {
    const row = new Array<number>(b.length + 1).fill(0);
    row[0] = i;
    rows.push(row);
  }
  const first = rows[0] as number[];
  for (let j = 0; j <= b.length; j += 1) first[j] = j;

  for (let i = 1; i <= a.length; i += 1) {
    const row = rows[i] as number[];
    const prev = rows[i - 1] as number[];
    let best = Number.POSITIVE_INFINITY;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min((prev[j] as number) + 1, (row[j - 1] as number) + 1, (prev[j - 1] as number) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, (rows[i - 2]?.[j - 2] as number) + 1);
      }
      row[j] = value;
      if (value < best) best = value;
    }
    // Whole row already past the ceiling: no completion can come back under it.
    if (best > max) return max + 1;
  }
  return rows[a.length]?.[b.length] ?? max + 1;
};

/**
 * Edit budget for a token of this length. Short words get one edit, longer
 * ones two — the same shape a spell-checker uses, and the reason `kteam` can
 * be recovered from `k team`'s halves but `cat` can never become `bat`.
 */
export const fuzzyBudget = (length: number): number => (length <= 6 ? 1 : 2);

/**
 * Mine this conversation's vocabulary out of recent messages.
 *
 * Deliberately crude — frequency, length and a stoplist. It is a *candidate*
 * list for fuzzy matching, never a source of inserted text, so a false
 * positive costs at worst one abstention.
 */
export const contextVocabulary = (messages: readonly string[]): readonly string[] => {
  const counts = new Map<string, { display: string; count: number }>();
  for (const message of messages) {
    const pattern = wordPattern();
    for (let match = pattern.exec(message); match !== null; match = pattern.exec(message)) {
      const raw = match[0];
      if (raw.length < MIN_FUZZY_LENGTH) continue;
      const key = raw.toLowerCase();
      if (STOPWORDS.has(key)) continue;
      const seen = counts.get(key);
      if (seen) seen.count += 1;
      else counts.set(key, { display: raw, count: 1 });
    }
  }
  return [...counts.values()]
    .filter(entry => entry.count >= MIN_CONTEXT_OCCURRENCES)
    .sort((a, b) => b.count - a.count || a.display.localeCompare(b.display))
    .slice(0, MAX_CONTEXT_VOCABULARY)
    .map(entry => entry.display);
};

interface Candidate {
  readonly to: string;
  readonly reason: SubstitutionReason;
}

/**
 * Nearest candidate within budget, or `null` on a miss OR a tie.
 *
 * The tie rule is the important half: two terms at the same distance means the
 * enhancer genuinely does not know, and a coin flip in a reader's own words is
 * worse than leaving the model's guess alone.
 */
export const nearestCandidate = (token: string, candidates: readonly string[], budget: number): string | null => {
  const lower = token.toLowerCase();
  let best: string | null = null;
  let bestDistance = budget + 1;
  let tied = false;
  for (const candidate of candidates) {
    if (candidate.length < MIN_FUZZY_LENGTH) continue;
    const distance = boundedDamerauLevenshtein(lower, candidate.toLowerCase(), budget);
    if (distance > budget) continue;
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
      tied = false;
    } else if (distance === bestDistance && best !== null && best.toLowerCase() !== candidate.toLowerCase()) {
      tied = true;
    }
  }
  return tied ? null : best;
};

/**
 * Non-alphanumeric characters inside a token, in order.
 *
 * Implemented here rather than imported from the verifier ON PURPOSE: the two
 * modules must agree by test, not by construction, so a bug in one is caught
 * by the other rather than shared with it.
 */
const innerPunctuation = (word: string): string =>
  [...word].filter(character => !/[\p{L}\p{N}]/u.test(character)).join('');

/**
 * Apply the source token's capitalisation when the canonical form carries none
 * of its own.
 *
 * `Kteem` at the start of a sentence should become `Kteam`, not `kteam` — the
 * reader capitalised it, and dropping that would be an unrequested edit in the
 * other direction. A canonical form that declares its own casing (`Parakeet`,
 * `GPU`) is emitted verbatim.
 */
export const applyTokenCase = (token: string, canonical: string): string => {
  const isTitle = /^\p{Lu}[^\p{Lu}]*$/u.test(token);
  const canonicalHasCase = /\p{Lu}/u.test(canonical);
  if (!isTitle || canonicalHasCase) return canonical;
  return canonical.charAt(0).toUpperCase() + canonical.slice(1);
};

/** The dictionary, indexed for lookup: aliases by lowercase key, plus terms. */
interface DictionaryIndex {
  readonly aliases: ReadonlyMap<string, string>;
  readonly terms: readonly string[];
  readonly termKeys: ReadonlySet<string>;
}

const indexDictionary = (dictionary: readonly DictionaryEntry[]): DictionaryIndex => {
  const aliases = new Map<string, string>();
  const terms: string[] = [];
  const termKeys = new Set<string>();
  for (const entry of dictionary) {
    if (entry.term.length === 0) continue;
    terms.push(entry.term);
    termKeys.add(entry.term.toLowerCase());
    for (const alias of entry.aliases) {
      if (alias.length === 0) continue;
      // First declaration wins, so a duplicated alias is deterministic rather
      // than order-of-iteration dependent.
      if (!aliases.has(alias.toLowerCase())) aliases.set(alias.toLowerCase(), entry.term);
    }
  }
  return { aliases, terms, termKeys };
};

/** The tiers, most deliberate first, for one token. */
const candidateFor = (
  token: string,
  index: DictionaryIndex,
  userVocabulary: readonly string[],
  vocabulary: readonly string[],
): Candidate | null => {
  const lower = token.toLowerCase();
  const alias = index.aliases.get(lower);
  if (alias !== undefined) return { to: alias, reason: 'dictionary-alias' };
  // A token that IS already a dictionary term is finished; fuzzing it can
  // only move it away from what the reader declared.
  if (index.termKeys.has(lower)) return null;
  if (token.length < MIN_FUZZY_LENGTH) return null;
  const budget = fuzzyBudget(token.length);
  const term = nearestCandidate(token, index.terms, budget);
  if (term !== null) return { to: term, reason: 'dictionary-fuzzy' };
  const userWord = nearestCandidate(token, userVocabulary, budget);
  if (userWord !== null) return { to: userWord, reason: 'user-context-fuzzy' };
  const word = nearestCandidate(token, vocabulary, budget);
  if (word !== null) return { to: word, reason: 'context-fuzzy' };
  return null;
};

export const enhance = (input: EnhanceInput): EnhanceResult => {
  const { text } = input;
  if (text.length === 0 || text.length > MAX_ENHANCE_CHARS) return { text, substitutions: [] };

  const index = indexDictionary(input.dictionary);

  // Precedence, most deliberate first: the dictionary names exact spellings,
  // the free-text context was typed into settings on purpose, and the mined
  // conversation words are only inferred. Each lower tier is filtered against
  // every tier above it, so one term never competes with itself — a tie
  // between tiers would otherwise force an abstention on a word the reader
  // explicitly declared.
  const userVocabulary = userContextVocabulary(input.userContext).filter(
    word => !index.termKeys.has(word.toLowerCase()),
  );
  const userKeys = new Set(userVocabulary.map(word => word.toLowerCase()));
  const vocabulary = contextVocabulary(input.context).filter(
    word => !index.termKeys.has(word.toLowerCase()) && !userKeys.has(word.toLowerCase()),
  );

  const { words, separators } = segment(text);
  const substitutions: Substitution[] = [];
  const output = [...words];

  for (let i = 0; i < words.length; i += 1) {
    const token = words[i] as string;
    const candidate = candidateFor(token, index, userVocabulary, vocabulary);
    if (candidate === null) continue;
    const replacement = applyTokenCase(token, candidate.to);
    // Case-only churn is refused here as well as in the verifier: the enhancer
    // should not be producing candidates the verifier will throw the whole
    // result away for.
    if (replacement.toLowerCase() === token.toLowerCase()) continue;
    // Nor should it propose a punctuation edit smuggled inside a token —
    // `dont → don't`, `don't → don’t`, `sherpa-onnx → sherpaonnx`. The verifier
    // refuses those outright and would discard every other substitution in the
    // same pass, so they are dropped individually here instead.
    if (innerPunctuation(token) !== innerPunctuation(replacement)) continue;
    output[i] = replacement;
    substitutions.push({ index: i, from: token, to: replacement, reason: candidate.reason });
  }

  if (substitutions.length === 0) return { text, substitutions: [] };

  // Rebuilt from the ORIGINAL separators. This is the structural reason the
  // output can differ from the input in word slots and nowhere else.
  let rebuilt = separators[0] ?? '';
  for (let i = 0; i < output.length; i += 1) {
    rebuilt += output[i];
    rebuilt += separators[i + 1] ?? '';
  }
  return { text: rebuilt, substitutions };
};

/**
 * Parse the reader's dictionary textarea.
 *
 * Line format — `canonical = alias, alias, …`, aliases optional:
 *
 *     kteam = k team, kay team        ← REJECTED alias "k team" (see below)
 *     kteam = kteem, katim
 *     Parakeet
 *     sherpa-onnx = sherpa onyx       ← "sherpa onyx" rejected, term kept
 *
 * MULTI-WORD ALIASES ARE REFUSED, not silently dropped. Turning "k team" into
 * "kteam" removes a word token, which is precisely the class of edit the
 * verifier exists to forbid; supporting it would mean carving an exception
 * into the one rule that makes enhancement safe. The reader is told, rather
 * than left wondering why their alias never fires.
 */
export interface DictionaryParse {
  readonly entries: readonly DictionaryEntry[];
  /** Human-readable problems, in line order. Rendered under the textarea. */
  readonly problems: readonly string[];
}

/** Caps. A dictionary is a list of the words this reader says, not a corpus. */
export const MAX_DICTIONARY_TERMS = 200;
export const MAX_TERM_LENGTH = 64;
export const MAX_ALIASES_PER_TERM = 12;

interface DraftEntry {
  term: string;
  aliases: string[];
}

export const parseDictionary = (lines: readonly string[]): DictionaryParse => {
  const entries: DraftEntry[] = [];
  const problems: string[] = [];
  const byTerm = new Map<string, DraftEntry>();

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    if (entries.length >= MAX_DICTIONARY_TERMS) {
      problems.push(`Only the first ${MAX_DICTIONARY_TERMS} terms are used; “${line}” was ignored.`);
      continue;
    }
    const eq = line.indexOf('=');
    const termRaw = (eq === -1 ? line : line.slice(0, eq)).trim();
    const aliasRaw = eq === -1 ? '' : line.slice(eq + 1);
    if (termRaw.length === 0) {
      problems.push(`“${line}” has no term before the “=”.`);
      continue;
    }
    if (termRaw.length > MAX_TERM_LENGTH) {
      problems.push(`“${termRaw.slice(0, 24)}…” is longer than ${MAX_TERM_LENGTH} characters.`);
      continue;
    }
    if (/\s/u.test(termRaw)) {
      problems.push(`“${termRaw}” contains a space. Dictation only ever swaps single words.`);
      continue;
    }

    const existing = byTerm.get(termRaw.toLowerCase());
    const entry: DraftEntry = existing ?? { term: termRaw, aliases: [] };
    if (existing === undefined) {
      byTerm.set(termRaw.toLowerCase(), entry);
      entries.push(entry);
    }

    for (const piece of aliasRaw.split(',')) {
      const alias = piece.trim();
      if (alias.length === 0) continue;
      if (/\s/u.test(alias)) {
        problems.push(`“${alias}” spans two words, so it cannot be used — dictation only swaps single words.`);
        continue;
      }
      if (alias.length > MAX_TERM_LENGTH) {
        problems.push(`“${alias.slice(0, 24)}…” is longer than ${MAX_TERM_LENGTH} characters.`);
        continue;
      }
      if (entry.aliases.length >= MAX_ALIASES_PER_TERM) {
        problems.push(`“${entry.term}” already has ${MAX_ALIASES_PER_TERM} alternatives; “${alias}” was ignored.`);
        continue;
      }
      if (!entry.aliases.some(known => known.toLowerCase() === alias.toLowerCase())) entry.aliases.push(alias);
    }
  }

  return { entries, problems };
};
