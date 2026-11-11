import { describe, expect, test } from 'bun:test';
import { LOGIN_KINDS, type LoginFile } from '../../contract/index.ts';
import { kindOf, loginKinds } from '../../daemon/lib/kinds.ts';
import { sampleLogin } from '../../contract/testing/index.ts';

const RAW = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789';

const files = new Map<string, LoginFile>([
  ['work', { harness: 'claude-code', store: 'host' } as LoginFile],
  ['team', { harness: 'codex', store: 'ferretry' } as LoginFile],
  [
    'ds',
    {
      harness: 'claude-code',
      store: 'environment',
      preset: 'deepseek',
      env: {
        ANTHROPIC_AUTH_TOKEN: '${secret:DEEPSEEK_API_KEY}',
        ANTHROPIC_API_KEY: RAW,
        ANTHROPIC_BASE_URL: 'https://api.deepseek.com',
      },
    } as LoginFile,
  ],
]);

const kinds = loginKinds({
  clock: { sleep: async () => undefined },
  files: () => files,
  view: async id => sampleLogin(id),
  check: async id => sampleLogin(id),
  startSignIn: async () => {
    throw new Error('not used');
  },
  signInStatus: async () => {
    throw new Error('not used');
  },
});

describe('the five login kinds', () => {
  test('there is one per key the manifest takes, each saying which harnesses can spend it', () => {
    expect(Object.keys(kinds)).toEqual([...LOGIN_KINDS]);
    expect(kinds.anthropic.harnesses).toEqual(['claude-code']);
    expect(kinds.openai.harnesses).toEqual(['codex']);
  });

  test('a login is the kind of its harness when it is a sign-in, and of its preset when it is a key', () => {
    expect(kindOf(files.get('work') as LoginFile)).toBe('anthropic');
    expect(kindOf(files.get('team') as LoginFile)).toBe('openai');
    expect(kindOf(files.get('ds') as LoginFile)).toBe('endpoint');
  });

  test('env hands back references and plain settings and drops a value that looks like a secret', async () => {
    const env = await kinds.endpoint.env('ds', 'claude-code');

    expect(env).toEqual({
      ANTHROPIC_AUTH_TOKEN: '${secret:DEEPSEEK_API_KEY}',
      ANTHROPIC_BASE_URL: 'https://api.deepseek.com',
    });
    expect(JSON.stringify(env)).not.toContain(RAW);
  });

  test('exactly one kind holds a login: its own, never another’s, and none holds a name nobody wrote', () => {
    const holders = (login: string) => LOGIN_KINDS.filter(kind => kinds[kind].holds(login));

    expect(holders('work')).toEqual(['anthropic']);
    expect(holders('team')).toEqual(['openai']);
    expect(holders('ds')).toEqual(['endpoint']);
    expect(holders('ghost')).toEqual([]);
  });

  test('a sign-in login (OAuth) answers an empty environment: its credential is not env', async () => {
    expect(await kinds.anthropic.env('work', 'claude-code')).toEqual({});
    expect(await kinds.openai.env('team', 'codex')).toEqual({});
  });

  test('a kind refuses a login of another kind rather than answering for it', async () => {
    await expect(kinds.anthropic.status('team')).rejects.toThrow('no anthropic login named team');
  });

  test('a login the owner must sign in to again reads as signed out, with the sentence the check gave', async () => {
    const needsSignIn = (id: string) =>
      sampleLogin(id, {
        status: {
          word: 'needs_sign_in',
          label: 'Sign in',
          reason: 'access_expired_no_refresh',
          explanation: 'The access token has expired.',
          lastCheckInconclusive: false,
        },
      });
    const signedOut = loginKinds({
      clock: { sleep: async () => undefined },
      files: () => files,
      view: async id => needsSignIn(id),
      check: async id => needsSignIn(id),
      startSignIn: async () => {
        throw new Error('not used');
      },
      signInStatus: async () => {
        throw new Error('not used');
      },
    });

    expect(await signedOut.anthropic.status('work')).toEqual({
      state: 'signed-out',
      sentence: 'The access token has expired.',
    });
    expect(await kinds.anthropic.status('work')).toEqual({ state: 'signed-in' });
  });
});
