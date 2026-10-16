import { describe, it } from 'bun:test';
import type { FleetProviderPresetCatalog, FleetProviderPresetView } from '@ferretry/protocol';
import should from 'should';
import { definedEnv, detectionSentence, detectionTable } from '../../../src/lib/credential/detect-env.ts';

const BASE: FleetProviderPresetView = {
  id: 'deepseek',
  label: 'DeepSeek',
  harness: 'claude',
  summary: 'DeepSeek.',
  docs: 'https://api-docs.deepseek.com',
  origin: 'built-in',
  variables: [],
  models: [],
  test: { available: true, spends: 'nothing', note: 'Lists the models the key can use.' },
  quota: { source: 'deepseek-balance', note: 'Your DeepSeek balance.' },
  unverified: [],
  verified: '2026-10-16',
  offered: { available: true },
};

describe('detectionTable', () => {
  it('should keep only the presets that declare detection clues, by id, in catalogue order', () => {
    const withDetect: FleetProviderPresetView = {
      ...BASE,
      detect: { hosts: ['api.deepseek.com'], variables: ['DEEPSEEK_*'], keyPrefixes: [] },
    };
    const withoutDetect: FleetProviderPresetView = { ...BASE, id: 'custom-gateway' };
    const catalog: FleetProviderPresetCatalog = { presets: [withoutDetect, withDetect] };
    should(detectionTable(catalog)).eql([{ id: 'deepseek', detect: withDetect.detect }]);
  });
});

describe('definedEnv', () => {
  it('should keep only the variables that are actually set', () => {
    should(definedEnv({ A: '1', B: undefined, C: '' })).eql({ A: '1', C: '' });
  });
});

describe('detectionSentence', () => {
  it('should name the provider and what pointed there, never a value', () => {
    const detection = {
      preset: 'deepseek',
      clues: [
        { kind: 'host' as const, variable: 'ANTHROPIC_BASE_URL', host: 'api.deepseek.com' },
        { kind: 'variable' as const, variable: 'DEEPSEEK_API_KEY' },
      ],
      alsoMatched: [],
      recognised: ['ANTHROPIC_BASE_URL', 'DEEPSEEK_API_KEY'],
      harnesses: ['claude' as const],
    };
    should(detectionSentence(BASE, detection)).equal(
      'Detected DeepSeek from ANTHROPIC_BASE_URL (api.deepseek.com), DEEPSEEK_API_KEY.',
    );
  });

  it('should name a custom gateway by what it recognised, or say nothing was recognisable', () => {
    const recognised = { clues: [], alsoMatched: [], recognised: ['MY_SERVICE_API_KEY'], harnesses: [] };
    should(detectionSentence(undefined, recognised)).equal('Detected a custom gateway: MY_SERVICE_API_KEY.');
    should(detectionSentence(undefined, { ...recognised, recognised: [] })).equal(
      'Detected a custom gateway: nothing recognisable.',
    );
  });
});
