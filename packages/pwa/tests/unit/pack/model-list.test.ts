import { describe, expect, it } from 'bun:test';
import { descriptionKey, groupModels, modelMatches, modelRowKey } from '../../../src/lib/pack/model-list.ts';
import { ASTRA, FLEET_MODELS, GLM, OPUS, SONNET } from '../../support/pack.ts';

describe('modelMatches', () => {
  it('needs every word, in any of the names or the description, in any case', () => {
    expect(modelMatches(OPUS, '')).toBe(true);
    expect(modelMatches(OPUS, 'OPUS')).toBe(true);
    expect(modelMatches(OPUS, 'anthropic opus')).toBe(true);
    expect(modelMatches(OPUS, 'opus zai')).toBe(false);
    expect(modelMatches({ ...OPUS, description: 'Great at planning' }, 'planning')).toBe(true);
    expect(modelMatches(OPUS, 'planning')).toBe(false);
  });
});

describe('groupModels', () => {
  it('groups by catalog in the order each first appears', () => {
    const groups = groupModels(FLEET_MODELS, '');
    expect(groups.map(group => group.provider)).toEqual(['anthropic', 'zai', 'openai', 'ollama', 'deepseek']);
    expect(groups[0]?.label).toBe('Anthropic');
    expect(groups[0]?.models.map(model => model.id)).toContain(SONNET.id);
  });

  it('keeps only the models that match, and no empty group', () => {
    expect(groupModels(FLEET_MODELS, 'glm').map(group => group.provider)).toEqual(['zai']);
    expect(groupModels(FLEET_MODELS, 'no such model')).toEqual([]);
  });
});

describe('keys', () => {
  it('tells the same id under two CLIs apart, but shares a description across them', () => {
    const codexOpus = { ...OPUS, harness: 'codex' as const };
    expect(modelRowKey(OPUS)).not.toBe(modelRowKey(codexOpus));
    expect(descriptionKey(OPUS)).toBe(descriptionKey(codexOpus));
    expect(descriptionKey(GLM)).not.toBe(descriptionKey(ASTRA));
  });
});
