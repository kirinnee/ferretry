import type { BlockDef, HostBlock } from 'durian-hypermedia';
import type { ComponentType } from 'react';
import { DURIAN_FENCE, durianCloser, durianFences, linesOf } from './fence-boundaries.ts';
import { durianAsIs } from './fy-render-host.tsx';
import { authorTextBeside, LlmOnlyText } from './llm-text.tsx';
import { HypermediaCode } from './slots.tsx';

/**
 * TWO DURIAN PARTS ARE HELD AS THE CODE THEY ARE, BEFORE DURIAN READS THEM (r12 H4 review R1: S1 and G1).
 *
 * ```chart (S1, HIGH). Durian evaluates a chart's `let` formulas AT PARSE TIME (`src/core/dh-lib.ts` `jsonOf`, then
 * `chart-llm.ts`), on the main thread, and again on every control change. Its expression engine (`src/core/expr.ts`)
 * counts steps per AST node with a fresh budget per definition, a broadcast over a 10,000-item list is ONE step, and the
 * size cap checks only a list's top level. Measured on this pin: a 421-byte chart of nested user functions freezes the tab
 * for 3.2 s, four of them for 12.6 s, and `fill(fill(fill(1,300),300),300)+1` (40 chars) allocates 27 million values. A
 * message can hold hundreds of them and is read again every time its transcript opens. No size cap on OUR side bounds
 * that work, so no chart is evaluated until upstream bounds the evaluator (the ask is in `C1-upstream-ask.md`: one step
 * per broadcast element, one budget per document, a cap on total nested size). Of Durian's parts only `chart` reaches
 * `src/core/expr.ts` (`chart.ts`; `doccheck.ts` too, which a message never runs): the animation, tier list, alignment,
 * terminal, file tree, editor, code walk and mermaid parts read no expression. Our own `fy-render` chart is a different,
 * bounded reader and is untouched.
 *
 * ```codewalk (G1). It is not drawn (its notes are set as HTML, which the page's Trusted Types policy refuses), and a
 * Durian block keeps no source: with an author's `:::llm` after it, the fence's own text was nowhere on the page. Held,
 * its source and notes are drawn as code, and the `:::llm` text is the disclosure beside them.
 *
 * THE WHOLE DEFENCE IS THAT THE EVALUATOR (and the code walk's reader) IS NEVER REACHED. Every fence Durian's own line
 * scan would read as one of these parts (any depth: top level, `:::tabs`, `:::accordion`, `:::human`, `:::llm`) has its
 * fence word renamed to a host block of ours, which Durian carries as data. It stays a PART to Durian, so an author's
 * `:::llm` after it still attaches (after a plain code fence Durian would refuse the whole message). `HYPERMEDIA_PARTS`
 * still names a component for both (its type requires one per part); none is reachable.
 */

/** The fence words held, and the host block each is renamed to. */
const HELD: Readonly<Record<string, string>> = { chart: 'fy-chart-held', codewalk: 'fy-codewalk-held' };

/**
 * A part held ONLY UNTIL ITS ENGINE HAS ARRIVED (r12 H8 fix): the 2D animation's scene compiler is a lazy chunk
 * (`animation-engine.ts`), and the parser cannot compile a scene it does not have. Until then the fence is shown as the code
 * it is; once the engine is here a message is read again and the animation draws.
 */
const AWAITING: Readonly<Record<string, string>> = { animation: 'fy-animation-awaiting' };

/**
 * INTERIM (r12 H11a): whether an animation is drawn at all. It is not: an `animation` fence is shown as the code it is, the
 * same as a chart, until the parser runs off the main thread (r12 H11). The engine's door (`animation-engine.ts`) stays as
 * it is, so the change that turns drawing back on flips this one value; until then nothing fetches the engine's chunk.
 */
export const ANIMATION_DRAWS = false;

/**
 * A `:::tabs` OR `:::accordion` CONTAINER IS HELD AS CODE TOO (r12 H11a), and is not a fence word: Durian reads it from its
 * own line scan (`:::` then the name, spaces allowed between, at column 0 to the next `:::`, a fence inside it skipped), so
 * {@link holdFences} finds it the same way and turns it into ONE fence of the host block for its name, which stays a part
 * to Durian (an author's `:::llm` after it still attaches). Its source, the opening and `:::` lines included, is what the
 * reader sees.
 */
const CONTAINERS_HELD: Readonly<Record<string, string>> = { tabs: 'fy-tabs-held', accordion: 'fy-accordion-held' };

const CONTAINER_OPEN = /^:::\s*([a-z][a-z0-9-]*)(.*)$/u;
const CONTAINER_CLOSE = /^:::\s*$/u;

/** The line that closes the container opened at `open`, read as Durian does (a fence inside is skipped); -1 when Durian refuses it. */
function containerClose(lines: readonly string[], open: number): number {
  for (let at = open + 1; at < lines.length; at++) {
    const line = lines[at] ?? '';
    const fence = DURIAN_FENCE.exec(line)?.[2];
    if (fence !== undefined) {
      const close = durianCloser(lines, at, fence);
      if (close > 0) {
        at = close;
        continue;
      }
    }
    if (CONTAINER_CLOSE.test(line)) return at;
    if (CONTAINER_OPEN.test(line)) return -1;
  }
  return -1;
}

/** The held containers (`:::tabs`, `:::accordion`) of a message as Durian's own line scan finds them: top level only (containers do not nest). */
function heldContainers(
  lines: readonly string[],
): readonly { readonly open: number; readonly close: number; readonly name: string }[] {
  const found: { open: number; close: number; name: string }[] = [];
  for (let at = 0; at < lines.length; at++) {
    const line = lines[at] ?? '';
    const fence = DURIAN_FENCE.exec(line)?.[2];
    if (fence !== undefined) {
      const close = durianCloser(lines, at, fence);
      if (close < 0) break;
      at = close;
      continue;
    }
    const open = CONTAINER_OPEN.exec(line);
    if (open === null) continue;
    const close = containerClose(lines, at);
    if (close < 0) break;
    const name = open[1] ?? '';
    if (Object.hasOwn(CONTAINERS_HELD, name)) found.push({ open: at, close, name });
    at = close;
  }
  return found;
}

/** Every held container of `lines` as one fence of its host block in {@link CONTAINERS_HELD}, longer than any run of backticks inside it. Line numbers do not move. */
function holdContainers(lines: string[]): boolean {
  const containers = heldContainers(lines);
  for (const { open, close, name } of containers) {
    let longest = 2;
    for (let at = open + 1; at < close; at++)
      for (const run of (lines[at] ?? '').matchAll(/`+/gu)) longest = Math.max(longest, run[0].length);
    const ticks = '`'.repeat(longest + 1);
    lines[open] = `${ticks}${CONTAINERS_HELD[name]}${CONTAINER_OPEN.exec(lines[open] ?? '')?.[2] ?? ''}`;
    lines[close] = ticks;
  }
  return containers.length > 0;
}

/** The host block a fence word is renamed to, when it is one held. */
const heldNameOf = (word: string | undefined, awaiting: boolean): string | undefined => {
  if (word === undefined) return undefined;
  if (Object.hasOwn(HELD, word)) return HELD[word];
  return awaiting && Object.hasOwn(AWAITING, word) ? AWAITING[word] : undefined;
};

/** Whether `text` has a fence Durian reads as an animation (the same line scan as {@link holdFences}). */
export function holdsAnimation(text: string): boolean {
  if (!text.includes('animation')) return false;
  const lines = linesOf(text);
  return durianFences(lines).some(({ open }) => DURIAN_FENCE.exec(lines[open] ?? '')?.[3] === 'animation');
}

/**
 * `text` with every fence Durian reads as a held part renamed to its host block; `text` itself when it holds none. It reads
 * the fences the way Durian does (its own pattern and its own line scan), so it holds exactly the ones Durian would
 * evaluate, whatever CommonMark makes of them. Line numbers do not move. `awaitingAnimation`: the animation engine has not
 * arrived, so an animation fence is held too.
 */
export function holdFences(text: string, awaitingAnimation = false): string {
  // `:::` alone is the container test: Durian allows spaces between it and the name, so the name is not part of the test.
  if (
    !text.includes('chart') &&
    !text.includes('codewalk') &&
    !text.includes(':::') &&
    !(awaitingAnimation && text.includes('animation'))
  )
    return text;
  const lines = [...linesOf(text)];
  // Containers first: what one holds is then inside one longer fence, which the scan below reads past, so a chart inside
  // it is shown exactly as written and is no second block.
  let held = holdContainers(lines);
  for (const { open } of durianFences(lines)) {
    const parts = DURIAN_FENCE.exec(lines[open] ?? '');
    const name = heldNameOf(parts?.[3], awaitingAnimation);
    if (parts === null || name === undefined) continue;
    const before = parts[0].length - (parts[3]?.length ?? 0) - (parts[4]?.length ?? 0);
    lines[open] = `${parts[0].slice(0, before)}${name}${parts[4] ?? ''}`;
    held = true;
  }
  return held ? lines.join('\n') : text;
}

/** What the parser hands the component: the fence body as written, and Durian's own `as-is` text for it. */
interface HeldFenceData {
  readonly body: string;
  readonly generated: string | null;
}

/**
 * The parser half, for ONE message (`heldText` is what {@link holdFences} returned, which Durian is given). No `llm` hook,
 * as with `fy-render`: the author's `:::llm` after the fence stays on `block.llm` for the disclosure.
 */
export function heldFenceParseBlocks(heldText: string): readonly BlockDef<HeldFenceData>[] {
  const lines = linesOf(heldText);
  const asHeld = [...Object.values(HELD), ...Object.values(AWAITING)].map(
    (name): BlockDef<HeldFenceData> => ({
      name,
      parse: input => ({ body: input.body, generated: durianAsIs(lines[input.line - 1], input.body, input.attrs) }),
    }),
  );
  // A held container shows its own lines: what followed its name is read back from the fence it became.
  const containers = Object.entries(CONTAINERS_HELD).map(
    ([word, name]): BlockDef<HeldFenceData> => ({
      name,
      parse: input => {
        const opener = lines[input.line - 1];
        const rest = DURIAN_FENCE.exec(opener ?? '')?.[4] ?? '';
        return {
          body: `:::${word}${rest}\n${input.body}\n:::`,
          generated: durianAsIs(opener, input.body, input.attrs),
        };
      },
    }),
  );
  return [...asHeld, ...containers];
}

/** The fence as the code it is, then the author's `:::llm` text as the usual disclosure. */
const heldPart =
  (lang: string): ComponentType<{ block: HostBlock; data: HeldFenceData }> =>
  ({ block, data }) => {
    const text = authorTextBeside(block, data.generated);
    return (
      <>
        <HypermediaCode lang={lang} meta="" text={data.body} />
        {text === null ? null : <LlmOnlyText text={text} />}
      </>
    );
  };

/** The renderer half, module-level and never rebuilt (Durian keys its settings on the identity of the `blocks` array). */
export const HELD_COMPONENT_BLOCKS: readonly BlockDef<
  HeldFenceData,
  ComponentType<{ block: HostBlock; data: HeldFenceData }>
>[] = [
  ...Object.entries(HELD),
  ...Object.entries(AWAITING),
  ...Object.values(CONTAINERS_HELD).map(name => ['md', name] as const),
].map(([lang, name]) => ({
  name: name as string,
  Component: heldPart(lang as string),
}));
