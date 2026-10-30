/**
 * Pulls the per-type sections out of the guide text `fy render guide` prints
 * (docs/fy-render.md § Guide for agents, shipped as {@link RENDER_GUIDE_SECTION}).
 *
 * The doc is the one owner of the text; this module only reads the shape it is stored in: a
 * `## Guide for agents` heading, then one `### <section>` subsection per surface, closed by the
 * `---` separator every top-level section of the doc ends with. Extraction is line-based on those
 * three shapes alone — nothing else in the section can move a boundary, so prose may change freely
 * under the `render-guide-doc` contract without this code noticing.
 */

/** The heading that opens the guide section, matched as a whole line. */
export const RENDER_GUIDE_HEADING = '## Guide for agents';

/** Every type `fy render guide <type>` answers, in the order the overview lists them. */
export const RENDER_GUIDE_TYPES = [
  'mermaid',
  'svg',
  'html',
  'chart',
  'map',
  'image',
  'video',
  'audio',
  'pdf',
  'lottie',
] as const;

/** The types `fy render guide` accepts. */
type RenderGuideType = (typeof RENDER_GUIDE_TYPES)[number];

/**
 * Which `###` section answers a type. `image`, `video`, `audio` and `pdf` share `media`: they name
 * bytes the same way, and the doc keeps one section for the four.
 */
const SECTION_FOR_TYPE: Record<RenderGuideType, string> = {
  mermaid: 'mermaid',
  svg: 'svg',
  html: 'html',
  chart: 'chart',
  map: 'map',
  image: 'media',
  video: 'media',
  audio: 'media',
  pdf: 'media',
  lottie: 'lottie',
};

/** The section that answers `type`, or `undefined` when `fy render guide` refuses it. */
export function renderGuideSectionName(type: string): string | undefined {
  return type in SECTION_FOR_TYPE ? SECTION_FOR_TYPE[type as RenderGuideType] : undefined;
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
