import { describe, it } from 'bun:test';
import { builtInPresets, type Credential, CredentialSchema, type ProviderPreset } from '@ferretry/fleet';
import should from 'should';
import { loginHosts, type ProviderProbePlan, planProviderProbe } from '../../../src/lib/provider-probe/plan.ts';

const PRESETS = builtInPresets();
const preset = (id: string): ProviderPreset => PRESETS.find(entry => entry.id === id) as ProviderPreset;
const login = (input: Record<string, unknown>): Credential =>
  CredentialSchema.parse({ store: 'environment', ...input });

/** The authorized half of a plan, or a failure that names what it got instead. */
const authorized = (plan: ReturnType<typeof planProviderProbe>): Extract<ProviderProbePlan, { kind: 'authorized' }> => {
  if (!('kind' in plan) || plan.kind !== 'authorized')
    throw new Error(`expected an authorized plan, got ${JSON.stringify(plan)}`);
  return plan;
};

describe('planProviderProbe', () => {
  it("should test a key with a free read at the preset's own address, in the provider's header", () => {
    // Act
    const actual = authorized(
      planProviderProbe(
        preset('anthropic-api-key'),
        login({ harness: 'claude', env: { ANTHROPIC_API_KEY: '${secret:ANTHROPIC_API_KEY}' } }),
      ),
    );

    // Assert
    should(actual).deepEqual({
      kind: 'authorized',
      secretName: 'ANTHROPIC_API_KEY',
      hosts: ['api.anthropic.com'],
      spends: 'nothing',
      placement: { header: 'x-api-key' },
      request: {
        method: 'GET',
        url: 'https://api.anthropic.com/v1/models',
        headers: { accept: 'application/json', 'anthropic-version': '2023-06-01' },
        timeoutMs: 10_000,
        maxResponseBytes: 512 * 1_024,
      },
    });
  });

  it('should send a Bearer key by default', () => {
    const actual = authorized(
      planProviderProbe(
        preset('kimi'),
        login({ harness: 'claude', env: { ANTHROPIC_AUTH_TOKEN: '${secret:MOONSHOT_API_KEY}' } }),
      ),
    );
    should(actual.placement).deepEqual({ header: 'authorization', scheme: 'Bearer' });
    should(actual.secretName).equal('MOONSHOT_API_KEY');
  });

  it('should fill a host placeholder with one DNS label and send a one-token inference body', () => {
    // Act
    const actual = authorized(
      planProviderProbe(
        preset('microsoft-foundry-api-key'),
        login({
          harness: 'claude',
          env: {
            ANTHROPIC_FOUNDRY_RESOURCE: 'acme-east',
            ANTHROPIC_FOUNDRY_API_KEY: '${secret:FOUNDRY}',
            ANTHROPIC_DEFAULT_HAIKU_MODEL: 'my "haiku"',
          },
        }),
      ),
    );

    // Assert — the model is JSON-escaped into the body
    should(actual.hosts).deepEqual(['acme-east.services.ai.azure.com']);
    should(actual.spends).equal('one-token');
    should(actual.request.method).equal('POST');
    should(JSON.parse(actual.request.body as string)).deepEqual({
      model: 'my "haiku"',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ping' }],
    });
  });

  it("should send a key to the login's own base URL, never a preset file's new host", () => {
    // Arrange
    const env = { ANTHROPIC_BASE_URL: 'http://localhost:4000/', ANTHROPIC_AUTH_TOKEN: '${secret:LITELLM_API_KEY}' };
    const own = { ...preset('custom-gateway'), origin: 'file' as const };
    const elsewhere = {
      ...own,
      test: {
        ...(own.test as Extract<ProviderPreset['test'], { kind: 'request' }>),
        url: 'https://collector.example/x',
      },
    };

    // Act
    const actual = authorized(planProviderProbe(preset('litellm'), login({ harness: 'claude', env })));
    const fromFile = authorized(planProviderProbe(own, login({ harness: 'claude', env })));
    const refused = planProviderProbe(elsewhere, login({ harness: 'claude', env }));

    // Assert
    should(actual.request.url).equal('http://localhost:4000/v1/models');
    should(actual.hosts).deepEqual(['localhost:4000']);
    should(fromFile.request.url).equal('http://localhost:4000/v1/models');
    should(refused).deepEqual({
      code: 'refused',
      reason:
        'This Test would send the key to collector.example, which is not where this login sends it. Only a built-in preset may name another address.',
    });
  });

  it.each([
    [
      'a base URL that is not one',
      { ANTHROPIC_BASE_URL: 'gateway', ANTHROPIC_AUTH_TOKEN: '${secret:K}' },
      /must be an https/u,
    ],
    [
      'plain http to another machine',
      { ANTHROPIC_BASE_URL: 'http://gw.example', ANTHROPIC_AUTH_TOKEN: '${secret:K}' },
      /must be an https/u,
    ],
    [
      'credentials inside the base URL',
      { ANTHROPIC_BASE_URL: 'https://a:b@gw.example', ANTHROPIC_AUTH_TOKEN: '${secret:K}' },
      /must be an https/u,
    ],
  ])('should refuse %s', (_label, env, reason) => {
    const actual = planProviderProbe(preset('custom-gateway'), login({ harness: 'claude', env }));
    should(actual).have.property('code', 'refused');
    should((actual as { reason: string }).reason).match(reason);
  });

  it('should refuse a host placeholder that is more than a host name', () => {
    const actual = planProviderProbe(
      preset('microsoft-foundry-api-key'),
      login({
        harness: 'claude',
        env: {
          ANTHROPIC_FOUNDRY_RESOURCE: 'evil.example/x',
          ANTHROPIC_FOUNDRY_API_KEY: '${secret:FOUNDRY}',
          ANTHROPIC_DEFAULT_HAIKU_MODEL: 'h',
        },
      }),
    );
    should(actual).deepEqual({
      code: 'refused',
      reason: 'ANTHROPIC_FOUNDRY_RESOURCE must be a plain name — letters, digits and dashes — to Test.',
    });
  });

  it('should refuse a whole-base template that holds another placeholder after it', () => {
    const odd = {
      ...preset('custom-gateway'),
      test: {
        ...(preset('custom-gateway').test as Extract<ProviderPreset['test'], { kind: 'request' }>),
        url: '{ANTHROPIC_BASE_URL}/{ANTHROPIC_MODEL}',
      },
    };
    const actual = planProviderProbe(
      odd,
      login({
        harness: 'claude',
        env: { ANTHROPIC_BASE_URL: 'https://gw.example', ANTHROPIC_MODEL: 'm', ANTHROPIC_AUTH_TOKEN: '${secret:K}' },
      }),
    );
    should(actual).deepEqual({ code: 'refused', reason: 'This preset’s Test address cannot be built.' });
  });

  it.each([
    [
      'a value it needs is empty',
      { ANTHROPIC_AUTH_TOKEN: '${secret:K}' },
      'Fill in ANTHROPIC_BASE_URL first, then Test.',
    ],
    [
      'it has no key',
      { ANTHROPIC_BASE_URL: 'https://gw.example' },
      'This login has no ANTHROPIC_AUTH_TOKEN, so there is no key to Test.',
    ],
    [
      'its key is wrapped in a template',
      { ANTHROPIC_BASE_URL: 'https://gw.example', ANTHROPIC_AUTH_TOKEN: 'Bearer ${secret:K}' },
      'ANTHROPIC_AUTH_TOKEN is not a single ${secret:NAME}, so the Test cannot tell which key it is.',
    ],
  ])('should not test a login when %s', (_label, env, reason) => {
    should(planProviderProbe(preset('custom-gateway'), login({ harness: 'claude', env }))).deepEqual({
      code: 'not_testable',
      reason,
    });
  });

  it('should ask for the model a one-token Test sends to', () => {
    should(
      planProviderProbe(
        preset('qwen-coding-plan'),
        login({
          harness: 'claude',
          env: {
            ANTHROPIC_BASE_URL: 'https://coding-intl.dashscope.aliyuncs.com/apps/anthropic',
            ANTHROPIC_AUTH_TOKEN: '${secret:K}',
          },
        }),
      ),
    ).deepEqual({ code: 'not_testable', reason: 'Fill in ANTHROPIC_MODEL first, then Test.' });
  });

  it('should say why a preset with no Test has none', () => {
    should(
      planProviderProbe(preset('amazon-bedrock'), login({ harness: 'claude', cloudCredential: 'aws-profile:acme' })),
    ).have.property('code', 'not_testable');
  });

  it('should read a local server with no key, and refuse a keyless read anywhere else', () => {
    // Arrange
    const ollama = preset('ollama-codex');
    const remote = { ...ollama, test: { kind: 'local' as const, url: 'http://models.example/api/tags', note: 'x' } };
    const credential = login({ harness: 'codex', codexProvider: { id: 'ollama' } });

    // Act + Assert
    should(planProviderProbe(ollama, credential)).containDeep({
      kind: 'local',
      spends: 'nothing',
      request: { method: 'GET', url: 'http://localhost:11434/api/tags' },
    });
    should(planProviderProbe(remote, credential)).deepEqual({
      code: 'refused',
      reason: 'A test without a key may only read a server on this machine.',
    });
  });
});

describe('loginHosts', () => {
  it('should list the hosts of the URL-valued plain values only', () => {
    should([
      ...loginHosts({
        A: 'https://API.example.com/v1',
        B: 'http://localhost:4000',
        C: 'http://far.example',
        D: '${secret:X}',
        E: 'plain',
      }),
    ]).deepEqual(['api.example.com', 'localhost:4000']);
  });
});
