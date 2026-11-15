import { describe, expect, it } from 'bun:test';
import type { ProviderPresetView } from '../../../contract/index.ts';
import { gridSections, presetMatches } from '../../../app/lib/provider-grid-model.ts';

const preset = (id: string, extra: Partial<ProviderPresetView> = {}): ProviderPresetView =>
  ({ id, label: id.toUpperCase(), summary: `The ${id} gateway.`, ...extra }) as ProviderPresetView;

describe('presetMatches', () => {
  it('needs every word of the search in the name, the id or the summary, in any case', () => {
    const glm = preset('zai-glm', { label: 'GLM / Z.ai', summary: 'Claude Code on GLM.' });
    expect(presetMatches(glm, '')).toBe(true);
    expect(presetMatches(glm, 'glm CLAUDE')).toBe(true);
    expect(presetMatches(glm, 'zai-glm')).toBe(true);
    expect(presetMatches(glm, 'glm kimi')).toBe(false);
  });
});

describe('gridSections', () => {
  const presets = [
    preset('custom-gateway', { group: 'popular' }),
    preset('ollama', { group: 'self-hosted' }),
    preset('deepseek', { group: 'popular' }),
    preset('bedrock', { group: 'cloud' }),
    preset('misc'),
  ];

  it('puts each preset under its heading in the daemon order, the custom gateway last, and an ungrouped one under More providers', () => {
    expect(gridSections(presets).map(section => [section.heading, section.presets.map(p => p.id)])).toEqual([
      ['Popular', ['deepseek', 'custom-gateway']],
      ['Cloud', ['bedrock']],
      ['More providers', ['misc']],
      ['Self-hosted', ['ollama']],
    ]);
  });

  it('keeps only what a search matches and leaves no heading empty', () => {
    expect(gridSections(presets, '  deep ').map(section => section.key)).toEqual(['popular']);
    expect(gridSections(presets, 'nothing like it')).toEqual([]);
  });
});
