import { describe, expect, it } from 'bun:test';
import type { ProviderPresetView } from '../../../contract/index.ts';
import {
  alsoMatchedSentence,
  CUSTOM_GATEWAY,
  detectTable,
  detectionSentence,
  pasteTarget,
  prefillFrom,
  readPaste,
  withheldSentence,
} from '../../../app/lib/paste-model.ts';

/** One offered preset, shaped as the wire sends it. */
const preset = (overrides: Partial<ProviderPresetView> & { readonly id: string }): ProviderPresetView => ({
  label: overrides.id,
  harness: 'claude-code',
  summary: 'A provider.',
  docs: 'https://docs.example.test',
  origin: 'built-in',
  variables: [],
  models: [],
  test: { available: true, spends: 'nothing', note: 'Free.' },
  quota: { source: 'none', note: 'n/a' },
  unverified: [],
  verified: '2026-10-16',
  offered: { available: true },
  halves: [{ harness: 'claude-code', offered: { available: true }, models: [] }],
  ...overrides,
});

const ZAI = preset({
  id: 'zai-glm',
  label: 'GLM / Z.ai',
  variables: [
    { name: 'ANTHROPIC_BASE_URL', kind: 'plain', required: true, allowEmpty: false, harnesses: ['claude-code'] },
    {
      name: 'ANTHROPIC_AUTH_TOKEN',
      kind: 'secret',
      secret: 'ZAI_API_KEY',
      required: true,
      allowEmpty: false,
      harnesses: ['claude-code'],
    },
  ],
  detect: { hosts: ['api.z.ai'], variables: ['ZAI_API_KEY'], keyPrefixes: [] },
});

const DEEPSEEK = preset({
  id: 'deepseek',
  label: 'DeepSeek',
  variables: [
    { name: 'DEEPSEEK_API_KEY', kind: 'secret', required: true, allowEmpty: false, harnesses: ['claude-code'] },
  ],
  detect: { hosts: ['api.deepseek.com'], variables: ['DEEPSEEK_*'], keyPrefixes: [] },
});

const GATEWAY = preset({
  id: CUSTOM_GATEWAY,
  label: 'Custom gateway',
  variables: [
    { name: 'ANTHROPIC_BASE_URL', kind: 'plain', required: true, allowEmpty: false, harnesses: ['claude-code'] },
    {
      name: 'ANTHROPIC_AUTH_TOKEN',
      kind: 'secret',
      secret: 'GATEWAY_API_KEY',
      required: true,
      allowEmpty: false,
      harnesses: ['claude-code'],
    },
  ],
});

const CATALOG = [ZAI, DEEPSEEK, GATEWAY];

describe('prefillFrom', () => {
  it('fills a plain value by variable name, and a secret by its variable or its secret NAME', () => {
    const actual = prefillFrom(ZAI, {
      ANTHROPIC_BASE_URL: 'https://api.z.ai/api/paas/v4',
      ZAI_API_KEY: 'the-pasted-key',
    });
    expect(actual.values).toEqual({ ANTHROPIC_BASE_URL: 'https://api.z.ai/api/paas/v4' });
    expect(actual.secrets).toEqual(['ZAI_API_KEY']);
    expect(JSON.stringify(actual)).not.toContain('the-pasted-key');
  });

  it('leaves a variable the preset does not name behind, and takes no empty secret', () => {
    const actual = prefillFrom(GATEWAY, {
      UNRELATED: 'x',
      ANTHROPIC_AUTH_TOKEN: '',
      GATEWAY_API_KEY: '',
    });
    expect(actual.values).toEqual({});
    expect(actual.secrets).toEqual([]);
  });
});

/** The custom gateway as Logins ships it: ANTHROPIC_API_KEY is a PLAIN variable the preset deliberately leaves empty. */
const REAL_GATEWAY = preset({
  id: CUSTOM_GATEWAY,
  label: 'Custom gateway',
  variables: [
    { name: 'ANTHROPIC_BASE_URL', kind: 'plain', required: true, allowEmpty: false, harnesses: ['claude-code'] },
    {
      name: 'ANTHROPIC_API_KEY',
      kind: 'plain',
      value: '',
      required: true,
      allowEmpty: true,
      harnesses: ['claude-code'],
    },
    {
      name: 'ANTHROPIC_AUTH_TOKEN',
      kind: 'secret',
      secret: 'GATEWAY_API_KEY',
      required: false,
      allowEmpty: false,
      harnesses: ['claude-code'],
    },
  ],
});

describe('prefillFrom — a pasted key never lands in a plain field', () => {
  it('keeps the deliberate empty ANTHROPIC_API_KEY of the real custom gateway, and names it instead of filling it', () => {
    const actual = prefillFrom(REAL_GATEWAY, {
      ANTHROPIC_BASE_URL: 'https://llm.corp.example',
      ANTHROPIC_API_KEY: 'sk-1234',
    });
    expect(actual.values).toEqual({ ANTHROPIC_BASE_URL: 'https://llm.corp.example' });
    expect(actual.withheld).toEqual([{ name: 'ANTHROPIC_API_KEY', reason: 'credential-name' }]);
    expect(JSON.stringify(actual)).not.toContain('sk-1234');
  });

  it('says nothing about an allowEmpty variable that held a harmless value, and still keeps its empty', () => {
    const blank = preset({
      id: 'x',
      variables: [
        {
          name: 'API_TIMEOUT_MS',
          kind: 'plain',
          value: '',
          required: false,
          allowEmpty: true,
          harnesses: ['claude-code'],
        },
      ],
    });
    const actual = prefillFrom(blank, { API_TIMEOUT_MS: '30000' });
    expect(actual.values).toEqual({});
    expect(actual.withheld).toEqual([]);
  });

  it('does not take an address with a user and password, nor one with a query string', () => {
    const userinfo = prefillFrom(REAL_GATEWAY, { ANTHROPIC_BASE_URL: 'https://bob:hunter2pass@llm.corp.example' });
    expect(userinfo.values).toEqual({});
    expect(userinfo.withheld).toEqual([{ name: 'ANTHROPIC_BASE_URL', reason: 'url-userinfo' }]);
    expect(JSON.stringify(userinfo)).not.toContain('hunter2pass');
    const query = prefillFrom(REAL_GATEWAY, { ANTHROPIC_BASE_URL: 'https://llm.corp.example/v1?token=abcdefgh12' });
    expect(query.withheld).toEqual([{ name: 'ANTHROPIC_BASE_URL', reason: 'url-query' }]);
  });

  it('does not take a value with a token shape under a plain, innocently named variable', () => {
    const plain = preset({
      id: 'x',
      variables: [
        { name: 'EXTRA_NOTE', kind: 'plain', required: false, allowEmpty: false, harnesses: ['claude-code'] },
      ],
    });
    const actual = prefillFrom(plain, { EXTRA_NOTE: 'sk-abcdefghijklmnop' });
    expect(actual.values).toEqual({});
    expect(actual.withheld).toEqual([{ name: 'EXTRA_NOTE', reason: 'token-shape' }]);
  });
});

describe('withheldSentence', () => {
  it('is null for nothing, and names variables and the reason, never a value', () => {
    expect(withheldSentence([])).toBeNull();
    expect(withheldSentence([{ name: 'ANTHROPIC_API_KEY', reason: 'credential-name' }])).toBe(
      'ANTHROPIC_API_KEY reads as a key, so it was not filled in: a key is stored in the secret store, never typed into a field.',
    );
    expect(
      withheldSentence([
        { name: 'A_KEY', reason: 'token-shape' },
        { name: 'B_TOKEN', reason: 'credential-name' },
        { name: 'ANTHROPIC_BASE_URL', reason: 'url-userinfo' },
      ]),
    ).toBe(
      'A_KEY, B_TOKEN read as keys, so they were not filled in: a key is stored in the secret store, never typed into a field. ANTHROPIC_BASE_URL carried a user, a password or a query string, so it was not filled in: type the plain address.',
    );
  });
});

describe('withheldSentence — an address alone', () => {
  it('speaks only of the address when no key was withheld, singular and plural', () => {
    expect(withheldSentence([{ name: 'ANTHROPIC_BASE_URL', reason: 'url-query' }])).toBe(
      'ANTHROPIC_BASE_URL carried a user, a password or a query string, so it was not filled in: type the plain address.',
    );
    expect(
      withheldSentence([
        { name: 'A_URL', reason: 'url-userinfo' },
        { name: 'B_URL', reason: 'url-query' },
      ]),
    ).toBe(
      'A_URL, B_URL carried a user, a password or a query string, so they were not filled in: type the plain address.',
    );
  });
});

describe('detectTable', () => {
  it('keeps only the presets that declare clues, as the table detection reads', () => {
    expect(detectTable(CATALOG)).toEqual([
      { id: 'zai-glm', detect: { hosts: ['api.z.ai'], variables: ['ZAI_API_KEY'], keyPrefixes: [] } },
      { id: 'deepseek', detect: { hosts: ['api.deepseek.com'], variables: ['DEEPSEEK_*'], keyPrefixes: [] } },
    ]);
  });
});

describe('readPaste', () => {
  it('reads the block and recognises the provider from the presets’ clues', () => {
    const actual = readPaste(
      CATALOG,
      'export ANTHROPIC_BASE_URL=https://api.z.ai/api/paas/v4\nexport ZAI_API_KEY=sk-zai-secret',
    );
    expect(actual.detection.preset).toBe('zai-glm');
    expect(Object.keys(actual.values)).toEqual(['ANTHROPIC_BASE_URL', 'ZAI_API_KEY']);
    // The key never reaches the recognition, which is names only.
    expect(JSON.stringify(actual.detection)).not.toContain('sk-zai-secret');
  });

  it('reads a Codex TOML table and finds nothing offered for it: a custom gateway', () => {
    const actual = readPaste(
      CATALOG,
      ['[model_providers.ollama]', 'base_url = "http://localhost:11434/v1"', 'env_key = "OLLAMA_API_KEY"', ''].join(
        '\n',
      ),
    );
    expect(actual.detection.preset).toBeUndefined();
    expect(actual.detection.recognised).toEqual(['model_providers.ollama.base_url', 'model_providers.ollama.env_key']);
  });
});

describe('detectionSentence', () => {
  it('names the provider and its clues, the host as the preset wrote it', () => {
    const { detection } = readPaste(CATALOG, 'export ANTHROPIC_BASE_URL=https://api.z.ai/api/paas/v4\nZAI_API_KEY=k');
    expect(detectionSentence(CATALOG, detection)).toBe(
      'Looks like GLM / Z.ai — from ANTHROPIC_BASE_URL (api.z.ai) · ZAI_API_KEY',
    );
  });

  it('says a custom gateway with what was recognised, or that nothing was', () => {
    const some = readPaste(CATALOG, 'GATEWAY_TOKEN=abc').detection;
    expect(detectionSentence(CATALOG, some)).toBe('Custom gateway — recognised: GATEWAY_TOKEN');
    const none = readPaste(CATALOG, 'JUST_A_SENTENCE').detection;
    expect(detectionSentence(CATALOG, none)).toBe('Custom gateway — no variable recognised');
  });
});

describe('alsoMatchedSentence', () => {
  it('is null without a tie, and names the others in the catalogue’s order with one', () => {
    const alone = readPaste(CATALOG, 'export ANTHROPIC_BASE_URL=https://api.z.ai/api/paas/v4').detection;
    expect(alsoMatchedSentence(CATALOG, alone)).toBeNull();
    // DEEPSEEK_API_KEY is a variable clue for deepseek and a KEY name; nothing else scores, so no tie
    // is possible against this table — assert the sentence shape on a hand-made tie instead.
    const tie = {
      preset: 'zai-glm',
      clues: [{ kind: 'variable' as const, variable: 'ZAI_API_KEY' }],
      alsoMatched: ['deepseek'],
      recognised: ['ZAI_API_KEY'],
      harnesses: ['claude' as const],
    };
    expect(alsoMatchedSentence(CATALOG, tie)).toBe('or: DeepSeek');
  });
});

describe('pasteTarget', () => {
  it('continues to the preset recognised when it is offered here', () => {
    const { detection } = readPaste(CATALOG, 'export ANTHROPIC_BASE_URL=https://api.z.ai/api/paas/v4');
    expect(pasteTarget(CATALOG, detection)?.id).toBe('zai-glm');
  });

  it('falls back to the custom gateway when the recognised preset is not offered here', () => {
    const refused = preset({ ...ZAI, id: 'zai-glm', offered: { available: false, reason: 'not here' } });
    const { detection } = readPaste([refused, GATEWAY], 'export ANTHROPIC_BASE_URL=https://api.z.ai/api/paas/v4');
    expect(detection.preset).toBe('zai-glm');
    expect(pasteTarget([refused, GATEWAY], detection)?.id).toBe(CUSTOM_GATEWAY);
  });

  it('offers nothing to continue to when no preset is offered', () => {
    const { detection } = readPaste([], 'A=1');
    expect(pasteTarget([], detection)).toBeUndefined();
  });
});

describe('prefillFrom — R5: one rule with the daemon', () => {
  const key = 'q7Zk'.repeat(10);
  const plain = (name: string) =>
    preset({
      id: 'x',
      variables: [{ name, kind: 'plain', required: false, allowEmpty: false, harnesses: ['claude-code'] }],
    });

  it('withholds a key in a credential-named header, a query parameter and a braced value', () => {
    expect(
      prefillFrom(plain('ANTHROPIC_CUSTOM_HEADERS'), { ANTHROPIC_CUSTOM_HEADERS: `x-api-key: ${key}` }).values,
    ).toEqual({});
    const query = prefillFrom(plain('ANTHROPIC_BASE_URL'), { ANTHROPIC_BASE_URL: `https://gw.example/v1?key=${key}` });
    expect(query.withheld).toEqual([{ name: 'ANTHROPIC_BASE_URL', reason: 'url-query' }]);
    const braced = prefillFrom(plain('GATEWAY_TOKEN'), { GATEWAY_TOKEN: `\${${key}}` });
    expect(braced.values).toEqual({});
    expect(braced.withheld).toEqual([{ name: 'GATEWAY_TOKEN', reason: 'credential-name' }]);
    const wrapped = prefillFrom(plain('GATEWAY_TOKEN'), { GATEWAY_TOKEN: `\${secret:${key.toLowerCase()}}` });
    expect(wrapped.values).toEqual({});
    const token = prefillFrom(plain('GATEWAY_NOTE'), { GATEWAY_NOTE: `\${hf_${'x1'.repeat(10)}}` });
    expect(token.withheld).toEqual([{ name: 'GATEWAY_NOTE', reason: 'token-shape' }]);
    expect(JSON.stringify([query, braced, wrapped, token])).not.toContain(key);
  });

  it('takes an api-version address and an address whose password is a reference', () => {
    const version = prefillFrom(plain('ANTHROPIC_BASE_URL'), {
      ANTHROPIC_BASE_URL: 'https://gw.example/v1?api-version=2024-10-21',
    });
    expect(version.values).toEqual({ ANTHROPIC_BASE_URL: 'https://gw.example/v1?api-version=2024-10-21' });
    const proxy = prefillFrom(plain('HTTPS_PROXY'), { HTTPS_PROXY: 'http://alice:${secret:PW}@proxy.example:3128' });
    expect(proxy.withheld).toEqual([]);
  });
});

describe('prefillFrom — R6: headers, addresses and braces are read as the daemon reads them', () => {
  const key = 'q7Zk'.repeat(10);
  const plain = (name: string) =>
    preset({
      id: 'x',
      variables: [{ name, kind: 'plain', required: false, allowEmpty: false, harnesses: ['claude-code'] }],
    });
  const withheld = (name: string, value: string) => prefillFrom(plain(name), { [name]: value });

  it('withholds a key in an OpenTelemetry or folded header list, and in an unlisted or encoded query name', () => {
    for (const [name, value] of [
      ['OTEL_EXPORTER_OTLP_HEADERS', `Authorization=Bearer ${key}`],
      ['OTEL_EXPORTER_OTLP_HEADERS', `api-key=${key},x=1`],
      ['ANTHROPIC_CUSTOM_HEADERS', `Authorization:\n Bearer ${key}`],
      ['ANTHROPIC_BASE_URL', `https://gw.example/v1?%6Bey=${key}`],
      ['ANTHROPIC_BASE_URL', `https://gw.example/v1?pass=${key}`],
      ['ANTHROPIC_BASE_URL', `gw.example/v1?key=${key}`],
      ['ANTHROPIC_BASE_URL', `https://gw.example/v1#key=${key}`],
      ['HTTPS_PROXY', `https://${key}:@gw.example`],
      ['HTTPS_PROXY', `http:/alice:${key}@proxy.example:3128`],
      ['GATEWAY_TOKEN', `$${key}`],
    ] as const) {
      const result = withheld(name, value);

      expect(result.values).toEqual({});
      expect(result.withheld).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain(key);
    }
  });

  it('takes a header list that names only references or ordinary headers', () => {
    expect(withheld('OTEL_EXPORTER_OTLP_HEADERS', 'Authorization=Bearer ${secret:K}').withheld).toEqual([]);
    expect(withheld('OTEL_EXPORTER_OTLP_HEADERS', 'x-org=acme').withheld).toEqual([]);
  });
});
