import { describe, it } from 'bun:test';
import { builtInPresets, CredentialSchema } from '@ferretry/fleet';
import { FleetCredentialEnvironmentSchema } from '@ferretry/protocol';
import should from 'should';
import { credentialEnvironmentView } from '../../../src/lib/provider-probe/environment-view.ts';

const PRESETS = builtInPresets();
const login = (input: Record<string, unknown>) => CredentialSchema.parse({ store: 'environment', ...input });

describe('credentialEnvironmentView', () => {
  it('should show plain values, secrets by NAME with set ✓, and what is still needed', () => {
    // Act
    const actual = FleetCredentialEnvironmentSchema.parse(
      credentialEnvironmentView(
        login({
          harness: 'claude',
          preset: 'zai-glm',
          env: {
            ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic',
            ANTHROPIC_AUTH_TOKEN: '${secret:ZAI_API_KEY}',
            EXTRA: 'Bearer ${secret:ZAI_API_KEY} ${secret:OTHER}',
          },
        }),
        PRESETS,
        new Set(['ZAI_API_KEY']),
      ),
    );

    // Assert
    should(actual.preset).deepEqual({
      id: 'zai-glm',
      label: 'GLM / Z.ai',
      docs: 'https://docs.z.ai/devpack/tool/claude',
    });
    should(actual.variables).deepEqual([
      { name: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', secrets: ['ZAI_API_KEY'], set: true },
      { name: 'ANTHROPIC_BASE_URL', kind: 'plain', value: 'https://api.z.ai/api/anthropic' },
      { name: 'EXTRA', kind: 'secret', secrets: ['ZAI_API_KEY', 'OTHER'], set: false },
    ]);
    should(actual.missingSecrets).deepEqual(['OTHER']);
    should(actual.quotaSource).equal('zai-coding-plan');
    should(actual.test).containDeep({ available: true, spends: 'nothing' });
  });

  it('should hide a value that looks like a key, and claim nothing when the store cannot be listed', () => {
    // Act
    const actual = credentialEnvironmentView(
      login({ harness: 'claude', env: { ANTHROPIC_API_KEY: 'sk-ant-api03-abcdefghijklmnop', T: '${secret:T}' } }),
      PRESETS,
      undefined,
    );

    // Assert
    should(actual.variables).deepEqual([
      { name: 'ANTHROPIC_API_KEY', kind: 'hidden' },
      { name: 'T', kind: 'secret', secrets: ['T'], set: false },
    ]);
    should(actual.missingSecrets).deepEqual([]);
    should(actual.quotaSource).equal('transcript-pricing');
    should(actual.test).match({ available: false, reason: /not made from a preset/u });
  });

  it('should say a cloud reference in words, and name a Codex provider', () => {
    // Act
    const bedrock = credentialEnvironmentView(
      login({
        harness: 'claude',
        preset: 'amazon-bedrock',
        env: { CLAUDE_CODE_USE_BEDROCK: '1' },
        cloudCredential: 'aws-profile:acme',
      }),
      PRESETS,
      new Set(),
    );
    const azure = credentialEnvironmentView(
      login({ harness: 'claude', preset: 'microsoft-foundry-azure-cli', cloudCredential: 'azure-cli' }),
      PRESETS,
      new Set(),
    );
    const kimi = credentialEnvironmentView(
      login({
        harness: 'codex',
        preset: 'kimi-codex',
        env: { KIMI_API_KEY: '${secret:MOONSHOT_API_KEY}' },
        codexProvider: { id: 'kimi', name: 'Kimi', baseUrl: 'https://api.moonshot.ai/v1', keyVariable: 'KIMI_API_KEY' },
      }),
      PRESETS,
      new Set(['MOONSHOT_API_KEY']),
    );
    const ollama = credentialEnvironmentView(
      login({ harness: 'codex', codexProvider: { id: 'ollama' } }),
      PRESETS,
      new Set(),
    );

    // Assert
    should(bedrock.cloudCredential).deepEqual({
      reference: 'aws-profile:acme',
      kind: 'aws-profile',
      sentence: 'Uses your AWS profile acme on this machine. It is named here, never copied.',
      variable: 'AWS_PROFILE',
    });
    should(bedrock.test).containDeep({ available: false });
    should(azure.cloudCredential).not.have.property('variable');
    should(kimi.codexProvider).deepEqual({ id: 'kimi', name: 'Kimi', baseUrl: 'https://api.moonshot.ai/v1' });
    should(ollama.codexProvider).deepEqual({ id: 'ollama', name: 'ollama' });
  });

  it('should say when the preset a login names is gone, and when the Test is missing a value', () => {
    // Act
    const gone = credentialEnvironmentView(
      login({ harness: 'claude', preset: 'vanished', env: { A: '1' } }),
      PRESETS,
      new Set(),
    );
    const unfilled = credentialEnvironmentView(
      login({ harness: 'claude', preset: 'custom-gateway', env: { ANTHROPIC_AUTH_TOKEN: '${secret:K}' } }),
      PRESETS,
      new Set(),
    );

    // Assert
    should(gone.missingPreset).equal('vanished');
    should(gone.test).match({ available: false, reason: /Preset vanished is not on this machine/u });
    should(unfilled.test).deepEqual({ available: false, reason: 'Fill in ANTHROPIC_BASE_URL first, then Test.' });
  });
});
