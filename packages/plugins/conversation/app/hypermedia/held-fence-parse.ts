import type { BlockDef } from 'durian-hypermedia';
import { DURIAN_FENCE, durianFences, linesOf } from './fence-boundaries.ts';
import { durianAsIs } from './fy-render-parse.ts';

/**
 * THE PARSER HALF OF THE PARTS HELD AS THE CODE THEY ARE, BEFORE DURIAN READS THEM (the renderer half, and the reasons, are
 * `held-fences.tsx`). No React in this file: it runs inside the Durian worker (`durian-worker.ts`) as well as in a unit test.
 *
 * THE WHOLE DEFENCE IS THAT THE PART IS NEVER READ BY DURIAN. Every fence Durian's own line scan would read as one of
 * these parts (any depth: top level, `:::tabs`, `:::accordion`, `:::human`, `:::llm`) has its fence word renamed to a host
 * block of ours, which Durian carries as data. It stays a PART to Durian, so an author's `:::llm` after it still attaches
 * (after a plain code fence Durian would refuse the whole message).
 */

/** The fence words held, and the host block each is renamed to. */
const HELD: Readonly<Record<string, string>> = { chart: 'fy-chart-held', codewalk: 'fy-codewalk-held' };

/**
 * A part held ONLY UNTIL ITS ENGINE HAS ARRIVED (r12 H8 fix): the 2D animation's scene compiler is a lazy chunk
 * (`animation-engine.ts`), and the parser cannot compile a scene it does not have. Until then the fence is shown as the code
 * it is; once the engine is here a message is read again and the animation draws.
 */
const AWAITING: Readonly<Record<string, string>> = { animation: 'fy-animation-awaiting' };

/** Every held fence word and the host block it is renamed to, for the renderer half to draw as code. */
export const HELD_BLOCKS: readonly (readonly [string, string])[] = [
  ...Object.entries(HELD),
  ...Object.entries(AWAITING),
];

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
  if (!text.includes('chart') && !text.includes('codewalk') && !(awaitingAnimation && text.includes('animation')))
    return text;
  const lines = [...linesOf(text)];
  let held = false;
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
export interface HeldFenceData {
  readonly body: string;
  readonly generated: string | null;
}

/**
 * The parser half, for ONE message (`heldText` is what {@link holdFences} returned, which Durian is given). No `llm` hook,
 * as with `fy-render`: the author's `:::llm` after the fence stays on `block.llm` for the disclosure.
 */
export function heldFenceParseBlocks(heldText: string): readonly BlockDef<HeldFenceData>[] {
  const lines = linesOf(heldText);
  return HELD_BLOCKS.map(([, name]) => ({
    name,
    parse: input => ({ body: input.body, generated: durianAsIs(lines[input.line - 1], input.body, input.attrs) }),
  }));
}
