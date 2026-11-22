/**
 * HOW A MESSAGE'S FENCES ARE READ LINE BY LINE, for the two places that must agree with Durian and with CommonMark about
 * where a fence ends: `parse-message.ts` (a fence still streaming in) and `fy-render-host.tsx` (a closer that is not one).
 * Pure functions of text; nothing here draws.
 */

export const linesOf = (source: string): readonly string[] => source.split(/\r\n|\r|\n/u);

/** Durian's own fence pattern (`src/core/dh-lib.ts`): any indent, a run of three or more backticks or tildes, an info string. */
export const DURIAN_FENCE = /^(\s*)(`{3,}|~{3,})\s*([^\s`{]*)(.*)$/u;

/**
 * Where Durian ends the fence opened on `lines[from]` (its `closeFence`): the next line that, trimmed, is nothing but
 * backticks or tildes, starting with this fence's own character at least as long. It does not look at the indent, which
 * CommonMark does ({@link isIndentedPastFence}). `-1` when there is none.
 */
export function durianCloserIndex(lines: readonly string[], from: number, fence: string): number {
  for (let j = from + 1; j < lines.length; j++) {
    const trimmed = (lines[j] ?? '').trim();
    if (
      trimmed.startsWith((fence[0] ?? '`').repeat(fence.length)) &&
      /^[`~]+$/u.test(trimmed) &&
      trimmed.length >= fence.length
    )
      return j;
  }
  return -1;
}

/** CommonMark: a delimiter line indented four columns or more (a tab is four) is content, not a fence's opener or closer. */
export const isIndentedPastFence = (line: string): boolean => /^(?: {4}|\s*\t)/u.test(line);

/** One level of nesting a fence can sit in. A list item's `width` is what its continuation lines must be indented by. */
type Container = { readonly kind: 'quote' } | { readonly kind: 'list'; readonly width: number };

const QUOTE_MARKER = /^ {0,3}>[ \t]?/u;
const LIST_MARKER = /^( {0,3})([-*+]|\d{1,9}[.)])( {1,4})(?! )/u;
/** A fence opened as exactly `fy-render`, after any quote or list markers, indented at most three spaces more. */
const FY_RENDER_AFTER_MARKERS = /^ {0,3}(`{3,}|~{3,})[ \t]*fy-render[ \t]*$/u;

/** The containers a line opens with and what is left of it, or `null` when it opens none (a top-level line). */
function openedContainers(line: string): { readonly chain: readonly Container[]; readonly rest: string } | null {
  const chain: Container[] = [];
  let rest = line;
  for (;;) {
    const quote = QUOTE_MARKER.exec(rest);
    if (quote !== null) {
      chain.push({ kind: 'quote' });
      rest = rest.slice(quote[0].length);
      continue;
    }
    const list = LIST_MARKER.exec(rest);
    if (list !== null) {
      chain.push({ kind: 'list', width: list[0].length });
      rest = rest.slice(list[0].length);
      continue;
    }
    return chain.length === 0 ? null : { chain, rest };
  }
}

/** A later line as the inside of those containers, or `null` when it is no longer inside them (the fence ends with them). */
function insideContainers(line: string, chain: readonly Container[]): string | null {
  let rest = line;
  for (const container of chain) {
    if (container.kind === 'quote') {
      const quote = QUOTE_MARKER.exec(rest);
      if (quote === null) return null;
      rest = rest.slice(quote[0].length);
    } else if (rest.trim() === '') rest = '';
    else if (rest.startsWith(' '.repeat(container.width))) rest = rest.slice(container.width);
    else return null;
  }
  return rest;
}

/** Does a line after a container's fence close it, from inside the same containers? */
function closesInContainers(
  lines: readonly string[],
  from: number,
  chain: readonly Container[],
  fence: string,
): boolean {
  const closer = new RegExp(`^ {0,3}[${fence[0] ?? '`'}]{${fence.length},}[ \\t]*$`, 'u');
  for (let j = from + 1; j < lines.length; j++) {
    const inside = insideContainers(lines[j] ?? '', chain);
    if (inside === null) return false;
    if (closer.test(inside)) return true;
  }
  return false;
}

/** Appended to the opening line of a container fence that has no closer yet: a fence with metadata is plain code. */
const HELD_META = 'unclosed';

/**
 * A ` ```fy-render ` fence inside a blockquote or a list item that its own container never closes is HELD: a message still
 * streaming in would otherwise draw it, partial body and all, because CommonMark ends such a fence where its container
 * ends. A word is added to the opener's info string (the fence is then not exactly `fy-render`, so it is plain code, and
 * its text is unchanged). The text is returned as it came when nothing is held. Lines inside a top-level fence, or in a
 * part Durian reads, are that fence's own content and are left alone.
 */
export function holdOpenContainerFences(text: string): string {
  const lines = [...linesOf(text)];
  let held = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const top = DURIAN_FENCE.exec(line);
    if (top !== null) {
      const close = durianCloserIndex(lines, i, top[2] ?? '```');
      // An unclosed top-level fence swallows the rest of the message (the streaming pass reads it as one block of code).
      if (close < 0) break;
      i = close;
      continue;
    }
    const opened = openedContainers(line);
    if (opened === null) continue;
    const fence = FY_RENDER_AFTER_MARKERS.exec(opened.rest)?.[1];
    if (fence === undefined || closesInContainers(lines, i, opened.chain, fence)) continue;
    lines[i] = `${line} ${HELD_META}`;
    held = true;
  }
  return held ? lines.join('\n') : text;
}
