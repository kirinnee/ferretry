/** One line cut at a word to at most `limit` characters, ending in an ellipsis when it was cut. */
export const clipAtWord = (text: string, limit: number): string => {
  const line = text.replaceAll(/\s+/gu, ' ').trim();
  if (line.length <= limit) return line;
  const room = line.slice(0, limit - 1);
  const space = room.lastIndexOf(' ');
  const cut = space >= Math.floor(limit / 2) ? room.slice(0, space) : room;
  return `${cut.trimEnd().replace(/[\s,;:.\-–—]+$/u, '')}…`;
};
