import { describe, expect, it } from 'bun:test';
import {
  hasTokenShape,
  namesACredential,
  plainPaste,
  storedEnvironmentIssue,
  urlCarries,
} from '../../../contract/secret-shape.ts';

describe('namesACredential', () => {
  it.each(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GITHUB_PAT', 'DB_PASSWORD', 'OPENAI_APIKEY'])(
    'reads %s as a credential, whatever it holds',
    name => {
      expect(namesACredential(name)).toBe(true);
    },
  );

  it.each(['ANTHROPIC_BASE_URL', 'API_TIMEOUT_MS', 'ANTHROPIC_MODEL'])('does not read %s as one', name => {
    expect(namesACredential(name)).toBe(false);
  });
});

describe('hasTokenShape', () => {
  it('reads a well-known token start, and not an ordinary word', () => {
    expect(hasTokenShape('sk-or-v1-abcdefghij')).toBe(true);
    expect(hasTokenShape('eyJhbGciOi')).toBe(true);
    expect(hasTokenShape('https://api.z.ai')).toBe(false);
  });
});

describe('urlCarries', () => {
  it('says a user and password, a query string, or nothing', () => {
    expect(urlCarries('https://bob:pw@host.example/v1')).toBe('userinfo');
    expect(urlCarries('https://host.example/v1?api-version=2024')).toBeUndefined();
    expect(urlCarries('https://host.example/v1?key=abcdefgh12')).toBe('query');
    expect(urlCarries('https://host.example:8443/v1')).toBeUndefined();
    expect(urlCarries('not a url')).toBeUndefined();
    expect(urlCarries('bob:pw@llm.corp.example')).toBe('userinfo');
  });
});

describe('plainPaste', () => {
  it('refuses at any length only a name that ENDS in a credential word, and judges AUTH and mid-name words by length', () => {
    expect(plainPaste('GATEWAY_TOKEN', 'abc', false)).toEqual({ kind: 'withheld', reason: 'credential-name' });
    expect(plainPaste('GATEWAY_TOKEN', 'abc', false, 'stored')).toEqual({ kind: 'take', value: 'abc' });
    expect(plainPaste('GATEWAY_TOKEN', 'abcdefgh', false, 'stored')).toEqual({
      kind: 'withheld',
      reason: 'credential-name',
    });
    expect(plainPaste('GATEWAY_TOKEN', 'sk-1', false, 'stored')).toEqual({ kind: 'withheld', reason: 'token-shape' });
    expect(plainPaste('SKIP_BEDROCK_AUTH', '1', false)).toEqual({ kind: 'take', value: '1' });
    expect(plainPaste('CLAUDE_CODE_API_KEY_HELPER_TTL_MS', '3600000', false)).toEqual({
      kind: 'take',
      value: '3600000',
    });
    expect(plainPaste('GATEWAY_AUTH', 'longer-than-eight', false)).toEqual({
      kind: 'withheld',
      reason: 'credential-name',
    });
  });

  it('lets a value with a reference inside it through the name rule only when it is stored', () => {
    expect(plainPaste('GATEWAY_TOKEN', 'Bearer ${secret:K}', false)).toEqual({
      kind: 'withheld',
      reason: 'credential-name',
    });
    expect(plainPaste('GATEWAY_TOKEN', 'Bearer ${secret:K}', false, 'stored')).toEqual({
      kind: 'take',
      value: 'Bearer ${secret:K}',
    });
  });

  it('takes an ordinary value as it is', () => {
    expect(plainPaste('ANTHROPIC_BASE_URL', 'https://api.z.ai/api/anthropic', false)).toEqual({
      kind: 'take',
      value: 'https://api.z.ai/api/anthropic',
    });
  });

  it('keeps a deliberate empty, and still names a credential-looking value pasted into it', () => {
    expect(plainPaste('API_TIMEOUT_MS', '30000', true)).toEqual({ kind: 'withheld', reason: 'allow-empty' });
    expect(plainPaste('ANTHROPIC_API_KEY', 'sk-1234', true)).toEqual({ kind: 'withheld', reason: 'credential-name' });
    expect(plainPaste('ANTHROPIC_API_KEY', 'sk-ant-api03-abcdefghij ${secret:X}', false)).toEqual({
      kind: 'withheld',
      reason: 'credential-name',
    });
    expect(plainPaste('ANTHROPIC_API_KEY', '${secret:X}', false)).toEqual({ kind: 'take', value: '${secret:X}' });
  });

  it('withholds a credential name however short the value, but takes a reference or an empty one', () => {
    expect(plainPaste('ANTHROPIC_API_KEY', 'sk-1234', false)).toEqual({ kind: 'withheld', reason: 'credential-name' });
    expect(plainPaste('ANTHROPIC_API_KEY', '${secret:MY_KEY}', false)).toEqual({
      kind: 'take',
      value: '${secret:MY_KEY}',
    });
    expect(plainPaste('ANTHROPIC_API_KEY', '', false)).toEqual({ kind: 'take', value: '' });
  });

  it('withholds a token shape under an innocent name, and an address with a user or a query', () => {
    expect(plainPaste('NOTE', 'ghp_abcdefghijklmnopqrstuvwx', false)).toEqual({
      kind: 'withheld',
      reason: 'token-shape',
    });
    expect(plainPaste('ANTHROPIC_BASE_URL', 'https://a:b@h.example', false)).toEqual({
      kind: 'withheld',
      reason: 'url-userinfo',
    });
    expect(plainPaste('ANTHROPIC_BASE_URL', 'https://h.example/?key=abcdefgh12', false)).toEqual({
      kind: 'withheld',
      reason: 'url-query',
    });
  });
});

describe('R6: the stored rule is linear and reads headers and addresses under any name', () => {
  const key = 'q7Zk'.repeat(10);

  it('should judge a 256 KiB value of one repeated character in well under 100 ms, stored and prefilled', () => {
    for (const character of [':', '@', '=', '%', ' ', ',', '\n', '?', '#', '/', '[', '$']) {
      const value = character.repeat(256 * 1024);
      for (const name of ['GATEWAY_TOKEN', 'GATEWAY_NOTE', 'ANTHROPIC_CUSTOM_HEADERS']) {
        const started = performance.now();
        storedEnvironmentIssue(name, value);
        plainPaste(name, value, false);
        urlCarries(value);
        expect(performance.now() - started).toBeLessThan(100);
      }
    }
  });

  it('should judge repeated JWT openings in linear time, and still find a JWT', () => {
    const started = performance.now();
    expect(hasTokenShape(`x ${'eyJ'.repeat(90_000)}`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(100);
    expect(hasTokenShape(`x ${'eyJ'.repeat(5)}.`)).toBe(true);
  });

  it('should withhold, in the browser too, a key in a header list, an address and a wrapped variable', () => {
    for (const [name, value] of [
      ['OTEL_EXPORTER_OTLP_HEADERS', `Authorization=Bearer ${key}`],
      ['ANTHROPIC_CUSTOM_HEADERS', `Authorization:\n Bearer ${key}`],
      ['ANTHROPIC_CUSTOM_HEADERS', `X-Org: acme\rx_api_key: ${key}`],
      ['GATEWAY_TOKEN', `$${key}`],
      ['GATEWAY_TOKEN', `\${X${key}}`],
    ] as const) {
      expect(plainPaste(name, value, false)).toEqual({ kind: 'withheld', reason: 'credential-name' });
    }
    for (const value of [`https://${key}:@gw/v1`, `http:/alice:${key}@proxy:3128`, `alice:${key}@proxy`]) {
      expect(plainPaste('HTTPS_PROXY', value, false)).toEqual({ kind: 'withheld', reason: 'url-userinfo' });
    }
    for (const value of [
      `https://gw/v1?%6Bey=${key}`,
      `https://gw/v1?pass=${key}`,
      `gw.example/v1?key=${key}`,
      `//gw.example/v1?key=${key}`,
      `https://gw/v1#key=${key}`,
      `https://gw/v1?X-Amz-Signature=${key}`,
    ]) {
      expect(plainPaste('ANTHROPIC_BASE_URL', value, false)).toEqual({ kind: 'withheld', reason: 'url-query' });
    }
  });

  it('should take a reference-bearing header list and an upper-case variable reference where the daemon does', () => {
    expect(plainPaste('OTEL_EXPORTER_OTLP_HEADERS', 'Authorization=Bearer ${secret:K}', false)).toEqual({
      kind: 'take',
      value: 'Authorization=Bearer ${secret:K}',
    });
    expect(plainPaste('GATEWAY_AUTH', '$GATEWAY_AUTH', false)).toEqual({ kind: 'take', value: '$GATEWAY_AUTH' });
    expect(plainPaste('GATEWAY_TOKEN', '${GATEWAY_TOKEN}', false, 'stored')).toEqual({
      kind: 'take',
      value: '${GATEWAY_TOKEN}',
    });
  });
});
