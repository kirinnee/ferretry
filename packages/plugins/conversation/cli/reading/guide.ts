/**
 * Pulls the per-topic sections out of the guide text `fy render guide` prints
 * (docs/hypermedia.md § Guide for agents, shipped as {@link RENDER_GUIDE_SECTION}).
 *
 * The doc is the one owner of the text; this module only reads the shape it is stored in: a
 * `## Guide for agents` heading, then one `### <section>` subsection per surface, closed by the
 * `---` separator every top-level section of the doc ends with. Extraction is line-based on those
 * three shapes alone — nothing else in the section can move a boundary, so prose may change freely
 * under the drift test (`tests/unit/cli/guide-drift.test.ts`) without this code noticing.
 */

import { FY_RENDER_FORMER_TYPES } from '../../contract/fy-render.ts';

/** The heading that opens the guide section, matched as a whole line. */
const RENDER_GUIDE_HEADING = '## Guide for agents';

/**
 * Every topic `fy render guide <topic>` answers, in the order the overview lists them: the part the app draws, the
 * human/LLM text and the references first, then the `fy-render` types (diagrams, charts, pictures, media, maps, live
 * tasks). A part whose renderer has not landed is not a topic (r12 H4 adds each with its renderer).
 */
export const RENDER_GUIDE_TOPICS = [
  'terminal',
  'human',
  'chart',
  'mermaid',
  'references',
  'svg',
  'html',
  'map',
  'image',
  'video',
  'audio',
  'pdf',
  'lottie',
  'task',
  'board',
] as const;

/** The topics `fy render guide` accepts. */
type RenderGuideTopic = (typeof RENDER_GUIDE_TOPICS)[number];

/**
 * Which `###` section answers a topic. `image`, `video`, `audio` and `pdf` share `media`: they name bytes the same
 * way, and the doc keeps one section for the four; `task` and `board` share `task`, which names tasks.
 */
const SECTION_FOR_TOPIC: Record<RenderGuideTopic, string> = {
  terminal: 'terminal',
  human: 'human',
  chart: 'chart',
  mermaid: 'mermaid',
  references: 'references',
  svg: 'svg',
  html: 'html',
  map: 'map',
  image: 'media',
  video: 'media',
  audio: 'media',
  pdf: 'media',
  lottie: 'lottie',
  task: 'task',
  board: 'task',
};

/** The other text container: `human` answers for `llm`, because one section holds what the two are for. */
const CONTAINER_NAMES: ReadonlySet<string> = new Set(['llm']);

/**
 * The section that answers `topic`, or `undefined` when `fy render guide` refuses it. An agent that still types the
 * type a fence had before the rename (`FY_RENDER_FORMER_TYPES`) is answered with the new type's section.
 */
export function renderGuideSectionName(topic: string): string | undefined {
  const named = CONTAINER_NAMES.has(topic) ? 'human' : (FY_RENDER_FORMER_TYPES.get(topic) ?? topic);
  return named in SECTION_FOR_TOPIC ? SECTION_FOR_TOPIC[named as RenderGuideTopic] : undefined;
}

/**
 * One `###` subsection's body from the guide text: the lines after `### name` up to the next `###`
 * or to the end of the `## Guide for agents` section, trimmed. `undefined` when the guide heading
 * or the named subsection is not there — the caller refuses rather than print an empty guide.
 */
export function renderGuideSection(doc: string, name: string): string | undefined {
  const lines = doc.split('\n');
  const start = lines.indexOf(RENDER_GUIDE_HEADING);
  if (start === -1) return undefined;
  let body: string[] | undefined;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (line.startsWith('## ')) break; // the next top-level section ends the guide
    if (line === '---') break; // the separator that closes the guide section
    if (line.startsWith('### ')) {
      if (body !== undefined) break; // a later subsection ends the body being collected
      if (line === `### ${name}`) body = [];
      continue;
    }
    if (body !== undefined) body.push(line);
  }
  return body === undefined ? undefined : body.join('\n').trim();
}
