import { describe, expect, it } from 'bun:test';
import {
  EMPTY_PROXY_DRAFT,
  bypassEntries,
  draftOf,
  settingOf,
} from '../../../../../src/features/fleet/machine/browser-proxy-draft.ts';

describe('browser proxy draft', () => {
  it('starts empty for a machine with no proxy, and names the secrets of a saved one', () => {
    expect(draftOf(null)).toEqual(EMPTY_PROXY_DRAFT);
    expect(draftOf(undefined)).toEqual(EMPTY_PROXY_DRAFT);
    expect(
      draftOf({
        url: 'socks5://proxy.example:1080',
        bypass: ['*.internal.example', '10.0.0.0/8'],
        username: '${secret:PROXY_USER}',
        password: '${secret:PROXY_PASSWORD}',
      }),
    ).toEqual({
      url: 'socks5://proxy.example:1080',
      bypass: '*.internal.example\n10.0.0.0/8',
      usernameSecret: 'PROXY_USER',
      passwordSecret: 'PROXY_PASSWORD',
    });
  });

  it('splits bypass entries on lines and commas and drops blanks', () => {
    expect(bypassEntries(' a.example, b.example\n\n  c.example ,')).toEqual(['a.example', 'b.example', 'c.example']);
    expect(bypassEntries('')).toEqual([]);
  });

  it('builds a setting with secret references, never values', () => {
    const result = settingOf({
      url: 'http://proxy.example:8080',
      bypass: '*.internal.example',
      usernameSecret: ' PROXY_USER ',
      passwordSecret: 'PROXY_PASSWORD',
    });
    expect(result).toEqual({
      ok: true,
      setting: {
        url: 'http://proxy.example:8080',
        bypass: ['*.internal.example'],
        username: '${secret:PROXY_USER}',
        password: '${secret:PROXY_PASSWORD}',
      },
    });
  });

  it('builds a plain setting when no secrets are named', () => {
    const result = settingOf({ ...EMPTY_PROXY_DRAFT, url: 'http://proxy.example:8080' });
    expect(result).toEqual({ ok: true, setting: { url: 'http://proxy.example:8080', bypass: [] } });
  });

  it('says what to fix for a bad address, a lone secret and a bad secret name', () => {
    const address = settingOf({ ...EMPTY_PROXY_DRAFT, url: 'ftp://proxy.example' });
    expect(address.ok).toBe(false);
    const lone = settingOf({ ...EMPTY_PROXY_DRAFT, url: 'http://proxy.example:8080', usernameSecret: 'PROXY_USER' });
    expect(lone.ok).toBe(false);
    const name = settingOf({
      ...EMPTY_PROXY_DRAFT,
      url: 'http://proxy.example:8080',
      usernameSecret: 'bad name!',
      passwordSecret: 'PROXY_PASSWORD',
    });
    expect(name.ok).toBe(false);
    if (!name.ok) expect(name.problem).toStartWith('The username box takes the NAME of a stored secret');
  });

  it('accepts a pasted ${secret:NAME} reference as the name', () => {
    const result = settingOf({
      ...EMPTY_PROXY_DRAFT,
      url: 'socks5://proxy.example:1080',
      usernameSecret: '${secret:PROXY_USER}',
      passwordSecret: '${secret:PROXY_PASSWORD}',
    });
    expect(result.ok).toBe(true);
  });
});
