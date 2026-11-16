import { describe, it } from 'bun:test';
import should from 'should';
import { ProviderPresetFileSchema } from '../../../daemon/lib/presets/schema.ts';

const KEY = { secretName: 'GATEWAY_KEY' };
const URL_VALUE = { value: 'https://gateway.example.test' };
const PROVIDER = { id: 'gw', name: 'Gateway', baseUrl: 'https://gateway.example.test/v1' };

/** A preset in the one-CLI shape that passes every rule; each test breaks exactly one thing. */
const preset = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  label: 'Gateway',
  summary: 'A gateway.',
  docs: 'https://docs.example.test',
  verified: '2026-10-18',
  harness: 'claude',
  env: { ANTHROPIC_BASE_URL: URL_VALUE, ANTHROPIC_AUTH_TOKEN: KEY },
  test: {
    kind: 'request',
    url: 'https://gateway.example.test/models',
    keyVariable: 'ANTHROPIC_AUTH_TOKEN',
    note: 'Lists models.',
  },
  quota: { source: 'none', note: 'Not measured.' },
  ...overrides,
});

const issues = (value: unknown): { path: string; message: string }[] => {
  const result = ProviderPresetFileSchema.safeParse(value);
  return result.success
    ? []
    : result.error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message }));
};

describe('a preset variable is a plain value or a secret, never both and never neither', () => {
  const variableIssues = (variable: unknown) =>
    issues(preset({ env: { ANTHROPIC_BASE_URL: URL_VALUE, ANTHROPIC_AUTH_TOKEN: variable } })).map(
      issue => issue.message,
    );
  const RULE = 'a preset variable is exactly one of "value" (a plain value) or "secretName" (a secret name)';

  it('should accept either alone', () => {
    should(issues(preset())).eql([]);
  });

  it('should refuse a variable that is both, and one that is neither', () => {
    should(variableIssues({ value: 'x', secretName: 'GATEWAY_KEY' })).containEql(RULE);
    should(variableIssues({})).containEql(RULE);
  });
});

describe('a preset is for one CLI, or has halves, and the fields keep to their shape', () => {
  it('should accept a preset in the halves shape', () => {
    should(
      issues(
        preset({
          harness: undefined,
          env: undefined,
          claude: { env: { ANTHROPIC_AUTH_TOKEN: KEY } },
          codex: { env: { OPENAI_API_KEY: { secretName: 'GATEWAY_KEY' } } },
        }),
      ),
    ).eql([]);
  });

  it('should say which CLI the preset is for when it has neither a harness nor halves', () => {
    should(issues(preset({ harness: undefined }))).eql([
      {
        path: 'harness',
        message: 'say which CLI the preset is for: "harness: claude|codex", or "claude:" / "codex:" halves',
      },
    ]);
  });

  it('should keep the one-CLI fields out of a preset that has halves, naming each', () => {
    const found = issues(
      preset({
        claude: { env: { ANTHROPIC_AUTH_TOKEN: KEY } },
        codexProvider: PROVIDER,
        models: ['m'],
      }),
    );
    for (const field of ['harness', 'env', 'codexProvider', 'models']) {
      should(found).containEql({
        path: field,
        message: `"${field}" belongs inside "claude:" or "codex:" when the preset has halves`,
      });
    }
  });

  it('should keep a Codex provider to a Codex preset, and to the codex half', () => {
    should(issues(preset({ codexProvider: PROVIDER }))).containEql({
      path: 'codexProvider',
      message: '"codexProvider" belongs only to a Codex preset',
    });
    should(
      issues(
        preset({
          harness: undefined,
          env: undefined,
          claude: { env: { ANTHROPIC_AUTH_TOKEN: KEY }, codexProvider: PROVIDER },
        }),
      ),
    ).containEql({ path: 'claude.codexProvider', message: '"codexProvider" belongs in "codex:", not "claude:"' });
  });
});

describe('a preset’s test sends the key from a variable that is a secret', () => {
  it('should refuse a test whose key variable is not made a secret, for a request and an inference alike', () => {
    const message = 'the test sends the key in ANTHROPIC_AUTH_TOKEN, so "env" must make ANTHROPIC_AUTH_TOKEN a secret';
    should(issues(preset({ env: { ANTHROPIC_AUTH_TOKEN: { value: 'x' } } }))).containEql({
      path: 'test.keyVariable',
      message,
    });
    should(
      issues(
        preset({
          env: { ANTHROPIC_AUTH_TOKEN: { value: 'x' } },
          test: {
            kind: 'inference',
            url: 'https://gateway.example.test/messages',
            keyVariable: 'ANTHROPIC_AUTH_TOKEN',
            note: 'Sends one token.',
            body: '{"max_tokens":1}',
          },
        }),
      ),
    ).containEql({ path: 'test.keyVariable', message });
  });

  it('should not ask for a secret when no key is sent', () => {
    should(
      issues(
        preset({
          env: { ANTHROPIC_BASE_URL: URL_VALUE },
          test: { kind: 'none', reason: 'Nothing to test.' },
        }),
      ),
    ).eql([]);
  });
});

describe('one secret name across halves', () => {
  it('should refuse a name that is a secret in one half and a plain value in the other', () => {
    should(
      issues(
        preset({
          harness: undefined,
          env: undefined,
          claude: { env: { SHARED_KEY: KEY, ANTHROPIC_AUTH_TOKEN: KEY } },
          codex: { env: { SHARED_KEY: { value: 'plain' } } },
        }),
      ),
    ).containEql({
      path: 'codex.env.SHARED_KEY',
      message: 'SHARED_KEY is a secret in one half and a plain value in the other',
    });
  });

  it('should accept halves that agree', () => {
    should(
      issues(
        preset({
          harness: undefined,
          env: undefined,
          claude: { env: { SHARED_KEY: KEY, ANTHROPIC_AUTH_TOKEN: KEY } },
          codex: { env: { SHARED_KEY: KEY } },
        }),
      ),
    ).eql([]);
  });
});
