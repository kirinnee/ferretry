/**
 * The Claude half of the credential store is its plugin's (E-276 PR 4): what Runtimes does with the kit's answer, and with no
 * answer at all (the plugin is off, or its kit has no credential store).
 */
import { describe, expect, it } from 'bun:test';
import {
  credentialLaunchEnvironment,
  isSignInName,
  resolveCredentialStore,
} from '../../../daemon/lib/account/credentials.ts';
import type { Credential } from '../../../daemon/lib/account/schema.ts';
import { REAL_KITS } from '../../support/real-kits.ts';

const PATHS = { userHome: '/home/person' } as const;
const HOST: Credential = { harness: 'claude', store: 'host' };
const KEPT: Credential = { harness: 'claude', store: 'ferretry' };
const STORES = new Map([['work', { id: 'work', variables: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/fy/logins/work' } }]]);
const OFF = 'claude-code is not supported here';

describe('a Claude credential store through its kit', () => {
  it('should keep the person’s own login as the empty secure-storage value', () => {
    const found = resolveCredentialStore('x', HOST, PATHS, REAL_KITS);
    expect(found).toEqual({
      harness: 'claude',
      store: 'host',
      secureStorage: '',
      storageDirectory: '/home/person/.claude',
      credentialFile: '/home/person/.claude/.credentials.json',
    });
    expect(credentialLaunchEnvironment(found, REAL_KITS)).toEqual({ CLAUDE_SECURESTORAGE_CONFIG_DIR: '' });
  });

  it('should keep a Ferretry-kept login where Logins named it, and leave one it did not name unreachable', () => {
    const found = resolveCredentialStore('work', KEPT, PATHS, REAL_KITS, 'claude', STORES);
    expect(found).toMatchObject({
      secureStorage: '/fy/logins/work',
      credentialFile: '/fy/logins/work/.credentials.json',
    });
    expect(resolveCredentialStore('other', KEPT, PATHS, REAL_KITS, 'claude', STORES)).toEqual({
      harness: 'claude',
      store: 'ferretry',
      unavailable: 'Logins names no store for it',
    });
  });

  it('should name the sign-in file the kit uses as a sign-in file readers must not touch', () => {
    const found = resolveCredentialStore('x', HOST, PATHS, REAL_KITS);
    if (!('credentialFile' in found)) throw new Error('the Claude kit named no credential file');
    expect(isSignInName(found.credentialFile.split('/').pop() ?? '')).toBe(true);
  });

  it('should leave a Claude login unreachable, saying why, when the plugin gave no kit', () => {
    for (const kits of [undefined, new Map(), new Map([['claude', {}]] as const)]) {
      for (const store of ['host', 'ferretry'] as const) {
        expect(resolveCredentialStore('work', { harness: 'claude', store }, PATHS, kits, 'claude', STORES)).toEqual({
          harness: 'claude',
          store,
          unavailable: OFF,
        });
      }
    }
  });

  it('should leave a login unreachable when the kit’s answer names no store to read', () => {
    for (const answer of [{ kind: 'stored' }, { kind: 'environment', env: {} }] as const) {
      const kits = new Map([['claude', { credentialStore: () => answer }]] as const);
      expect(resolveCredentialStore('work', HOST, PATHS, kits)).toEqual({
        harness: 'claude',
        store: 'host',
        unavailable: 'its plugin named no store for it',
      });
    }
  });

  it('should not borrow Claude’s answer for an environment login', () => {
    const credential: Credential = {
      harness: 'claude',
      store: 'environment',
      env: { ANTHROPIC_API_KEY: '${secret:K}' },
    };
    expect(resolveCredentialStore('e', credential, PATHS, undefined)).toMatchObject({
      store: 'environment',
      env: { ANTHROPIC_API_KEY: '${secret:K}' },
    });
  });

  it('should refuse a stored Claude resolution whose kit cannot name its variables', () => {
    const found = resolveCredentialStore('x', HOST, PATHS, REAL_KITS);
    expect(() => credentialLaunchEnvironment(found, undefined)).toThrow(OFF);
  });
});
