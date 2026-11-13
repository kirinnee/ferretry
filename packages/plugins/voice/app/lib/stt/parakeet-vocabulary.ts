/**
 * Parakeet's token vocabulary, read from the installed `vocab.txt` — no network.
 *
 * parakeet.js's own `ParakeetTokenizer` can only be built by FETCHING a URL (`fromUrl`), and that
 * class is not one of the package's exported entry points. The worker already holds the verified
 * bytes, so this builds the same object from text: the fields `ParakeetModel` reads (`id2token`,
 * `blankToken`, `blankId`, `decode`) with the same SentencePiece rules. Ported from parakeet.js 1.4.4
 * `src/tokenizer.js` (MIT, Yunus Seyhan Dede).
 */

export const PARAKEET_BLANK_TOKEN = '<blk>';
/** parakeet.js's fallback when a vocabulary names no blank. */
const FALLBACK_BLANK_ID = 1024;

export class ParakeetVocabulary {
  readonly id2token: readonly (string | undefined)[];
  readonly blankToken = PARAKEET_BLANK_TOKEN;
  readonly blankId: number;
  readonly #spoken: readonly (string | undefined)[];

  constructor(id2token: readonly (string | undefined)[]) {
    this.id2token = id2token;
    const blank = id2token.indexOf(PARAKEET_BLANK_TOKEN);
    this.blankId = blank === -1 ? FALLBACK_BLANK_ID : blank;
    // `▁` (U+2581) marks a word boundary in SentencePiece.
    this.#spoken = id2token.map(token => token?.replace(/▁/gu, ' '));
  }

  /** `<token> <id>` per line; malformed lines are skipped, as parakeet.js does. */
  static parse(text: string): ParakeetVocabulary {
    const id2token: (string | undefined)[] = [];
    for (const line of text.split(/\r?\n/u)) {
      const [token, id] = line.split(/\s+/u);
      const index = Number.parseInt(id ?? '', 10);
      if (!token || !Number.isInteger(index) || index < 0) continue;
      id2token[index] = token;
    }
    return new ParakeetVocabulary(id2token);
  }

  /** Token ids → text, dropping blanks and unknown ids. */
  decode(ids: readonly number[]): string {
    let text = '';
    for (const id of ids) {
      if (id === this.blankId) continue;
      text += this.#spoken[id] ?? '';
    }
    return (
      text
        .replace(/^\s+/u, '')
        // No space before punctuation. Letters and digits are Unicode-wide (parakeet.js used ASCII `\w`,
        // which glued every non-Latin word of this multilingual model to the one before it).
        .replace(/\s+(?=[^\p{L}\p{N}_\s])/gu, '')
        .replace(/\s+/gu, ' ')
        .trim()
    );
  }
}
