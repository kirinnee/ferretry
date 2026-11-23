import { describe, it } from 'bun:test';
import type { Instant } from '@ferretry/std';
import should from 'should';
import type { AuthorizedOutcome } from '@ferretry/core-vault/contract';
import { builtInPresets } from '../../../daemon/lib/presets/catalog.ts';
import type { ProviderPreset } from '../../../daemon/lib/presets/schema.ts';
import type { Credential } from '../../../daemon/lib/shared/credential.ts';
import type { ProviderProbePlan } from '../../../daemon/lib/provider-probe/plan.ts';
import type { ProviderProbePort } from '../../../daemon/lib/provider-probe/ports.ts';
import { ProviderProbeService } from '../../../daemon/lib/provider-probe/service.ts';
import { CredentialSchema } from '../../support/credential.ts';

const PRESETS = builtInPresets();
const preset = (id: string): ProviderPreset => PRESETS.find(entry => entry.id === id) as ProviderPreset;
const login = (input: Record<string, unknown>): Credential =>
  CredentialSchema.parse({ store: 'environment', ...input });

const DEEPSEEK = login({
  harness: 'claude',
  preset: 'deepseek',
  env: { ANTHROPIC_AUTH_TOKEN: '${secret:DEEPSEEK_API_KEY}' },
});
const DEEPSEEK_LIST = {
  object: 'list',
  data: [
    { id: 'deepseek-chat', object: 'model', owned_by: 'deepseek' },
    { id: 'deepseek-reasoner', object: 'model', owned_by: 'deepseek' },
  ],
};

class Scripted implements ProviderProbePort {
  readonly plans: ProviderProbePlan[] = [];
  constructor(private readonly outcome: AuthorizedOutcome) {}
  async probe(plan: ProviderProbePlan): Promise<AuthorizedOutcome> {
    this.plans.push(plan);
    return this.outcome;
  }
}

function world(outcome: AuthorizedOutcome, onModelList?: (id: string, payload: unknown) => Promise<void>) {
  const heard: { id: string; payload: unknown }[] = [];
  const probe = new Scripted(outcome);
  const service = new ProviderProbeService({
    probe,
    clock: { monotonicMs: () => 0, now: () => '2026-11-23T00:00:00.000Z' as Instant },
    onModelList:
      onModelList ??
      (async (id, payload) => {
        heard.push({ id, payload });
      }),
  });
  return { service, probe, heard };
}

const subject = (id: string, credential: Credential, name: string) => ({ id, credential, preset: preset(name) });

describe('ProviderProbeService model lists', () => {
  it('should hand the body of a Test that IS a model list on, and still answer only with a code and a sentence', async () => {
    // Arrange
    const { service, heard } = world({ kind: 'completion', payload: DEEPSEEK_LIST });

    // Act
    const actual = await service.test(subject('deepseek', DEEPSEEK, 'deepseek'), { allowInference: false });

    // Assert
    should(heard).eql([{ id: 'deepseek', payload: DEEPSEEK_LIST }]);
    should(actual.ok).be.true();
    should(JSON.stringify(actual)).not.containEql('deepseek-chat');
  });

  it('should not hand on the body of a Test that is a key or quota read', async () => {
    // Arrange: OpenRouter's Test reads /api/v1/key, not a model list.
    const credential = login({
      harness: 'claude',
      preset: 'openrouter',
      env: { ANTHROPIC_AUTH_TOKEN: '${secret:OPENROUTER_API_KEY}' },
    });
    const { service, heard } = world({ kind: 'completion', payload: { data: [{ id: 'not-a-model' }] } });

    // Act
    await service.test(subject('or', credential, 'openrouter'), { allowInference: false });

    // Assert
    should(heard).eql([]);
  });

  it('should not hand on the reply of an inference Test', async () => {
    // Arrange
    const credential = login({
      harness: 'claude',
      preset: 'qwen-coding-plan',
      env: {
        ANTHROPIC_BASE_URL: 'https://example.com/apps/anthropic',
        ANTHROPIC_AUTH_TOKEN: '${secret:QWEN_KEY}',
        ANTHROPIC_MODEL: 'qwen3-coder-plus',
      },
    });
    const { service, heard } = world({ kind: 'completion', payload: { data: [{ id: 'x' }] } });

    // Act
    await service.test(subject('q', credential, 'qwen-coding-plan'), { allowInference: true });

    // Assert
    should(heard).eql([]);
  });

  it('should hand nothing on when the provider refused the key', async () => {
    // Arrange
    const { service, heard } = world({ kind: 'status', status: 401 });

    // Act
    const actual = await service.test(subject('deepseek', DEEPSEEK, 'deepseek'), { allowInference: false });

    // Assert
    should(actual.code).equal('rejected');
    should(heard).eql([]);
  });

  it('should answer a Test normally when keeping the list fails', async () => {
    // Arrange
    const { service } = world({ kind: 'completion', payload: DEEPSEEK_LIST }, async () => {
      throw new Error('disk full');
    });

    // Act
    const actual = await service.test(subject('deepseek', DEEPSEEK, 'deepseek'), { allowInference: false });

    // Assert
    should(actual.code).equal('ok');
  });

  it('should read the model list with one free keyed request, and return the body only to its caller', async () => {
    // Arrange
    const { service, probe, heard } = world({ kind: 'completion', payload: DEEPSEEK_LIST });

    // Act
    const actual = await service.listModels(subject('deepseek', DEEPSEEK, 'deepseek'));

    // Assert
    should(actual).eql({ payload: DEEPSEEK_LIST });
    should(probe.plans).have.length(1);
    should(probe.plans[0]?.kind).equal('authorized');
    should(probe.plans[0]?.spends).equal('nothing');
    should(heard).eql([]);
  });

  it('should say "failed", and keep nothing, for an error status, a timeout or an unreadable body', async () => {
    for (const outcome of [
      { kind: 'status', status: 500 },
      { kind: 'status', status: 401 },
      { kind: 'timeout' },
      { kind: 'unreachable' },
      { kind: 'oversized' },
      { kind: 'unreadable' },
      { kind: 'secret_missing' },
    ] as const) {
      should(await world(outcome).service.listModels(subject('deepseek', DEEPSEEK, 'deepseek'))).equal('failed');
    }
  });

  it('should have no model list to read for a login whose Test is not one: nothing is sent', async () => {
    // Arrange
    const openrouter = login({ harness: 'claude', preset: 'openrouter', env: { ANTHROPIC_AUTH_TOKEN: '${secret:K}' } });
    const noPreset = { id: 'x', credential: DEEPSEEK, preset: undefined };
    const signIn = {
      id: 's',
      credential: CredentialSchema.parse({ store: 'ferretry', harness: 'claude' }),
      preset: undefined,
    };
    const { service, probe } = world({ kind: 'completion', payload: DEEPSEEK_LIST });

    // Act / Assert
    should(await service.listModels(subject('or', openrouter, 'openrouter'))).be.undefined();
    should(await service.listModels(noPreset)).be.undefined();
    should(await service.listModels(signIn)).be.undefined();
    should(probe.plans).eql([]);
  });

  it('should never put a key, a header or a secret name in what it hands on', async () => {
    // Arrange
    const { service, heard } = world({ kind: 'completion', payload: DEEPSEEK_LIST });

    // Act
    await service.test(subject('deepseek', DEEPSEEK, 'deepseek'), { allowInference: false });

    // Assert
    should(JSON.stringify(heard)).not.containEql('DEEPSEEK_API_KEY');
    should(JSON.stringify(heard)).not.containEql('authorization');
  });
});
