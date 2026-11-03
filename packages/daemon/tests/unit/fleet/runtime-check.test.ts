/**
 * Checking a runtime (`lib/fleet/runtime-check.ts`): one start probe through the probe cache, answered
 * with a code and a sentence built from plain facts — never from what the CLI printed.
 */
import { describe, it } from 'bun:test';
import { type Credential, parseAccountModel } from '@ferretry/fleet';
import { FleetRuntimeCheckResultSchema } from '@ferretry/protocol';
import should from 'should';
import {
  checkSentence,
  loginFacts,
  RUNTIME_CHECK_TIMEOUT_MS,
  RuntimeCheckRefusal,
  RuntimeCheckService,
  type RuntimeCheckTarget,
} from '../../../src/lib/fleet/runtime-check.ts';
import type { PackProbeOutcome, PackProbeRequest } from '../../../src/lib/pack/probe.ts';

const TARGET: RuntimeCheckTarget = {
  id: 'rt-1',
  name: 'claude-bedrock',
  wrapper: 'claude-bedrock',
  harness: 'claude',
  credential: 'claude-bedrock',
  defaultModel: 'claude-sonnet-5-5',
  disabled: false,
};

const BEDROCK = { provider: 'Amazon Bedrock', region: 'us-east-1', profile: 'work' } as const;

/** What a CLI might print on failure: it must never reach the answer. */
const LEAK = 'Authorization: Bearer sk-ant-api03-leaked-value https://user:pw@gw.example';

function service(outcome: PackProbeOutcome, target: RuntimeCheckTarget | undefined = TARGET) {
  const probes: { request: PackProbeRequest; ttlMs: number }[] = [];
  const check = new RuntimeCheckService({
    runtime: async id => (target !== undefined && (id === target.id || id === target.name) ? target : undefined),
    login: async () => BEDROCK,
    probe: async (request, ttlMs) => {
      probes.push({ request, ttlMs });
      return { outcome, cached: false };
    },
    passTtlMs: async () => 600_000,
    cwd: '/tmp/check',
  });
  return { check, probes };
}

const failed = (extra: Partial<Extract<PackProbeOutcome, { ok: false }>>): PackProbeOutcome => ({
  ok: false,
  ms: 1_234,
  reason: LEAK,
  ...extra,
});

describe('RuntimeCheckService', () => {
  it('should run the start probe on the runtime’s own default model, 30 s at most, keeping a pass as Pack does', async () => {
    // Arrange
    const { check, probes } = service({ ok: true, ms: 2_412 });

    // Act
    const actual = await check.check('rt-1');

    // Assert
    should(FleetRuntimeCheckResultSchema.parse(actual)).deepEqual({
      ok: true,
      ms: 2_412,
      sentence: 'claude-bedrock answered through Amazon Bedrock (us-east-1) in 2.4 s.',
    });
    should(probes).deepEqual([
      {
        request: {
          wrapper: 'claude-bedrock',
          harness: 'claude',
          model: 'claude-sonnet-5-5',
          cwd: '/tmp/check',
          timeoutMs: RUNTIME_CHECK_TIMEOUT_MS,
        },
        ttlMs: 600_000,
      },
    ]);
  });

  it('should find a runtime by its name as well as its id', async () => {
    const { check } = service({ ok: true, ms: 10 });
    should((await check.check('claude-bedrock')).ok).be.true();
  });

  it('should refuse an unknown runtime and a switched-off one, probing neither', async () => {
    // Arrange
    const unknown = service({ ok: true, ms: 1 }, undefined);
    const off = service({ ok: true, ms: 1 }, { ...TARGET, disabled: true });

    // Act
    const missing = await unknown.check.check('nope').catch((error: unknown) => error);
    const disabled = await off.check.check('rt-1').catch((error: unknown) => error);

    // Assert
    should(missing).be.instanceOf(RuntimeCheckRefusal);
    should((missing as RuntimeCheckRefusal).code).equal('fleet_runtime_unknown');
    should((disabled as RuntimeCheckRefusal).code).equal('fleet_runtime_disabled');
    should(unknown.probes.length + off.probes.length).equal(0);
  });

  const cases: readonly [string, Partial<Extract<PackProbeOutcome, { ok: false }>>, string, string][] = [
    [
      'model_unavailable',
      { code: 'model_unavailable', stage: 'exit' },
      'model_unavailable',
      'Amazon Bedrock refused the model claude-sonnet-5-5 in us-east-1.',
    ],
    [
      'not_logged_in',
      { code: 'not_logged_in', stage: 'exit' },
      'not_logged_in',
      'Amazon Bedrock refused profile work.',
    ],
    [
      'out_of_quota',
      { code: 'out_of_quota', stage: 'answer' },
      'out_of_quota',
      'Amazon Bedrock is out of quota or rate-limited.',
    ],
    ['a timeout', { stage: 'timeout' }, 'timed_out', 'No answer in 30 seconds.'],
    [
      'a missing launcher',
      { stage: 'launcher' },
      'not_launchable',
      "Couldn't start claude-bedrock: it isn't ready to launch on this machine.",
    ],
    [
      'a missing secret',
      { stage: 'environment' },
      'not_launchable',
      "Couldn't start claude-bedrock: a secret or variable its login needs is missing.",
    ],
    [
      'a CLI that cannot run',
      { stage: 'spawn' },
      'not_launchable',
      "Couldn't start claude-bedrock: its CLI could not be run.",
    ],
    ['an exit with no known cause', { stage: 'exit' }, 'no_answer', 'claude-bedrock stopped without answering.'],
    ['an answer that is not OK', { stage: 'answer' }, 'no_answer', 'claude-bedrock answered, but not with OK.'],
  ];
  for (const [what, outcome, code, sentence] of cases) {
    it(`should answer ${what} with its code and a sentence of plain facts, never the CLI's words`, async () => {
      // Arrange
      const { check } = service(failed(outcome));

      // Act
      const actual = FleetRuntimeCheckResultSchema.parse(await check.check('rt-1'));

      // Assert
      should(actual).deepEqual({ ok: false, ms: 1_234, code, sentence });
      should(JSON.stringify(actual)).not.containEql('leaked');
      should(JSON.stringify(actual)).not.containEql('pw@');
    });
  }
});

describe('checkSentence', () => {
  it('should name a key by its NAME, and a sign-in runtime by its own name', () => {
    // Act + Assert
    should(
      checkSentence(TARGET, { provider: 'OpenRouter', key: 'OPENROUTER_API_KEY' }, failed({ code: 'not_logged_in' })),
    ).equal('OpenRouter refused the key in OPENROUTER_API_KEY.');
    should(checkSentence({ name: 'claude-default' }, {}, failed({ code: 'not_logged_in' }))).equal(
      "claude-default isn't signed in, or its sign-in was refused.",
    );
    should(checkSentence({ name: 'claude-default' }, {}, failed({ code: 'model_unavailable' }))).equal(
      "claude-default's login can't use the model.",
    );
    should(checkSentence({ name: 'claude-default' }, {}, { ok: true, ms: 900 })).equal(
      'claude-default answered in 0.9 s.',
    );
  });
});

describe('loginFacts', () => {
  const presets = [
    { id: 'amazon-bedrock', label: 'Amazon Bedrock (AWS profile)' },
    { id: 'openrouter', label: 'OpenRouter' },
  ];
  const model = parseAccountModel({
    version: 2,
    credentials: {
      bedrock: {
        harness: 'claude',
        store: 'environment',
        preset: 'amazon-bedrock',
        env: { CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'us-east-1' },
        cloudCredential: 'aws-profile:work',
      },
      router: {
        harness: 'claude',
        store: 'environment',
        preset: 'openrouter',
        env: { ANTHROPIC_AUTH_TOKEN: '${secret:OPENROUTER_API_KEY}', AWS_REGION: '${secret:NOT_A_REGION}' },
      },
      you: { harness: 'claude', store: 'host' },
    },
  });

  it('should read the label, a plain region, a profile name and a secret name, and nothing for a sign-in', () => {
    should(loginFacts(model.credentials.bedrock as Credential, 'claude', presets)).deepEqual({
      provider: 'Amazon Bedrock (AWS profile)',
      region: 'us-east-1',
      profile: 'work',
    });
    should(loginFacts(model.credentials.router as Credential, 'claude', presets)).deepEqual({
      provider: 'OpenRouter',
      key: 'OPENROUTER_API_KEY',
    });
    should(loginFacts(model.credentials.you as Credential, 'claude', presets)).deepEqual({});
    should(loginFacts(undefined, 'claude', presets)).deepEqual({});
  });
});
