/**
 * `logins:openai`'s `credential()` against Logins' REAL owned store and the kernel's REAL roots port, on a temporary
 * FY_HOME with fake tokens: it answers a shared credential only for a signed-in, owned Codex login, says why in one
 * sentence otherwise, renews only a login whose token is due (and says "needs approval" if that is refused), and the file it
 * shares is the one Codex's ferret home is linked to.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FencedPath, RootsPort } from '@ferretry/kernel/contract';
import { ensureInternalRootBases, nodeFs, rootsPortFor } from '@ferretry/kernel/host';
import type { LoginFile } from '../../../contract/index.ts';
import { sampleLogin } from '../../../contract/testing/index.ts';
import { codexCredentialSource } from '../../../daemon/adapters/credentials/codex-credential.ts';
import { HOST_STORE_PENDING, OwnedLoginStore } from '../../../daemon/adapters/credentials/owned-store.ts';
import { loginKinds } from '../../../daemon/lib/kinds.ts';
import { classifyCredential } from '../../../daemon/lib/shared/identity.ts';

const NOW = Date.parse('2026-10-16T09:00:00Z');
const jwt = (claims: unknown) => `fixture.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fixture`;
const TOKENS = {
  tokens: {
    access_token: jwt({ exp: (NOW + 3_600_000) / 1_000 }),
    refresh_token: 'refresh-TESTONLY-credential',
    id_token: jwt({ email: 'codex@example.test' }),
    account_id: 'fixture-account',
  },
  last_refresh: new Date(NOW).toISOString(),
};

const FILES = new Map<string, LoginFile>([
  ['team', { harness: 'codex', store: 'ferretry' } as LoginFile],
  ['mine', { harness: 'codex', store: 'host' } as LoginFile],
  ['work', { harness: 'claude-code', store: 'ferretry' } as LoginFile],
]);

const homes: string[] = [];
afterEach(async () => {
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});

async function fixture(
  options: { readonly status?: 'ready' | 'needs_sign_in'; readonly seed?: (credentials: string) => Promise<void> } = {},
) {
  const fyHome = await mkdtemp(join(tmpdir(), 'logins-codex-credential-'));
  homes.push(fyHome);
  const base = join(fyHome, 'state', 'logins', 'credentials');
  await mkdir(join(base, 'team'), { recursive: true, mode: 0o700 });
  const fs = nodeFs(() => 'fixture');
  await ensureInternalRootBases(fs, { home: fyHome, plugin: 'codex' }, ['agent-homes']);
  const port = (plugin: string, declared: Parameters<typeof rootsPortFor>[2], shareCredentials?: readonly string[]) =>
    rootsPortFor(fs, { home: fyHome, plugin, worktrees: `${fyHome}-worktrees` }, declared, () => undefined, {
      privateFiles: ['state/logins/credentials'],
      ...(shareCredentials === undefined ? {} : { shareCredentials }),
    });
  const logins: RootsPort = port('logins', ['credentials'], ['auth.json']);
  const codex: RootsPort = port('codex', ['agent-homes']);
  if (options.seed === undefined)
    await writeFile(join(base, 'team', 'auth.json'), JSON.stringify(TOKENS), { mode: 0o600 });
  else await options.seed(base);
  const store = new OwnedLoginStore(logins.root('credentials'), () => NOW);
  const catalog = store.catalog(() => FILES);
  const source = codexCredentialSource({ catalog, store, roots: logins });
  const refreshes: string[] = [];
  const word = options.status ?? 'ready';
  const view = (id: string) =>
    sampleLogin(id, {
      status: {
        word,
        label: word === 'ready' ? 'Ready' : 'Sign in',
        reason: word === 'ready' ? 'access_current' : 'access_expired_no_refresh',
        explanation: word === 'ready' ? 'The access token is current.' : 'The access token has expired.',
        lastCheckInconclusive: false,
      },
    });
  const kinds = loginKinds({
    clock: { sleep: async () => undefined },
    files: () => FILES,
    launchStore: async () => ({ kind: 'none' as const }),
    view: async id => view(id),
    check: async id => {
      refreshes.push(id);
      return view(id);
    },
    startSignIn: async () => {
      throw new Error('not used');
    },
    signInStatus: async () => {
      throw new Error('not used');
    },
    credentialProblem: id => source.problem(id),
    shareCredential: id => source.share(id),
  });
  return { fyHome, base, codex, kinds, refreshes, source, store, logins };
}

describe('logins:openai credential()', () => {
  test('a signed-in owned Codex login answers a shared credential that links into a ferret home', async () => {
    const f = await fixture();

    const answer = await f.kinds.openai.credential?.('team', 'codex');

    expect(answer?.kind).toBe('file');
    if (answer?.kind !== 'file') throw new Error('expected a file answer');
    expect(JSON.stringify(answer)).toBe('{"kind":"file","credential":{"credential":"auth.json"}}');
    expect(JSON.stringify(answer)).not.toContain(f.fyHome);
    const home = f.codex.root('agent-homes', { subfolder: 'fern' });
    const at = home.resolve('auth.json');
    if (!at.ok) throw new Error(at.error);
    await home.linkCredential(answer.credential, at.value as FencedPath);
    const placed = join(f.fyHome, 'state', 'codex', 'agent-homes', 'fern', 'auth.json');
    expect((await lstat(placed)).isSymbolicLink()).toBe(true);
    expect(await readlink(placed)).toBe(join(f.base, 'team', 'auth.json'));
    expect(JSON.parse(await readFile(placed, 'utf8'))).toEqual(TOKENS);
  });

  test('a Codex key sign-in (auth_mode apikey with a non-empty key) is a sign-in too', async () => {
    const f = await fixture({
      seed: async base => {
        await writeFile(
          join(base, 'team', 'auth.json'),
          JSON.stringify({ OPENAI_API_KEY: 'fake-key', auth_mode: 'apikey' }),
          { mode: 0o600 },
        );
      },
    });
    expect((await f.kinds.openai.credential?.('team', 'codex'))?.kind).toBe('file');
  });

  test('it never renews: the refresh path is not touched by any answer', async () => {
    const f = await fixture();
    await f.kinds.openai.credential?.('team', 'codex');
    await f.kinds.openai.credential?.('team', 'claude-code');
    await f.kinds.openai.credential?.('mine', 'codex');
    expect(f.refreshes).toEqual([]);
  });

  test('a login with no sign-in file is unavailable, in a sentence that names it and tells the remedy', async () => {
    const f = await fixture({ seed: async () => undefined });
    const answer = await f.kinds.openai.credential?.('team', 'codex');
    expect(answer).toEqual({
      kind: 'unavailable',
      sentence: 'the login team is not signed in; sign it in from Logins and start the ferret again',
    });
  });

  test('an empty file and a file without tokens are unavailable, naming the login', async () => {
    for (const body of ['', '{}', '[]', 'not json', JSON.stringify({ OPENAI_API_KEY: '' })]) {
      const f = await fixture({
        seed: async base => {
          await writeFile(join(base, 'team', 'auth.json'), body, { mode: 0o600 });
        },
      });
      const answer = await f.kinds.openai.credential?.('team', 'codex');
      expect(answer?.kind).toBe('unavailable');
      expect(answer?.kind === 'unavailable' ? answer.sentence : '').toContain('team');
    }
  });

  test('a login the status says needs signing in is unavailable with the explanation', async () => {
    const f = await fixture({ status: 'needs_sign_in' });
    const answer = await f.kinds.openai.credential?.('team', 'codex');
    expect(answer).toEqual({
      kind: 'unavailable',
      sentence: 'the login team needs signing in: The access token has expired.',
    });
  });

  test('a harness other than Codex is unavailable', async () => {
    const f = await fixture();
    const answer = await f.kinds.openai.credential?.('team', 'claude-code');
    expect(answer).toEqual({ kind: 'unavailable', sentence: 'the login team is spent by Codex only' });
  });

  test('a host store is unavailable: a host store is not in 5.0 yet', async () => {
    const f = await fixture();
    const answer = await f.kinds.openai.credential?.('mine', 'codex');
    expect(answer?.kind).toBe('unavailable');
    expect(answer?.kind === 'unavailable' ? answer.sentence : '').toContain('is not in 5.0 yet');
  });

  test('a login of another kind is refused, and only the openai kind has a credential at all', async () => {
    const f = await fixture();
    await expect(f.kinds.openai.credential?.('work', 'codex')).rejects.toThrow('no openai login named work');
    for (const kind of ['anthropic', 'api-key', 'proxy', 'endpoint'] as const)
      expect(f.kinds[kind].credential).toBeUndefined();
  });

  test('F2: a file with a second name is unavailable, in one sentence that says what to remove and names no path', async () => {
    const f = await fixture({
      seed: async base => {
        await writeFile(join(base, 'team', 'auth.json'), JSON.stringify(TOKENS), { mode: 0o600 });
        const { link } = await import('node:fs/promises');
        await link(join(base, 'team', 'auth.json'), join(dirname(base), 'second-name'));
      },
    });
    const answer = await f.kinds.openai.credential?.('team', 'codex');
    expect(answer).toEqual({
      kind: 'unavailable',
      sentence:
        'the sign-in file of the login team is not a plain file with a single name (another link to it exists, or it is itself a link); remove the extra link, or sign the login out and in again from Logins, then start the ferret again',
    });
    expect(JSON.stringify(answer)).not.toContain(f.fyHome);
  });
});

describe('codexCredentialSource asked directly, as the other callers of the port ask it', () => {
  test('a Claude login in an owned store is not a Codex sign-in, and the kernel is not asked to share its file', async () => {
    const f = await fixture();
    expect(await f.source.problem('work')).toBe('the login work is not a Codex sign-in');
  });

  test('a host store is refused by the owned catalog: no problem sentence hides it, and nothing is shared for it', async () => {
    const f = await fixture();
    expect(await f.source.problem('mine')).toBe(`the login mine cannot be used: ${HOST_STORE_PENDING}`);
    expect(await f.source.share('mine')).toBeUndefined();
    expect(await f.source.share('nobody')).toBeUndefined();
  });

  test('a host Codex store that the catalog did report as readable still cannot be used by this build', async () => {
    const f = await fixture();
    const hostCatalog = {
      entry: async () =>
        ({
          resolution: { harness: 'codex', store: 'host', canonicalFile: join(f.fyHome, 'fixture-host', 'auth.json') },
        }) as Awaited<ReturnType<Parameters<typeof codexCredentialSource>[0]['catalog']['entry']>>,
    };
    const source = codexCredentialSource({ catalog: hostCatalog, store: f.store, roots: f.logins });
    expect(await source.problem('mine')).toBe(`the login mine cannot be used: ${HOST_STORE_PENDING}`);
    expect(await source.share('mine')).toBeUndefined();
  });
});

/**
 * The launch-time renewal, over the REAL sign-in file: the status the hook reads is classified from the bytes on disk
 * (`classifyCredential`, as the status service does), and the renewal is a fake refresh that rewrites that file the way
 * the harness does. So what the test proves is what a ferret's linked home would find after the start.
 */
describe('logins:openai credential() renews a due token before the ferret starts', () => {
  const EXPIRED = {
    tokens: {
      access_token: jwt({ exp: (NOW - 3_600_000) / 1_000 }),
      refresh_token: 'refresh-TESTONLY-credential',
      id_token: jwt({ email: 'codex@example.test' }),
      account_id: 'fixture-account',
    },
    last_refresh: new Date(NOW - 86_400_000).toISOString(),
  };

  async function renewing(
    stored: unknown,
    renew: (file: string) => Promise<void>,
  ): Promise<{
    readonly f: Awaited<ReturnType<typeof fixture>>;
    readonly kinds: ReturnType<typeof loginKinds>;
    readonly renewals: string[];
  }> {
    const f = await fixture({
      seed: async base => {
        await writeFile(join(base, 'team', 'auth.json'), JSON.stringify(stored), { mode: 0o600 });
      },
    });
    const file = join(f.base, 'team', 'auth.json');
    const renewals: string[] = [];
    const view = async (id: string) => {
      const state = classifyCredential('codex', { outcome: 'found', blob: await readFile(file, 'utf8') }, NOW).state;
      const word = state === 'valid' ? 'ready' : state === 'refreshable' ? 'refresh_due' : 'needs_sign_in';
      return sampleLogin(id, {
        status: {
          word,
          label: word,
          reason:
            word === 'ready'
              ? 'access_current'
              : word === 'refresh_due'
                ? 'access_expired_refreshable'
                : 'refresh_expired',
          explanation: word === 'needs_sign_in' ? 'The refresh token expired.' : 'The access token is current.',
          lastCheckInconclusive: false,
        },
      });
    };
    const kinds = loginKinds({
      clock: { sleep: async () => undefined },
      files: () => FILES,
      launchStore: async () => ({ kind: 'none' as const }),
      view,
      check: async id => {
        renewals.push(id);
        await renew(file);
        return await view(id);
      },
      startSignIn: async () => {
        throw new Error('not used');
      },
      signInStatus: async () => {
        throw new Error('not used');
      },
      credentialProblem: id => f.source.problem(id),
      shareCredential: id => f.source.share(id),
    });
    return { f, kinds, renewals };
  }

  test('a due login is renewed first, and the file the ferret home links to is the renewed one', async () => {
    const { f, kinds, renewals } = await renewing(EXPIRED, async file => {
      await writeFile(file, JSON.stringify(TOKENS), { mode: 0o600 });
    });

    const answer = await kinds.openai.credential?.('team', 'codex');

    expect(renewals).toEqual(['team']);
    expect(answer?.kind).toBe('file');
    expect(JSON.parse(await readFile(join(f.base, 'team', 'auth.json'), 'utf8'))).toEqual(TOKENS);
  });

  test('a fresh login is not renewed at all', async () => {
    const { kinds, renewals } = await renewing(TOKENS, async () => {
      throw new Error('a fresh login must not be renewed');
    });

    expect((await kinds.openai.credential?.('team', 'codex'))?.kind).toBe('file');
    expect(renewals).toEqual([]);
  });

  test('a due login whose renewal the provider refused (the refresh token is now gone) is "needs approval", at the start', async () => {
    const { f, kinds, renewals } = await renewing(EXPIRED, async file => {
      await writeFile(file, JSON.stringify({ tokens: { ...EXPIRED.tokens, refresh_token: '' } }), { mode: 0o600 });
    });

    const answer = await kinds.openai.credential?.('team', 'codex');

    expect(renewals).toEqual(['team']);
    expect(answer).toEqual({
      kind: 'unavailable',
      sentence:
        'the login team needs approval in a browser before a ferret can start on it: The refresh token expired.',
    });
    expect(JSON.stringify(answer)).not.toContain(f.fyHome);
    expect(JSON.stringify(answer)).not.toContain('TESTONLY');
  });

  test('a due login whose renewal could not run still starts, and the answer carries nothing of the failure', async () => {
    const { f, kinds, renewals } = await renewing(EXPIRED, async () => {
      throw new Error('could not spawn codex under /somewhere/private');
    });

    const answer = await kinds.openai.credential?.('team', 'codex');

    expect(renewals).toEqual(['team']);
    expect(JSON.stringify(answer)).toBe('{"kind":"file","credential":{"credential":"auth.json"}}');
    expect(JSON.stringify(answer)).not.toContain(f.fyHome);
  });
});
