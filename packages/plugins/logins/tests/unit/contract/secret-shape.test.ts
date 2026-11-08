import { describe, expect, it } from 'bun:test';
import { hasTokenShape, namesACredential, plainPaste, urlCarries } from '../../../contract/secret-shape.ts';

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
    expect(urlCarries('https://host.example/v1?api-version=2024')).toBe('query');
    expect(urlCarries('https://host.example:8443/v1')).toBeUndefined();
    expect(urlCarries('not a url')).toBeUndefined();
  });
});

describe('plainPaste', () => {
  it('takes an ordinary value as it is', () => {
    expect(plainPaste('ANTHROPIC_BASE_URL', 'https://api.z.ai/api/anthropic', false)).toEqual({
      kind: 'take',
      value: 'https://api.z.ai/api/anthropic',
    });
  });

  it('keeps a deliberate empty, and still names a credential-looking value pasted into it', () => {
    expect(plainPaste('API_TIMEOUT_MS', '30000', true)).toEqual({ kind: 'withheld', reason: 'allow-empty' });
    expect(plainPaste('ANTHROPIC_API_KEY', 'sk-1234', true)).toEqual({ kind: 'withheld', reason: 'credential-name' });
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
    expect(plainPaste('ANTHROPIC_BASE_URL', 'https://h.example/?k=1', false)).toEqual({
      kind: 'withheld',
      reason: 'url-query',
    });
  });
});
