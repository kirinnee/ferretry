/**
 * NO UMBRELLA CARDS (docs/board.md § One card, one outcome): a card shows the progress of ONE outcome, and its asks
 * ride its agenda. A card that gathers many outcomes ("Agenda overhaul", "Misc fixes") shows no progress anybody can
 * read and hides the asks of each part, so `fy card new` refuses one unless `--broad "<why this must be one card>"`
 * says why it must be one. A card under a `--parent` is a part of a bigger card already, so it is never refused.
 *
 * Pure and total: the controller hands it the card's title, summary and parent, and turns the signals into a refusal.
 */

export interface UmbrellaShape {
  readonly title: string;
  readonly summary?: string | undefined;
  /** The card this one is part of, when `--parent` names one. */
  readonly parent?: unknown;
}

/** Title words that name a pile of work rather than one outcome: alone, each is enough. */
const STRONG_WORDS =
  /\b(overhaul|umbrella|epic|system[- ]?wide|misc|miscellaneous|omnibus|catch[- ]all|roadmap|grab[- ]bag|assorted|odds and ends|and more|etc)\b/iu;

/** Title words that often mean many things, but name one outcome too ("Show all sessions"): only with another signal. */
const WEAK_WORDS = /\b(all|everything|various|every|whole|general|cleanup|clean[- ]up|improvements|fixes|polish)\b/iu;

/** Splits a summary into the separate outcomes it lists: by line, semicolon, numbering, a comma or "and". */
const OUTCOME_BREAK = /\s*(?:\n|;|\s\d+[.)]\s|,\s*(?:and\s+|also\s+)?|\s+and\s+(?:also\s+)?|\s+plus\s+)\s*/u;

/** How many separate outcomes a summary lists: the clauses of two words or more (so "easy and fast" is one). */
export function outcomeCount(summary: string): number {
  return summary
    .replace(/^\s*(?:[-*]|\d+[.)])\s+/gmu, '\n')
    .split(OUTCOME_BREAK)
    .map(clause => clause.trim())
    .filter(clause => clause.split(/\s+/u).length >= 2).length;
}

/** The broad word a title uses, strong first, or nothing. */
export const broadWord = (title: string): { readonly word: string; readonly strong: boolean } | undefined => {
  const strong = STRONG_WORDS.exec(title)?.[1];
  if (strong !== undefined) return { word: strong, strong: true };
  const weak = WEAK_WORDS.exec(title)?.[1];
  return weak === undefined ? undefined : { word: weak, strong: false };
};

/**
 * Why a card looks like an umbrella, one reason a line; empty when it looks like one outcome. It is one when it has no
 * parent and its title uses a strong broad word, or its summary lists three outcomes or more, or a weak broad word
 * comes with a summary that lists two.
 */
export function umbrellaSignals(shape: UmbrellaShape): string[] {
  if (shape.parent !== undefined && shape.parent !== null) return [];
  const word = broadWord(shape.title);
  const outcomes = outcomeCount(shape.summary ?? '');
  const signals: string[] = [];
  if (word?.strong === true) signals.push(`the title says "${word.word}"`);
  if (outcomes >= 3) signals.push(`the summary lists ${String(outcomes)} outcomes`);
  if (word?.strong === false && outcomes === 2) {
    signals.push(`the title says "${word.word}" and the summary lists 2 outcomes`);
  }
  return signals;
}

/** The refusal's words: why, then the ways out, each a command. */
export function umbrellaRefusal(signals: readonly string[], binary: string): string {
  return [
    `This looks like an umbrella card (${signals.join('; ')}), and nothing was created.`,
    'A card shows the progress of one outcome; its asks ride its agenda. An umbrella shows no progress and hides each',
    "part's asks. Instead:",
    `  ${binary} card new … (one card per outcome)`,
    `  ${binary} card new … --parent F12   it is one part of a bigger card`,
    `  ${binary} card new … --related F12  add it to a related card as a note, creating nothing`,
    `  ${binary} card new … --broad "<why this must be one card>"`,
  ].join('\n');
}

/** One line printed when a card with the owner's words is filed under a parent: a sub-card is private. */
export const SUB_CARD_ASK_WARNING = 'this card will be private (a sub-card); drop --parent so the owner sees it';
