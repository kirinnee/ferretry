import { describe, it } from 'bun:test';
import { builtInPresets, type Credential, CredentialSchema, type ProviderPreset } from '@ferretry/fleet';
import { FleetCredentialTestResultSchema } from '@ferretry/protocol';
import should from 'should';
import type { ProviderProbePlan } from '../../../src/lib/provider-probe/plan.ts';
import type { ProviderProbePort } from '../../../src/lib/provider-probe/ports.ts';
import { ProviderProbeService, probeCode } from '../../../src/lib/provider-probe/service.ts';
import type { AuthorizedOutcome } from '../../../src/lib/speedups/ports.ts';

const PRESETS = builtInPresets();
const preset = (id: string): ProviderPreset => PRESETS.find(entry => entry.id === id) as ProviderPreset;
const login = (input: Record<string, unknown>): Credential =>
  CredentialSchema.parse({ store: 'environment', ...input });

/** The fake port: answers from a script and remembers every plan. It never touches the network. */
class ScriptedProbe implements ProviderProbePort {
  readonly plans: ProviderProbePlan[] = [];
  constructor(private readonly outcome: AuthorizedOutcome = { kind: 'completion', payload: { data: [] } }) {}
  async probe(plan: ProviderProbePlan): Promise<AuthorizedOutcome> {
    this.plans.push(plan);
    return this.outcome;
  }
}

const serviceWith = (probe: ScriptedProbe) => {
  let tick = 100;
  return new ProviderProbeService({
    probe,
    clock: { monotonicMs: () => (tick += 25), now: () => '2026-10-16T09:00:00.000Z' },
  });
};

const KIMI = login({ harness: 'claude', preset: 'kimi', env: { ANTHROPIC_AUTH_TOKEN: '${secret:MOONSHOT_API_KEY}' } });

describe('ProviderProbeService', () => {
  it('should prove a key with one free read, and say so in a fixed sentence', async () => {
    // Arrange
    const probe = new ScriptedProbe();

    // Act
    const actual = FleetCredentialTestResultSchema.parse(
      await serviceWith(probe).test(
        { id: 'kimi', credential: KIMI, preset: preset('kimi') },
        { allowInference: false },
      ),
    );

    // Assert
    should(actual).deepEqual({
      credentialId: 'kimi',
      ok: true,
      code: 'ok',
      message: 'The provider accepted this login.',
      spent: 'nothing',
      latencyMs: 25,
      at: '2026-10-16T09:00:00.000Z',
    });
    should(probe.plans).have.length(1);
  });

  it('should send nothing that spends without consent, and one token with it', async () => {
    // Arrange
    const probe = new ScriptedProbe();
    const credential = login({
      harness: 'claude',
      preset: 'qwen-coding-plan',
      env: {
        ANTHROPIC_BASE_URL: 'https://coding-intl.dashscope.aliyuncs.com/apps/anthropic',
        ANTHROPIC_AUTH_TOKEN: '${secret:DASHSCOPE_API_KEY}',
        ANTHROPIC_MODEL: 'qwen3.7-plus',
      },
    });
    const subject = { id: 'qwen', credential, preset: preset('qwen-coding-plan') };

    // Act
    const asked = await serviceWith(probe).test(subject, { allowInference: false });
    const sent = await serviceWith(probe).test(subject, { allowInference: true });

    // Assert
    should(asked).containDeep({ ok: false, code: 'consent_required', spent: 'nothing' });
    should(asked).not.have.property('latencyMs');
    should(sent).containDeep({ ok: true, spent: 'one-token' });
    should(probe.plans).have.length(1);
  });

  it('should spend nothing when the key is missing, and say so', async () => {
    const actual = await serviceWith(new ScriptedProbe({ kind: 'secret_missing' })).test(
      { id: 'kimi', credential: KIMI, preset: preset('kimi') },
      { allowInference: false },
    );
    should(actual).containDeep({ code: 'not_set', spent: 'nothing' });
  });

  it.each([
    [
      'a login that signs in',
      CredentialSchema.parse({ harness: 'claude', store: 'ferretry' }),
      preset('kimi'),
      /Check now/u,
    ],
    ['a login with no preset', KIMI, undefined, /not made from a preset/u],
    [
      'a preset with no Test',
      login({ harness: 'claude', cloudCredential: 'aws-profile:a' }),
      preset('amazon-bedrock'),
      /request signing/u,
    ],
  ])('should not test %s', async (_label, credential, entry, message) => {
    // Arrange
    const probe = new ScriptedProbe();

    // Act
    const actual = await serviceWith(probe).test({ id: 'x', credential, preset: entry }, { allowInference: true });

    // Assert
    should(actual).containDeep({ ok: false, code: 'not_testable', spent: 'nothing' });
    should(actual.message).match(message);
    should(probe.plans).be.empty();
  });
});

describe('probeCode', () => {
  it.each([
    [{ kind: 'completion', payload: {} }, 'ok'],
    [{ kind: 'oversized' }, 'ok'],
    [{ kind: 'unreadable' }, 'malformed'],
    [{ kind: 'secret_missing' }, 'not_set'],
    [{ kind: 'vault_damaged' }, 'vault_damaged'],
    [{ kind: 'timeout' }, 'timeout'],
    [{ kind: 'unreachable' }, 'unreachable'],
    [{ kind: 'refused' }, 'refused'],
    [{ kind: 'status', status: 401 }, 'rejected'],
    [{ kind: 'status', status: 403 }, 'rejected'],
    [{ kind: 'status', status: 429 }, 'rate_limited'],
    [{ kind: 'status', status: 529 }, 'rate_limited'],
    [{ kind: 'status', status: 404 }, 'provider_error'],
  ] as const)('should read %j as %s', (outcome, code) => {
    should(probeCode(outcome as AuthorizedOutcome)).equal(code);
  });
});
