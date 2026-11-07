/**
 * CUT ONE SENTENCE INTO PIECES A SPEECH ENGINE WILL FINISH.
 *
 * Chrome silently stops an utterance after roughly fifteen seconds, which is a long sentence in a
 * reply. So each caption is spoken as a short run of utterances, cut at the most natural place that
 * fits: after a sentence end, then after a comma-like pause, then between words, and only as a last
 * resort in the middle of one very long word. Pure and total; the pieces joined by a space are the input.
 */

/** Short enough that an engine never reaches its cut-off, long enough to keep the voice's phrasing. */
export const SPEECH_CHUNK_LIMIT = 180;

const BOUNDARIES: readonly RegExp[] = [/[.!?…]["')\]]*\s+/gu, /[,;:—–]["')\]]*\s+/gu, /\s+/gu];

/** The last place before `limit` where one of `boundaries` (in order of preference) ends, or -1. */
const cutPoint = (text: string, limit: number): number => {
  for (const pattern of BOUNDARIES) {
    let best = -1;
    for (const match of text.matchAll(pattern)) {
      const end = (match.index ?? 0) + match[0].length;
      if (end > limit) break;
      best = end;
    }
    // A cut that leaves a sliver is worse than the next kind of boundary.
    if (best >= limit / 4) return best;
  }
  return -1;
};

export const chunkForSpeech = (text: string, limit: number = SPEECH_CHUNK_LIMIT): string[] => {
  const size = Number.isFinite(limit) && limit >= 8 ? Math.floor(limit) : SPEECH_CHUNK_LIMIT;
  const out: string[] = [];
  let rest = text.replace(/\s+/gu, ' ').trim();
  while (rest.length > size) {
    let at = cutPoint(rest, size);
    if (at === -1) at = size;
    // Never cut between the two halves of a surrogate pair.
    const code = rest.charCodeAt(at - 1);
    if (code >= 0xd800 && code <= 0xdbff) at -= 1;
    const piece = rest.slice(0, at).trim();
    if (piece !== '') out.push(piece);
    rest = rest.slice(at).trim();
  }
  if (rest !== '') out.push(rest);
  return out;
};
