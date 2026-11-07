/** About this many characters of a ferret's message show before "Show more". */
export const PEER_PREVIEW_CHARS = 120;

export interface PeerPreview {
  readonly preview: string;
  /** The message says more than the preview does. */
  readonly truncated: boolean;
}

const plainOf = (line: string): string =>
  line
    .replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/u, '')
    .replace(/[*_`]/gu, '')
    .trim();

/** The first line of a message — or its first ~120 characters, cut at a word — as plain text. */
export const peerPreview = (text: string, limit: number = PEER_PREVIEW_CHARS): PeerPreview => {
  const body = text.trim();
  const lines = body.split('\n');
  const first = plainOf(lines.find(line => plainOf(line) !== '') ?? '');
  const moreLines = lines.slice(lines.findIndex(line => plainOf(line) !== '') + 1).some(line => line.trim() !== '');
  if (first.length <= limit) return { preview: first, truncated: moreLines };
  const cut = first.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return { preview: `${(space > limit / 2 ? cut.slice(0, space) : cut).trimEnd()}…`, truncated: true };
};
