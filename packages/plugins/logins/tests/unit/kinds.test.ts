import { describe, expect, test } from 'bun:test';
import { LOGIN_KINDS, type LoginFile } from '../../contract/index.ts';
import type { LaunchStore } from '../../daemon/lib/credentials/credentials-service.ts';
import { kindOf, loginKinds, notPlainFileSentence } from '../../daemon/lib/kinds.ts';
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

const STORE = '/fy/state/logins/credentials';
const kinds = loginKinds({
  clock: { sleep: async () => undefined },
  // What the credential service names for a Ferretry-kept Claude login; nothing for any other.
  launchStore: async (id): Promise<LaunchStore> =>
    id === 'work'
      ? { kind: 'owned', variables: { CLAUDE_SECURESTORAGE_CONFIG_DIR: `${STORE}/work` }, usable: true }
      : { kind: 'none' },
  files: () => files,
  view: async id => sampleLogin(id),
  check: async id => sampleLogin(id),
  startSignIn: async () => {
    throw new Error('not used');
  },
  signInStatus: async () => {
    throw new Error('not used');
  },
  credentialProblem: async () => undefined,
  shareCredential: async () => undefined,
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

  test('a signed-in Claude login launches with exactly its store variable, kept apart from the login file’s own env', async () => {
    expect(await kinds.anthropic.launchEnvironment?.('work', 'claude-code')).toEqual({
      ok: true,
      value: { CLAUDE_SECURESTORAGE_CONFIG_DIR: `${STORE}/work` },
    });
    expect(await kinds.anthropic.env('work', 'claude-code')).toEqual({});
  });

  test('F2: a sign-in file the kernel calls not_own is unavailable with the remedy sentence, and no path', async () => {
    const wedged = loginKinds({
      clock: { sleep: async () => undefined },
      credentialProblem: async () => undefined,
      shareCredential: async () => 'not_own',
      launchStore: async () => ({ kind: 'none' as const }),
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

    const answer = await wedged.openai.credential?.('team', 'codex');

    expect(answer).toEqual({ kind: 'unavailable', sentence: notPlainFileSentence('team') });
    expect(answer?.kind === 'unavailable' ? answer.sentence : '').toContain('remove the extra link');
    expect(JSON.stringify(answer)).not.toContain('/');
  });

  test('a Claude login with no usable sign-in refuses with the sentence the check gave, not a signed-out pane', async () => {
    const signedOut = loginKinds({
      clock: { sleep: async () => undefined },
      launchStore: async (): Promise<LaunchStore> => ({
        kind: 'owned',
        variables: { CLAUDE_SECURESTORAGE_CONFIG_DIR: `${STORE}/work` },
        usable: true,
      }),
      credentialProblem: async () => undefined,
      shareCredential: async () => undefined,
      files: () => files,
      view: async id =>
        sampleLogin(id, {
          status: {
            word: 'needs_sign_in',
            label: 'Sign in',
            reason: 'access_expired_no_refresh',
            explanation: 'The access token has expired.',
            lastCheckInconclusive: false,
          },
        }),
      check: async id => sampleLogin(id),
      startSignIn: async () => {
        throw new Error('not used');
      },
      signInStatus: async () => {
        throw new Error('not used');
      },
    });

    const answered = await signedOut.anthropic.launchEnvironment?.('work', 'claude-code');

    expect(answered?.ok).toBe(false);
    if (answered === undefined || answered.ok) return;
    expect(answered.error).toContain('The access token has expired.');
    expect(answered.error).toContain('work');
  });

  test('only the Claude half of a Claude login has a store variable; Codex and environment logins add none here', async () => {
    expect(await kinds.anthropic.launchEnvironment?.('work', 'codex')).toEqual({ ok: true, value: {} });
    expect(await kinds.endpoint.launchEnvironment?.('ds', 'claude-code')).toBeUndefined();
    expect(kinds.openai.launchEnvironment).toBeUndefined();
    expect(kinds.proxy.launchEnvironment).toBeUndefined();
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
      launchStore: async (): Promise<LaunchStore> => ({ kind: 'none' }),
      files: () => files,
      view: async id => needsSignIn(id),
      check: async id => needsSignIn(id),
      startSignIn: async () => {
        throw new Error('not used');
      },
      signInStatus: async () => {
        throw new Error('not used');
      },
      credentialProblem: async () => undefined,
      shareCredential: async () => undefined,
    });

    expect(await signedOut.anthropic.status('work')).toEqual({
      state: 'signed-out',
      sentence: 'The access token has expired.',
    });
    expect(await kinds.anthropic.status('work')).toEqual({ state: 'signed-in' });
  });
});

describe('the launch and credential answers when the store or the share cannot deliver', () => {
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
  const kindsWith = (more: Partial<Parameters<typeof loginKinds>[0]>) =>
    loginKinds({
      clock: { sleep: async () => undefined },
      launchStore: async () => ({ kind: 'none' as const }),
      files: () => files,
      view: async id => sampleLogin(id),
      check: async id => sampleLogin(id),
      startSignIn: async () => {
        throw new Error('not used');
      },
      signInStatus: async () => {
        throw new Error('not used');
      },
      credentialProblem: async () => undefined,
      shareCredential: async () => undefined,
      ...more,
    });

  test('a signed-in Claude login whose store holds nothing a harness can launch with refuses, quoting nothing', async () => {
    const unusable = kindsWith({
      launchStore: async (): Promise<LaunchStore> => ({
        kind: 'owned',
        variables: { CLAUDE_SECURESTORAGE_CONFIG_DIR: `${STORE}/work` },
        usable: false,
      }),
    });

    expect(await unusable.anthropic.launchEnvironment?.('work', 'claude-code')).toEqual({
      ok: false,
      error: 'the login work has sign-in material this build cannot use, so the ferret was not started',
    });
  });

  test('a Claude login whose store cannot be asked refuses with a fixed sentence, never the failure', async () => {
    const broken = kindsWith({
      launchStore: async () => {
        throw new Error(`cannot open ${STORE}/work`);
      },
    });

    const answered = await broken.anthropic.launchEnvironment?.('work', 'claude-code');

    expect(answered).toEqual({ ok: false, error: 'the login work could not be read, so the ferret was not started' });
    expect(JSON.stringify(answered)).not.toContain(STORE);
  });

  test('a Codex login the status says needs signing in is unavailable with the explanation, and nothing is shared', async () => {
    let shared = 0;
    const signedOut = kindsWith({
      view: async id => needsSignIn(id),
      shareCredential: async () => {
        shared += 1;
        return undefined;
      },
    });

    expect(await signedOut.openai.credential?.('team', 'codex')).toEqual({
      kind: 'unavailable',
      sentence: 'the login team needs signing in: The access token has expired.',
    });
    expect(shared).toBe(0);
  });

  test('a Codex sign-in the kernel would not share is unavailable in a sentence naming the login', async () => {
    const refused = kindsWith({ shareCredential: async () => undefined });

    expect(await refused.openai.credential?.('team', 'codex')).toEqual({
      kind: 'unavailable',
      sentence: 'the sign-in file of the login team could not be shared with Codex',
    });
  });
});

describe('a signed-in Codex login whose file the kernel shares', () => {
  test('answers the shared credential itself, untouched, after the store and the status agree it is a sign-in', async () => {
    const shared = { credential: 'auth.json' } as unknown as Awaited<
      ReturnType<Parameters<typeof loginKinds>[0]['shareCredential']>
    >;
    const sharing = loginKinds({
      clock: { sleep: async () => undefined },
      launchStore: async () => ({ kind: 'none' as const }),
      files: () => files,
      view: async id => sampleLogin(id),
      check: async id => sampleLogin(id),
      startSignIn: async () => {
        throw new Error('not used');
      },
      signInStatus: async () => {
        throw new Error('not used');
      },
      credentialProblem: async () => undefined,
      shareCredential: async () => shared,
    });

    const answer = await sharing.openai.credential?.('team', 'codex');

    expect(answer?.kind).toBe('file');
    expect(answer?.kind === 'file' ? answer.credential : undefined).toBe(shared as never);
  });
});
