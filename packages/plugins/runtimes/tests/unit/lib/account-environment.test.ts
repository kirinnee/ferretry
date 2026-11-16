import { describe, expect, it } from 'bun:test';
import {
  CloudCredentialSchema,
  CodexProviderSchema,
  cloudCredentialEnvironment,
  cloudCredentialSentence,
  cloudCredentialVariable,
  codexProviderArgs,
  codexProviderModelArgs,
  parseCloudCredential,
  templatePlaceholders,
} from '../../../daemon/lib/account/environment.ts';

describe('cloud credential references', () => {
  it('reads each of the four spellings', () => {
    expect(parseCloudCredential('azure-cli')).toEqual({ kind: 'azure-cli' });
    expect(parseCloudCredential('gcloud-adc')).toEqual({ kind: 'gcloud-adc' });
    expect(parseCloudCredential('aws-profile:acme-dev')).toEqual({ kind: 'aws-profile', profile: 'acme-dev' });
    expect(parseCloudCredential('gcloud-adc:~/keys/adc.json')).toEqual({
      kind: 'gcloud-adc',
      path: '~/keys/adc.json',
    });
    expect(parseCloudCredential('gcloud-adc:/etc/keys/adc.json')).toEqual({
      kind: 'gcloud-adc',
      path: '/etc/keys/adc.json',
    });
  });

  it('refuses what is not a reference, whatever the string', () => {
    for (const text of [
      '',
      'nonsense',
      'aws-profile:',
      'aws-profile:has space',
      'gcloud-adc:relative/path.json',
      'gcloud-adc:/keys/../etc/shadow',
      'gcloud-adc:/keys/$HOME/adc.json',
      'azure-cli:extra',
      'other:thing',
    ]) {
      expect(parseCloudCredential(text)).toBeUndefined();
    }
  });

  it('says in the schema message what a reference looks like', () => {
    expect(CloudCredentialSchema.safeParse('azure-cli').success).toBe(true);
    const bad = CloudCredentialSchema.safeParse('nope');
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.message).toContain('"nope" is not a cloud credential reference');
  });

  it('names the variable only for the references that are handed over as one', () => {
    expect(cloudCredentialVariable({ kind: 'aws-profile', profile: 'p' })).toBe('AWS_PROFILE');
    expect(cloudCredentialVariable({ kind: 'gcloud-adc', path: '/k.json' })).toBe('GOOGLE_APPLICATION_CREDENTIALS');
    expect(cloudCredentialVariable({ kind: 'gcloud-adc' })).toBeUndefined();
    expect(cloudCredentialVariable({ kind: 'azure-cli' })).toBeUndefined();
  });

  it('hands the CLI a name or a path, and nothing for the default credentials', () => {
    expect(cloudCredentialEnvironment({ kind: 'aws-profile', profile: 'acme' }, '/home/p')).toEqual({
      AWS_PROFILE: 'acme',
    });
    expect(cloudCredentialEnvironment({ kind: 'gcloud-adc', path: '~/keys/adc.json' }, '/home/p//')).toEqual({
      GOOGLE_APPLICATION_CREDENTIALS: '/home/p/keys/adc.json',
    });
    expect(cloudCredentialEnvironment({ kind: 'gcloud-adc', path: '/abs/adc.json' }, '/home/p')).toEqual({
      GOOGLE_APPLICATION_CREDENTIALS: '/abs/adc.json',
    });
    expect(cloudCredentialEnvironment({ kind: 'gcloud-adc' }, '/home/p')).toEqual({});
    expect(cloudCredentialEnvironment({ kind: 'azure-cli' }, '/home/p')).toEqual({});
  });

  it('puts each reference in words', () => {
    expect(cloudCredentialSentence({ kind: 'aws-profile', profile: 'acme-dev' })).toBe(
      'your AWS profile acme-dev on this machine',
    );
    expect(cloudCredentialSentence({ kind: 'gcloud-adc' })).toContain('application-default credentials');
    expect(cloudCredentialSentence({ kind: 'gcloud-adc', path: '/k.json' })).toBe(
      'the Google credentials file /k.json on this machine',
    );
    expect(cloudCredentialSentence({ kind: 'azure-cli' })).toContain('az login');
  });
});

describe('Codex model providers', () => {
  const issuesOf = (value: unknown) => {
    const result = CodexProviderSchema.safeParse(value);
    return result.success ? [] : result.error.issues;
  };

  it('lists the placeholders a template names once each, in order', () => {
    expect(templatePlaceholders('https://{REGION}.x/{TENANT}/{REGION}')).toEqual(['REGION', 'TENANT']);
    expect(templatePlaceholders('https://plain.example')).toEqual([]);
  });

  it('accepts one of Codex’s own providers named alone, and refuses extras on it', () => {
    expect(issuesOf({ id: 'openai' })).toEqual([]);
    expect(issuesOf({ id: 'ollama', model: 'llama' })).toEqual([]);
    for (const extra of [{ baseUrl: 'https://x.test' }, { name: 'Mine' }, { queryParams: { a: 'b' } }]) {
      const [issue] = issuesOf({ id: 'openai', ...extra });
      expect(issue?.message).toContain("is one of Codex's own providers");
      expect(issue?.path).toEqual(['id']);
    }
  });

  it('asks a provider of your own for a name and a base URL, pointing at the one that is missing', () => {
    const noName = issuesOf({ id: 'azure', baseUrl: 'https://x.test' });
    expect(noName[0]?.path).toEqual(['name']);
    expect(noName[0]?.message).toContain('needs a "name" and a "baseUrl"');
    const noUrl = issuesOf({ id: 'azure', name: 'Azure' });
    expect(noUrl[0]?.path).toEqual(['baseUrl']);
  });

  it('only lets a key travel to https, or plain http on this machine', () => {
    expect(issuesOf({ id: 'azure', name: 'Azure', baseUrl: 'https://{RESOURCE}.openai.azure.com/v1' })).toEqual([]);
    expect(issuesOf({ id: 'local', name: 'Local', baseUrl: 'http://127.0.0.1:8080/v1' })).toEqual([]);
    for (const baseUrl of ['http://example.com/v1', 'not a url', 'ftp://example.com']) {
      const [issue] = issuesOf({ id: 'azure', name: 'Azure', baseUrl });
      expect(issue?.path).toEqual(['baseUrl']);
      expect(issue?.message).toContain('must be https://');
    }
  });

  const provider = CodexProviderSchema.parse({
    id: 'azure',
    name: 'Azure',
    baseUrl: 'https://{RESOURCE}.openai.azure.com/v1',
    keyVariable: 'AZURE_KEY',
    queryParams: { 'api-version': '2025-01-01', 'a.b': 'z' },
  });

  it('builds the launch flags, filling placeholders from the login’s variables and sorting query parameters', () => {
    const result = codexProviderArgs(provider, { RESOURCE: 'acme-east' });
    expect(result).toEqual({
      args: [
        '-c',
        'model_providers.azure.name="Azure"',
        '-c',
        'model_providers.azure.base_url="https://acme-east.openai.azure.com/v1"',
        '-c',
        'model_providers.azure.env_key="AZURE_KEY"',
        '-c',
        'model_providers.azure.wire_api="responses"',
        '-c',
        'model_providers.azure.query_params."a.b"="z"',
        '-c',
        'model_providers.azure.query_params.api-version="2025-01-01"',
        '-c',
        'model_provider="azure"',
      ],
    });
  });

  it('names the placeholders the login does not set plainly, and refuses a value that is not a host name', () => {
    expect(codexProviderArgs(provider, {})).toEqual({
      problem: expect.stringContaining('needs RESOURCE set to a plain host name'),
    });
    expect(codexProviderArgs(provider, { RESOURCE: 'evil/../x' })).toHaveProperty('problem');
  });

  it('only selects a provider that has no URL of its own, and omits the key line when it has no key variable', () => {
    expect(codexProviderArgs({ id: 'openai' }, {})).toEqual({ args: ['-c', 'model_provider="openai"'] });
    const keyless = codexProviderArgs({ id: 'local', baseUrl: 'http://localhost:1/v1' }, {});
    expect('args' in keyless && keyless.args.join(' ')).not.toContain('env_key');
    expect('args' in keyless && keyless.args).toContain('model_providers.local.name="local"');
  });

  it('starts a runtime on the provider’s model', () => {
    expect(codexProviderModelArgs('gpt-x')).toEqual(['-c', 'model="gpt-x"']);
  });
});
