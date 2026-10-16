import { describe, it } from 'bun:test';
import should from 'should';
import {
  CloudCredentialSchema,
  CodexProviderSchema,
  cloudCredentialEnvironment,
  cloudCredentialSentence,
  cloudCredentialVariable,
  codexProviderArgs,
  codexProviderModelArgs,
  isCredentialSafeUrl,
  parseCloudCredential,
  templatePlaceholders,
} from '../../src/lib/account/environment.ts';

const HOME = '/people/placeholder';

describe('parseCloudCredential', () => {
  it.each([
    ['aws-profile:acme-dev', { kind: 'aws-profile', profile: 'acme-dev' }],
    ['aws-profile:a.b+c=d,e@f_g', { kind: 'aws-profile', profile: 'a.b+c=d,e@f_g' }],
    ['gcloud-adc', { kind: 'gcloud-adc' }],
    ['gcloud-adc:/etc/gcp/key.json', { kind: 'gcloud-adc', path: '/etc/gcp/key.json' }],
    ['gcloud-adc:~/.config/gcloud/adc.json', { kind: 'gcloud-adc', path: '~/.config/gcloud/adc.json' }],
    ['azure-cli', { kind: 'azure-cli' }],
  ])('should read %s', (text, expected) => {
    should(parseCloudCredential(text)).deepEqual(expected);
  });

  it.each([
    'aws-profile:',
    'aws-profile:has space',
    'aws-profile:[x]',
    'gcloud-adc:relative/key.json',
    'gcloud-adc:/a/../b.json',
    'gcloud-adc:/a/$HOME.json',
    'azure',
    'azure-cli:me',
    'unknown:thing',
    '',
  ])('should refuse %p', text => {
    should(parseCloudCredential(text)).be.undefined();
  });

  it('should say how to write one when a schema reads something else', () => {
    // Act
    const actual = CloudCredentialSchema.safeParse('aws:me');

    // Assert
    should(actual.success).be.false();
    should(actual.error?.issues[0]?.message).match(/aws-profile:<profile>, gcloud-adc/u);
    should(CloudCredentialSchema.safeParse('azure-cli').success).be.true();
  });
});

describe('cloudCredentialEnvironment', () => {
  it('should hand an AWS profile over by NAME', () => {
    const reference = { kind: 'aws-profile', profile: 'acme' } as const;
    should(cloudCredentialEnvironment(reference, HOME)).deepEqual({ AWS_PROFILE: 'acme' });
    should(cloudCredentialVariable(reference)).equal('AWS_PROFILE');
  });

  it('should hand a Google credentials file over by PATH, expanding the home', () => {
    should(cloudCredentialEnvironment({ kind: 'gcloud-adc', path: '~/adc.json' }, `${HOME}/`)).deepEqual({
      GOOGLE_APPLICATION_CREDENTIALS: `${HOME}/adc.json`,
    });
    should(cloudCredentialEnvironment({ kind: 'gcloud-adc', path: '/etc/adc.json' }, HOME)).deepEqual({
      GOOGLE_APPLICATION_CREDENTIALS: '/etc/adc.json',
    });
    should(cloudCredentialVariable({ kind: 'gcloud-adc', path: '/etc/adc.json' })).equal(
      'GOOGLE_APPLICATION_CREDENTIALS',
    );
  });

  it('should hand over nothing for the default credentials the cloud SDK finds itself', () => {
    should(cloudCredentialEnvironment({ kind: 'gcloud-adc' }, HOME)).deepEqual({});
    should(cloudCredentialEnvironment({ kind: 'azure-cli' }, HOME)).deepEqual({});
    should(cloudCredentialVariable({ kind: 'gcloud-adc' })).be.undefined();
    should(cloudCredentialVariable({ kind: 'azure-cli' })).be.undefined();
  });

  it.each([
    [{ kind: 'aws-profile', profile: 'acme' } as const, /AWS profile acme/u],
    [{ kind: 'gcloud-adc' } as const, /application-default/u],
    [{ kind: 'gcloud-adc', path: '/k.json' } as const, /credentials file \/k\.json/u],
    [{ kind: 'azure-cli' } as const, /az login/u],
  ])('should say %j in words', (reference, expected) => {
    should(cloudCredentialSentence(reference)).match(expected);
  });
});

describe('isCredentialSafeUrl', () => {
  it.each([
    ['https://api.example.com/v1', true],
    ['http://localhost:4000', true],
    ['http://127.0.0.1:11434/v1', true],
    ['http://api.example.com', false],
    ['ftp://localhost', false],
    ['not a url', false],
  ])('should judge %s as %s', (url, expected) => {
    should(isCredentialSafeUrl(url)).equal(expected);
  });
});

describe('templatePlaceholders', () => {
  it('should list each placeholder once, in order', () => {
    should(templatePlaceholders('https://{A}.x/{B}/{A}')).deepEqual(['A', 'B']);
    should(templatePlaceholders('https://x')).deepEqual([]);
  });
});

describe('CodexProviderSchema', () => {
  it("should accept one of Codex's own providers named alone, with a model", () => {
    should(CodexProviderSchema.safeParse({ id: 'ollama', model: 'gpt-oss:20b' }).success).be.true();
  });

  it("should refuse a base URL on one of Codex's own providers", () => {
    const actual = CodexProviderSchema.safeParse({ id: 'openai', baseUrl: 'https://x' });
    should(actual.error?.issues[0]?.message).match(/one of Codex's own providers/u);
  });

  it('should refuse a provider of your own without a name or a base URL', () => {
    should(CodexProviderSchema.safeParse({ id: 'mine', baseUrl: 'https://x' }).error?.issues[0]?.path).deepEqual([
      'name',
    ]);
    should(CodexProviderSchema.safeParse({ id: 'mine', name: 'Mine' }).error?.issues[0]?.path).deepEqual(['baseUrl']);
  });

  it('should refuse a base URL a key would cross a network in the clear to', () => {
    const actual = CodexProviderSchema.safeParse({ id: 'mine', name: 'Mine', baseUrl: 'http://example.com/v1' });
    should(actual.error?.issues[0]?.message).match(/must be https/u);
  });

  it('should accept a placeholder in the host', () => {
    const actual = CodexProviderSchema.safeParse({
      id: 'azure-openai',
      name: 'Azure OpenAI',
      baseUrl: 'https://{RESOURCE}.openai.azure.com/openai/v1',
      keyVariable: 'AZURE_OPENAI_API_KEY',
    });
    should(actual.success).be.true();
  });
});

describe('codexProviderArgs', () => {
  it("should only select one of Codex's own providers, leaving its model to the launch", () => {
    should(codexProviderArgs({ id: 'ollama', model: 'gpt-oss:20b' }, {})).deepEqual({
      args: ['-c', 'model_provider="ollama"'],
    });
    should(codexProviderModelArgs('gpt-oss:20b')).deepEqual(['-c', 'model="gpt-oss:20b"']);
  });

  it('should define a provider of your own key by key, filling its host from the login', () => {
    // Act
    const actual = codexProviderArgs(
      {
        id: 'azure-openai',
        name: 'Azure OpenAI',
        baseUrl: 'https://{RESOURCE}.openai.azure.com/openai/v1',
        keyVariable: 'AZURE_OPENAI_API_KEY',
        queryParams: { 'api-version': '2025-04-01', b: 'x' },
      },
      { RESOURCE: 'acme-east' },
    );

    // Assert
    should(actual).deepEqual({
      args: [
        '-c',
        'model_providers.azure-openai.name="Azure OpenAI"',
        '-c',
        'model_providers.azure-openai.base_url="https://acme-east.openai.azure.com/openai/v1"',
        '-c',
        'model_providers.azure-openai.env_key="AZURE_OPENAI_API_KEY"',
        '-c',
        'model_providers.azure-openai.wire_api="responses"',
        '-c',
        'model_providers.azure-openai.query_params.api-version="2025-04-01"',
        '-c',
        'model_providers.azure-openai.query_params.b="x"',
        '-c',
        'model_provider="azure-openai"',
      ],
    });
  });

  it('should quote a key a bare TOML key cannot spell, and leave the key variable out when there is none', () => {
    // Act
    const actual = codexProviderArgs(
      { id: 'local', name: 'Local', baseUrl: 'http://localhost:8080/v1', queryParams: { 'a.b': '1' } },
      {},
    );

    // Assert
    should(actual).deepEqual({
      args: [
        '-c',
        'model_providers.local.name="Local"',
        '-c',
        'model_providers.local.base_url="http://localhost:8080/v1"',
        '-c',
        'model_providers.local.wire_api="responses"',
        '-c',
        'model_providers.local.query_params."a.b"="1"',
        '-c',
        'model_provider="local"',
      ],
    });
  });

  it('should refuse a host placeholder the login does not set to a plain host name', () => {
    const provider = { id: 'azure-openai', name: 'Azure', baseUrl: 'https://{RESOURCE}.openai.azure.com' };
    should(codexProviderArgs(provider, {})).deepEqual({
      problem: "its Codex provider's base URL needs RESOURCE set to a plain host name in the login's variables",
    });
    should(codexProviderArgs(provider, { RESOURCE: 'evil.com/x?' })).have.property('problem');
  });
});
