/**
 * THE HEIGHT A BLOCK LAST HAD, so it never arrives as a box that grows.
 *
 * A block draws lazily — a diagram compiles, a chart loads its engine, an interactive page runs —
 * and until it has drawn it holds an invisible plane. When that plane is the wrong height the
 * prose under it jumps as the picture lands, which is what made hypermedia look "rendered in" as
 * the reader scrolled. Most blocks are seen more than once in a session (a tab switch, a chat
 * revisited, an agenda item reopened), each a fresh mount, so the height measured the last time is
 * the right reservation the next time.
 *
 * Keyed by the block's type and a hash of its source, not by where it is: the same block in a chat
 * and in an agenda tab is the same picture. A height is per column width in truth, so a remembered
 * one is a reservation, never a size: the real content replaces it the moment it draws.
 *
 * In memory only and bounded, oldest first out. No height is ever worth persisting.
 */

/** How many heights are kept. A long session's worth of blocks, a few kilobytes. */
export const FY_RENDER_HEIGHT_MEMORY_SIZE = 256;

const heights = new Map<string, number>();

/** FNV-1a over UTF-16 code units: a cheap, stable key for a source of up to a few hundred KiB. */
const hash = (text: string): string => {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return (value >>> 0).toString(36);
};

/** The memory key for one block: its type, its length and its hash. */
export const fyRenderHeightKey = (type: string, source: string): string => `${type}:${source.length}:${hash(source)}`;

/** The height `key` last drew at, or null when it has not drawn this session. */
export function recallFyRenderHeight(key: string): number | null {
  return heights.get(key) ?? null;
}

/** Record a drawn height. A non-finite or non-positive one is not a height and is ignored. */
export function rememberFyRenderHeight(key: string, height: number): void {
  if (!Number.isFinite(height) || height <= 0) return;
  const rounded = Math.round(height);
  heights.delete(key);
  heights.set(key, rounded);
  while (heights.size > FY_RENDER_HEIGHT_MEMORY_SIZE) {
    const oldest = heights.keys().next().value;
    if (oldest === undefined) break;
    heights.delete(oldest);
  }
}

/** Forget everything — for tests only; the app never clears it. */
export function forgetFyRenderHeights(): void {
  heights.clear();
}
