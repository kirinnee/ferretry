import type { BlockDef, FolderPartName } from 'durian-markdown';
import { DURIAN_FENCE, durianCloser, durianFences, linesOf } from './fence-boundaries.ts';
import { durianAsIs } from './fy-render-parse.ts';
import { type MermaidStep, mermaidSteps } from './mermaid-steps.ts';

/**
 * THE PARSER HALF OF THE PARTS HELD AS THE CODE THEY ARE, BEFORE DURIAN READS THEM (the renderer half, and the reasons, are
 * `held-fences.tsx`). No React in this file: it runs inside the Durian worker (`durian-worker.ts`) as well as in a unit test.
 *
 * THE WHOLE DEFENCE IS THAT THE PART IS NEVER READ BY DURIAN. Every fence Durian's own line scan would read as one of
 * these parts (any depth: top level, `:::tabs`, `:::accordion`, `:::human`, `:::llm`) has its fence word renamed to a host
 * block of ours, which Durian carries as data. It stays a PART to Durian, so an author's `:::llm` after it still attaches
 * (after a plain code fence Durian would refuse the whole message).
 */

/**
 * EVERY PART OF DURIAN 0.7.0'S FOLDERS (`src/parts/<name>/`, format 11) IS HELD AS THE CODE IT IS (U1 of the DurianMarkdown swap). A
 * part is drawn only after a review of what its component does (a network read, a script, a frame, storage), and the parts
 * below have none yet: `audio video pdf lottie gallery compare-image downloads map explore weather` read files or the network
 * or write storage, and the rest (`diff log http graph sequence ...`) are drawn by a later unit with its own proof. Held, a
 * ```diff or ```log fence stays the highlighted code it was, never Durian's fallback text. The keys are typed against
 * Durian's own list of names (`FolderPartName`), so a part a Durian release adds fails the typecheck here until it is placed.
 */
export const HELD_FOLDER_PARTS: Readonly<Record<FolderPartName, true>> = {
  audio: true,
  calendar: true,
  'chart-kinds': true,
  compare: true,
  'compare-image': true,
  diff: true,
  downloads: true,
  explore: true,
  fishbone: true,
  flame: true,
  gallery: true,
  gantt: true,
  glossary: true,
  graph: true,
  http: true,
  log: true,
  lottie: true,
  map: true,
  math: true,
  pdf: true,
  references: true,
  sankey: true,
  sequence: true,
  stacktrace: true,
  stats: true,
  timeline: true,
  trace: true,
  venn: true,
  video: true,
  wardley: true,
  weather: true,
};

/** The diagram parts that compile a scene while they are read (`state`, `class`, `er`): held like the animation, whose engine they share. */
const HELD_DIAGRAMS: readonly string[] = ['state', 'class', 'er'];

/** The fence words held, and the host block each is renamed to. `chart` keeps its own name (an unbounded formula reader until U5). */
const HELD: Readonly<Record<string, string>> = {
  chart: 'fy-chart-held',
  ...Object.fromEntries([...Object.keys(HELD_FOLDER_PARTS), ...HELD_DIAGRAMS].map(word => [word, `fy-held-${word}`])),
};

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

/** Every held fence word and the host block it is renamed to, for the renderer half to draw as code (a container is shown as Markdown source). */
export const HELD_BLOCKS: readonly (readonly [string, string])[] = [
  ...Object.entries(HELD),
  ...Object.entries(AWAITING),
  ...Object.values(CONTAINERS_HELD).map(name => ['md', name] as const),
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
  // `:::` alone is the container test: Durian allows spaces between it and the name, so the name is not part of the test.
  if (!/[`~]{3}/u.test(text) && !text.includes(':::')) return text;
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

/**
 * `mermaid` IS NOT A DURIAN PART IN 0.7.0 (it was removed; a ```mermaid fence is plain code), so the name is ours: a host block
 * of that name carries the fence's source to the component that hands it to our own diagram renderer (`mermaid-slot.tsx`, the
 * sandbox frame `fy-render` already uses). It exists so a diagram written for Durian 0.6.2 still draws in an old message; it is
 * not taught (decision D2). A `%%{...}%%` directive line is dropped, as Durian 0.6.2 did, so a diagram cannot ask mermaid for
 * settings of its own. `%% @step` lines keep their meaning: the parser says where each step ends (`mermaid-steps.ts`) and the component
 * steps through them, with their captions, as Durian 0.6.2 did.
 */
export const MERMAID_BLOCK_NAME = 'mermaid';

/** The mermaid source without the directives Durian 0.6.2 dropped. */
const withoutMermaidDirectives = (body: string): string =>
  body
    .split('\n')
    .filter(line => !/^\s*%%\s*\{/u.test(line))
    .join('\n');

/** What the parser hands the component: the fence body as written, and Durian's own `as-is` text for it. */
export interface HeldFenceData {
  readonly body: string;
  readonly generated: string | null;
  /** A `mermaid` fence's steps (`%% @step`), when it has at least two: where each ends in `body`, and its caption. */
  readonly steps?: readonly MermaidStep[];
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
  const mermaid: BlockDef<HeldFenceData> = {
    name: MERMAID_BLOCK_NAME,
    parse: input => {
      const body = withoutMermaidDirectives(input.body);
      const steps = mermaidSteps(body);
      return {
        body,
        generated: durianAsIs(lines[input.line - 1], input.body, input.attrs),
        ...(steps.length === 0 ? {} : { steps }),
      };
    },
  };
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
  return [...asHeld, mermaid, ...containers];
}
