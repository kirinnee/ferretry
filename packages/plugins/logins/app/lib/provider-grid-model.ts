/**
 * The provider grid's order, the pure half (docs/provider-presets.md): each preset under the heading it names, in the
 * daemon's order within it, the custom gateway last, and only what a search matches. Ported from v4's `provider-model.ts`.
 */

import type { PresetGroup, ProviderPresetView } from '../../contract/index.ts';
import { CUSTOM_GATEWAY } from './paste-model.ts';

/** One heading of the grid and its tiles. `other` holds every preset that names no group. */
export interface GridSection {
  readonly key: PresetGroup | 'other';
  readonly heading: string;
  readonly presets: readonly ProviderPresetView[];
}

/** The headings in the order shown: what a person runs themselves comes last, beside Paste. */
const SECTIONS: readonly { readonly key: GridSection['key']; readonly heading: string }[] = [
  { key: 'popular', heading: 'Popular' },
  { key: 'cloud', heading: 'Cloud' },
  { key: 'other', heading: 'More providers' },
  { key: 'self-hosted', heading: 'Self-hosted' },
];

/** More tiles than this and the grid gets a search box above it. */
export const PROVIDER_SEARCH_THRESHOLD = 8;

/** Whether a preset is what a search asks for: every word of it in the name, the id or the summary. */
export const presetMatches = (preset: ProviderPresetView, query: string): boolean => {
  const haystack = `${preset.label} ${preset.id} ${preset.summary}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/u)
    .every(word => haystack.includes(word));
};

/** The grid under its headings: the custom gateway last, a search applied, no heading left empty. */
export const gridSections = (presets: readonly ProviderPresetView[], query = ''): readonly GridSection[] => {
  const shown = [
    ...presets.filter(preset => preset.id !== CUSTOM_GATEWAY),
    ...presets.filter(preset => preset.id === CUSTOM_GATEWAY),
  ].filter(preset => presetMatches(preset, query.trim()));
  return SECTIONS.map(section => ({
    ...section,
    presets: shown.filter(preset => (preset.group ?? 'other') === section.key),
  })).filter(section => section.presets.length > 0);
};
