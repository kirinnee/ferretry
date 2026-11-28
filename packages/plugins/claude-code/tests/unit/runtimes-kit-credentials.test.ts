import { describe, expect, it } from 'bun:test';
import { claudeCredentialsKit } from '../../daemon/lib/runtimes-kit/credentials.ts';

const HOME = '/home/person';
const store = claudeCredentialsKit.credentialStore!;
const environment = claudeCredentialsKit.credentialEnvironment!;

describe('Claude credential store kit', () => {
  it('should reach the person’s own login through the empty secure-storage value and the default folder', () => {
    expect(store({ store: 'host', userHome: HOME })).toEqual({
      kind: 'stored',
      directory: '/home/person/.claude',
      file: '/home/person/.claude/.credentials.json',
      secureStorage: '',
    });
  });

  it('should reach a Ferretry-kept login through the secure-storage value Logins named', () => {
    const variables = { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/fy/state/logins/credentials/work' };
    expect(store({ store: 'ferretry', userHome: HOME, variables })).toEqual({
      kind: 'stored',
      directory: '/fy/state/logins/credentials/work',
      file: '/fy/state/logins/credentials/work/.credentials.json',
      secureStorage: '/fy/state/logins/credentials/work',
    });
  });

  it('should name the directory in Unicode NFC, the string the macOS keychain item name is hashed from', () => {
    const decomposed = '/fy/café';
    const found = store({
      store: 'ferretry',
      userHome: HOME,
      variables: { CLAUDE_SECURESTORAGE_CONFIG_DIR: decomposed },
    });
    expect(found).toMatchObject({ directory: '/fy/café', secureStorage: decomposed });
  });

  it('should leave a Ferretry-kept login unreachable when Logins names no store, or an empty one', () => {
    const none = { kind: 'unavailable', reason: 'Logins names no store for it' } as const;
    expect(store({ store: 'ferretry', userHome: HOME })).toEqual(none);
    expect(store({ store: 'ferretry', userHome: HOME, variables: {} })).toEqual(none);
    expect(store({ store: 'ferretry', userHome: HOME, variables: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '' } })).toEqual(
      none,
    );
  });

  it('should export the secure-storage value, the empty string included, and nothing else', () => {
    expect(environment(store({ store: 'host', userHome: HOME }))).toEqual({ CLAUDE_SECURESTORAGE_CONFIG_DIR: '' });
    expect(
      environment(store({ store: 'ferretry', userHome: HOME, variables: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/s' } })),
    ).toEqual({ CLAUDE_SECURESTORAGE_CONFIG_DIR: '/s' });
    expect(environment({ kind: 'unavailable', reason: 'x' } as const)).toEqual({});
  });

  it('should offer no link: a Claude credential is shared by the secure-storage variable and never linked', () => {
    expect(claudeCredentialsKit.credentialLink).toBeUndefined();
  });
});
