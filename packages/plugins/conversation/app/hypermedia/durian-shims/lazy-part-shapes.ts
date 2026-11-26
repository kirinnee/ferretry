/**
 * WHAT THE PARSER ASKS OF A FOLDER PART BEFORE IT PARSES ONE: the facts of each part that Durian's parser reads while it sets itself up and
 * while it finds a part's fence (`parts/runtime.ts` `folderPartRows`, `folderFenceWord`, `inputOf`), so a stand-in can answer them without
 * the part's own code (`lazy-part.ts`). One row per part in Durian's `parts/generated/registry.ts`, copied from the pinned release;
 * `tests/unit/app/hypermedia/lazy-parts.test.ts` holds every row to the installed part (and the list of rows to the registry's list), so a
 * release that adds a part, or changes one of these, fails there and not in a bundle.
 *
 *  - `steps`, `fences`, `chartKinds`: how the parser recognises the part's fence and splits its body;
 *  - `llmKind`, `llm`: whether the part writes the text an LLM reads (the parser asks for it when it reads the part);
 *  - `llmExempt`: whether the part may be over the LLM-text rule (only the checker asks).
 */
export interface PartShape {
  readonly steps: boolean;
  readonly llmKind: 'own' | 'as-is';
  readonly llm: boolean;
  readonly llmExempt: boolean;
  readonly fences?: readonly { readonly word: string; readonly flag: string }[];
  readonly chartKinds?: readonly string[];
}

export const PART_SHAPES: Readonly<Record<string, PartShape>> = {
  audio: { steps: false, llmKind: 'own', llm: true, llmExempt: true },
  calendar: { steps: false, llmKind: 'own', llm: true, llmExempt: false },
  'chart-kinds': {
    steps: false,
    llmKind: 'own',
    llm: true,
    llmExempt: false,
    chartKinds: ['histogram', 'boxplot', 'violin', 'funnel', 'waterfall', 'treemap', 'sunburst', 'calendar'],
  },
  compare: { steps: false, llmKind: 'own', llm: true, llmExempt: false },
  'compare-image': { steps: false, llmKind: 'own', llm: true, llmExempt: false },
  diff: { steps: false, llmKind: 'as-is', llm: false, llmExempt: false },
  downloads: { steps: false, llmKind: 'own', llm: true, llmExempt: false },
  explore: {
    steps: false,
    llmKind: 'own',
    llm: true,
    llmExempt: false,
    fences: [
      { word: 'json', flag: 'explore' },
      { word: 'yaml', flag: 'explore' },
      { word: 'toml', flag: 'explore' },
      { word: 'csv', flag: 'explore' },
    ],
  },
  fishbone: { steps: true, llmKind: 'own', llm: true, llmExempt: false },
  flame: { steps: true, llmKind: 'own', llm: true, llmExempt: false },
  gallery: { steps: false, llmKind: 'own', llm: true, llmExempt: false },
  gantt: { steps: true, llmKind: 'own', llm: true, llmExempt: false },
  glossary: { steps: false, llmKind: 'own', llm: true, llmExempt: false },
  graph: { steps: false, llmKind: 'own', llm: true, llmExempt: false },
  http: { steps: false, llmKind: 'as-is', llm: false, llmExempt: false },
  log: { steps: false, llmKind: 'own', llm: true, llmExempt: false },
  lottie: { steps: false, llmKind: 'own', llm: true, llmExempt: false },
  map: { steps: true, llmKind: 'own', llm: true, llmExempt: false },
  math: { steps: false, llmKind: 'own', llm: true, llmExempt: false },
  pdf: { steps: false, llmKind: 'own', llm: true, llmExempt: false },
  references: { steps: false, llmKind: 'own', llm: true, llmExempt: false },
  sankey: { steps: true, llmKind: 'own', llm: true, llmExempt: false },
  sequence: { steps: true, llmKind: 'own', llm: true, llmExempt: false },
  stacktrace: { steps: false, llmKind: 'own', llm: true, llmExempt: false },
  stats: { steps: false, llmKind: 'own', llm: true, llmExempt: false },
  timeline: { steps: true, llmKind: 'own', llm: true, llmExempt: false },
  trace: { steps: true, llmKind: 'own', llm: true, llmExempt: false },
  venn: { steps: true, llmKind: 'own', llm: true, llmExempt: false },
  video: { steps: false, llmKind: 'own', llm: true, llmExempt: true },
  wardley: { steps: true, llmKind: 'own', llm: true, llmExempt: false },
  weather: { steps: false, llmKind: 'own', llm: true, llmExempt: false },
};
