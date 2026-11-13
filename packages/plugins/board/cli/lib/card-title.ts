/** The wire schema enforces the same ceiling; this exists to say *why* before a round trip. */
const MAX_CARD_TITLE_WORDS = 5;

const CARD_TITLE_GUIDANCE =
  'Keep the card title to 5 words or fewer; move scope and implementation detail into the description.';

function titleWordCount(title: string): number {
  const trimmed = title.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/u).length;
}

/** A human-facing refusal for a title that is too long, or null when the title is fine. */
export function cardTitleIssue(title: string): string | null {
  const count = titleWordCount(title);
  return count <= MAX_CARD_TITLE_WORDS ? null : `card title has ${count} words; ${CARD_TITLE_GUIDANCE}`;
}
