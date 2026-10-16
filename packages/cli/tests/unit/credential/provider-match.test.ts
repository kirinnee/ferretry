import { describe, it } from 'bun:test';
import type { FleetProviderPresetView } from '@ferretry/protocol';
import should from 'should';
import {
  matchPresetWord,
  offeredHarnesses,
  presetDriveSentence,
  presetOfferedRefusal,
  presetScopeChip,
  resolveAddHarness,
} from '../../../src/lib/credential/provider-match.ts';

const BASE: FleetProviderPresetView = {
  id: 'zai-glm',
  label: 'GLM / Z.ai',
  harness: 'claude',
  summary: 'Claude Code on GLM.',
  docs: 'https://docs.z.ai',
  origin: 'built-in',
  variables: [],
  models: [],
  test: { available: true, spends: 'nothing', note: 'Reads your quota.' },
  quota: { source: 'zai-coding-plan', note: 'Coding Plan quota.' },
  unverified: [],
  verified: '2026-10-16',
  offered: { available: true },
};

const DUAL: FleetProviderPresetView = {
  ...BASE,
  id: 'deepseek',
  label: 'DeepSeek',
  halves: [
    { harness: 'claude', offered: { available: true }, models: [] },
    { harness: 'codex', offered: { available: true }, models: [] },
  ],
};

const CODEX_GAP: FleetProviderPresetView = {
  ...DUAL,
  id: 'deepseek-gap',
  halves: [
    { harness: 'claude', offered: { available: true }, models: [] },
    { harness: 'codex', offered: { available: false, reason: 'Needs a model catalogue file.' }, models: [] },
  ],
};

describe('matchPresetWord', () => {
  it('should match a preset by its own id, exactly, before trying any alias', () => {
    should(matchPresetWord([BASE, DUAL], 'zai-glm')?.preset.id).equal('zai-glm');
    should(matchPresetWord([BASE, DUAL], 'ZAI-GLM')?.preset.id).equal('zai-glm');
  });

  it('should match a loose word against an id segment or a label word, case-insensitively', () => {
    should(matchPresetWord([DUAL], 'DeepSeek')?.preset.id).equal('deepseek');
    const glm = { ...BASE, id: 'zai-glm' };
    should(matchPresetWord([glm], 'glm')?.preset.id).equal('zai-glm');
  });

  it('should pick the first catalogue match for an ambiguous word, naming every other match', () => {
    const amazon = { ...BASE, id: 'amazon-bedrock', label: 'Amazon Bedrock (AWS profile)' };
    const mantle = { ...BASE, id: 'bedrock-mantle', label: 'Bedrock Mantle (AWS profile)' };
    const match = matchPresetWord([amazon, mantle], 'bedrock');
    should(match?.preset.id).equal('amazon-bedrock');
    should(match?.alsoMatched).eql(['bedrock-mantle']);
  });

  it('should return undefined when nothing in the catalogue matches at all', () => {
    should(matchPresetWord([BASE], 'zorp')).be.undefined();
  });
});

describe('offeredHarnesses', () => {
  it('should fall back to the legacy single harness when a preset has no halves', () => {
    should(offeredHarnesses(BASE)).eql(['claude']);
    should(offeredHarnesses({ ...BASE, offered: { available: false, reason: 'no' } })).eql([]);
  });

  it('should read every offered half, Claude Code before Codex', () => {
    should(offeredHarnesses(DUAL)).eql(['claude', 'codex']);
    should(offeredHarnesses(CODEX_GAP)).eql(['claude']);
  });
});

describe('presetOfferedRefusal', () => {
  it('should say why a preset cannot be used, or nothing when it can', () => {
    should(presetOfferedRefusal(BASE)).be.undefined();
    should(
      presetOfferedRefusal({ ...BASE, offered: { available: false, reason: 'Needs a model catalogue file.' } }),
    ).equal('GLM / Z.ai is not offered here: Needs a model catalogue file.');
  });
});

describe('resolveAddHarness', () => {
  it('should pick the first offered half when no --for is given', () => {
    should(resolveAddHarness(DUAL, undefined)).eql({ harness: 'claude' });
  });

  it('should pick the named half when it is offered', () => {
    should(resolveAddHarness(DUAL, 'codex')).eql({ harness: 'codex' });
  });

  it('should refuse a --for CLI the preset has no half for at all', () => {
    should(resolveAddHarness(BASE, 'codex')).eql({ refusal: 'GLM / Z.ai has no half for Codex' });
  });

  it('should refuse a --for CLI whose half exists but is not offered', () => {
    should(resolveAddHarness(CODEX_GAP, 'codex')).eql({
      refusal: 'DeepSeek does not drive Codex: Needs a model catalogue file.',
    });
  });

  it('should refuse a preset with no offered half at all, by its own reason', () => {
    const unavailable = { ...BASE, offered: { available: false as const, reason: 'Needs a model catalogue file.' } };
    should(resolveAddHarness(unavailable, undefined)).eql({
      refusal: 'GLM / Z.ai is not offered here: Needs a model catalogue file.',
    });
  });

  it('should fall back to a generic refusal when an offered preset still drives no CLI', () => {
    should(resolveAddHarness({ ...BASE, halves: [] }, undefined)).eql({ refusal: 'GLM / Z.ai drives no CLI here.' });
  });
});

describe('presetScopeChip', () => {
  it('should chip both CLIs, one only, or neither', () => {
    should(presetScopeChip(DUAL)).equal('Claude + Codex');
    should(presetScopeChip(BASE)).equal('Claude only');
    should(presetScopeChip({ ...BASE, harness: 'codex' })).equal('Codex only');
    should(presetScopeChip({ ...BASE, offered: { available: false, reason: 'no' } })).equal('not offered');
  });
});

describe('presetDriveSentence', () => {
  it('should say which CLIs a login from the preset drives', () => {
    should(presetDriveSentence(BASE)).equal('drives Claude Code');
    should(presetDriveSentence(DUAL)).equal('drives Claude Code + Codex');
  });
});
