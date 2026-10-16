import { describe, it } from 'bun:test';
import { builtInPresets, type ProviderPreset } from '@ferretry/fleet';
import { FleetProviderPresetCatalogSchema } from '@ferretry/protocol';
import should from 'should';
import { ProviderPresetService, presetTestAct, presetView } from '../../../src/lib/provider-probe/presets.ts';

const PRESETS = builtInPresets();
const preset = (id: string): ProviderPreset => PRESETS.find(entry => entry.id === id) as ProviderPreset;

describe('presetTestAct', () => {
  it('should say a free read spends nothing, a one-token message spends one, and a missing test why', () => {
    should(presetTestAct(preset('kimi').test)).deepEqual({
      available: true,
      spends: 'nothing',
      note: 'Lists the models the key can use. Spends nothing.',
    });
    should(presetTestAct(preset('qwen-coding-plan').test)).containDeep({ available: true, spends: 'one-token' });
    should(presetTestAct(preset('ollama-codex').test)).containDeep({ available: true, spends: 'nothing' });
    should(presetTestAct(preset('google-vertex').test)).containDeep({ available: false });
  });
});

describe('presetView', () => {
  it('should carry secrets by suggested NAME and plain values as they are', () => {
    // Act
    const actual = presetView(preset('zai-glm'));

    // Assert
    should(actual.variables).containDeep([
      { name: 'ANTHROPIC_BASE_URL', kind: 'plain', value: 'https://api.z.ai/api/anthropic', required: true },
      { name: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', secret: 'ZAI_API_KEY', required: true },
      { name: 'API_TIMEOUT_MS', kind: 'plain', required: false },
    ]);
    should(actual.offered).deepEqual({ available: true });
    should(actual.quota.source).equal('zai-coding-plan');
    should(actual.unverified.length).equal(1);
  });

  it('should carry what a cloud preset takes, and say why a hidden one is not offered', () => {
    should(presetView(preset('amazon-bedrock')).cloudCredential).deepEqual({
      kinds: ['aws-profile'],
      suggested: 'aws-profile:default',
    });
    const hidden = {
      ...preset('ollama-codex'),
      unavailable: 'Not here.',
    };
    should(presetView(hidden).offered).deepEqual({ available: false, reason: 'Not here.' });
    should(presetView(hidden).halves).deepEqual([
      { harness: 'codex', offered: { available: false, reason: 'Not here.' }, models: ['gpt-oss:20b', 'gpt-oss:120b'] },
    ]);
  });

  it('should offer each half of a two-CLI preset, and tag each variable with the halves that set it', () => {
    // Act
    const actual = presetView(preset('deepseek'));

    // Assert
    should(actual.harness).equal('claude');
    should(actual.halves?.map(half => [half.harness, half.offered.available, half.docs ?? null])).deepEqual([
      ['claude', true, null],
      ['codex', true, 'https://api-docs.deepseek.com/quick_start/agent_integrations/codex'],
    ]);
    should(actual.variables).containDeep([
      { name: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', secret: 'DEEPSEEK_API_KEY', harnesses: ['claude'] },
      { name: 'DEEPSEEK_API_KEY', kind: 'secret', secret: 'DEEPSEEK_API_KEY', harnesses: ['codex'] },
    ]);
    should(actual.detect).deepEqual({ hosts: ['api.deepseek.com'], variables: ['DEEPSEEK_*'], keyPrefixes: [] });
  });

  it('should say why a half is not offered, and tag no variable of a one-CLI login', () => {
    // Act
    const actual = presetView(preset('zai-glm'));

    // Assert
    should(actual.offered).deepEqual({ available: true });
    should(actual.halves?.[1]?.offered.available).be.false();
    should(JSON.stringify(actual.halves?.[1]?.offered)).match(/model catalogue file/u);
    should(actual.variables.some(variable => variable.harnesses !== undefined)).be.false();
    should(actual.variables.some(variable => variable.name === 'ZAI_API_KEY')).be.false();
  });

  it('should carry no detection clues for a preset that declares none', () => {
    should(presetView(preset('custom-gateway')).detect).be.undefined();
  });

  it('should give a variable its description when the preset has one', () => {
    should(presetView(preset('anthropic-api-key')).variables[0]).containDeep({
      description: 'the API key, sent as x-api-key',
    });
  });
});

describe('ProviderPresetService', () => {
  it("should offer the built-ins with this machine's own files laid over them, as the wire allows", async () => {
    // Arrange
    const mine = { ...preset('kimi'), id: 'my-gateway', origin: 'file' as const, label: 'My gateway' };
    const service = new ProviderPresetService({ presets: async () => ({ 'my-gateway': mine }) });

    // Act
    const actual = FleetProviderPresetCatalogSchema.parse(await service.catalog());

    // Assert
    should(actual.presets.length).equal(PRESETS.length + 1);
    should(actual.presets.at(-1)).containDeep({ id: 'my-gateway', origin: 'file', label: 'My gateway' });
    should(actual.presets[0]?.id).equal('anthropic-api-key');
  });

  it('should take the built-ins it is given', async () => {
    const service = new ProviderPresetService({ presets: async () => ({}) }, [preset('kimi')]);
    should((await service.presets()).map(entry => entry.id)).deepEqual(['kimi']);
  });
});
