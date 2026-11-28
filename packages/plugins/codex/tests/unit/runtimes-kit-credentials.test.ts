import { describe, expect, it } from 'bun:test';
import { codexCredentialsKit } from '../../daemon/lib/runtimes-kit/credentials.ts';

const HOME = '/home/person';
const store = codexCredentialsKit.credentialStore!;
const environment = codexCredentialsKit.credentialEnvironment!;

describe('Codex credential store kit', () => {
  it('should reach the person’s own login as auth.json in their own Codex home', () => {
    expect(store({ store: 'host', userHome: HOME, hostHome: '/home/person/.codex' })).toEqual({
      kind: 'stored',
      file: '/home/person/.codex/auth.json',
    });
    expect(store({ store: 'host', userHome: HOME, hostHome: '/srv/codex-home' })).toEqual({
      kind: 'stored',
      file: '/srv/codex-home/auth.json',
    });
  });

  it('should leave the person’s own login unreachable when their Codex home cannot be named', () => {
    expect(store({ store: 'host', userHome: HOME })).toEqual({
      kind: 'unavailable',
      reason: 'your own Codex home could not be named, because CODEX_HOME is set to a relative path',
    });
  });

  it('should reach a Ferretry-kept login at the file Logins named', () => {
    expect(store({ store: 'ferretry', userHome: HOME, signInFile: '/fy/logins/work/auth.json' })).toEqual({
      kind: 'stored',
      file: '/fy/logins/work/auth.json',
    });
  });

  it('should leave a Ferretry-kept login unreachable when Logins names no file, or an empty one', () => {
    const none = { kind: 'unavailable', reason: 'Logins names no store for it' } as const;
    expect(store({ store: 'ferretry', userHome: HOME })).toEqual(none);
    expect(store({ store: 'ferretry', userHome: HOME, variables: {} })).toEqual(none);
    expect(store({ store: 'ferretry', userHome: HOME, signInFile: '' })).toEqual(none);
  });

  it('should export nothing for a stored login, and an environment login’s own variables', () => {
    expect(environment(store({ store: 'host', userHome: HOME, hostHome: '/h' }))).toEqual({});
    expect(environment({ kind: 'unavailable', reason: 'x' })).toEqual({});
    expect(environment({ kind: 'environment', env: { OPENAI_API_KEY: '${secret:K}' } })).toEqual({
      OPENAI_API_KEY: '${secret:K}',
    });
  });
});
