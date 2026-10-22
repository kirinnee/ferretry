/**
 * A credential's store, read as rarely as its facts allow — against real files in a temporary directory,
 * the real platform store and the real usage probes, with only the network and `security` faked.
 *
 * The claims: a file store is read again only when its stamp moves; a keychain store only after one
 * usage interval; a `fresh` read always reads; a free read is ONE read of the store whose facts are
 * kept; and — the canary — no token, in any form, reaches what is kept, what is returned, a status
 * head, a view, or a log line, on any path including every failure.
 *
 * Every token here is a FAKE written by this file. No real credential and no network is touched.
 */
import { afterEach, beforeEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  AnthropicUsageProbe,
  CachedCredentialReads,
  type CachedCredentialReadsDeps,
  CODEX_USAGE_URL,
  CodexUsageProbe,
  type CredentialCommand,
  credentialFileStamp,
  type KeptCredentialFacts,
  PlatformFleetCredentialStore,
  type QuotaFetch,
  type QuotaResponse,
} from '../../src/adapters/index.ts';
import type { StoredCredentialResolution } from '../../src/lib/account/credentials.ts';
import {
  type CredentialStatusPorts,
  CredentialStatusService,
  InMemoryCredentialStatusStore,
} from '../../src/lib/account/credential-status.ts';
import type { CredentialMaterial } from '../../src/lib/identity.ts';

const NOW = 1_786_000_000_000;
const HOUR = 3_600_000;
const MINUTE = 60_000;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fy-credential-reads-'));
  roots.push(root);
  return root;
}

const segment = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = (payload: unknown, signature = 'sig'): string =>
  `${segment({ alg: 'none' })}.${segment(payload)}.${signature}`;

const claudeBlob = (accessToken: string, expiresAt = NOW + HOUR): string =>
  JSON.stringify({ claudeAiOauth: { accessToken, refreshToken: `${accessToken}-refresh`, expiresAt } });

const claudeAt = (directory: string): Extract<StoredCredentialResolution, { harness: 'claude' }> => ({
  harness: 'claude',
  store: 'ferretry',
  secureStorage: directory,
  storageDirectory: directory,
  credentialFile: join(directory, '.credentials.json'),
  ownedDirectory: directory,
});

const codexAt = (directory: string): Extract<StoredCredentialResolution, { harness: 'codex' }> => ({
  harness: 'codex',
  store: 'ferretry',
  canonicalFile: join(directory, 'auth.json'),
  ownedDirectory: directory,
});

/** `security` on a fake Mac: answers with `answer()` and counts every spawn. */
function keychain(answer: () => { code: number; stdout: string }): CredentialCommand & { spawns: number } {
  const command = {
    spawns: 0,
    run: async () => {
      command.spawns += 1;
      return answer();
    },
  };
  return command;
}

function storeOf(
  platform: 'linux' | 'darwin',
  command: CredentialCommand = keychain(() => ({ code: 44, stdout: '' })),
) {
  return new PlatformFleetCredentialStore({ platform, command, now: () => NOW, keychainAccount: 'person' });
}

interface World {
  readonly reads: CachedCredentialReads;
  readonly kept: Map<string, KeptCredentialFacts>;
  /** Every material read, in order. */
  readonly materials: CredentialMaterial[];
  /** Every material the probe was handed. */
  readonly probed: CredentialMaterial[];
  clock: number;
}

function worldOf(
  overrides: Partial<CachedCredentialReadsDeps> & { platform?: 'linux' | 'darwin'; command?: CredentialCommand } = {},
): World {
  const store = storeOf(overrides.platform ?? 'linux', overrides.command);
  const kept = new Map<string, KeptCredentialFacts>();
  const world: World = {
    kept,
    materials: [],
    probed: [],
    clock: NOW,
    reads: undefined as unknown as CachedCredentialReads,
  };
  (world as { reads: CachedCredentialReads }).reads = new CachedCredentialReads({
    store: {
      storedMaterial: async resolution => {
        const material = await store.storedMaterial(resolution);
        world.materials.push(material);
        return material;
      },
    },
    probe: async (_resolution, material) => {
      world.probed.push(material);
      return { usageBased: true, ok: true, credentialSignal: 'accepted', shortWindow: { usedPercent: 5 } };
    },
    stamp: credentialFileStamp,
    keychain: overrides.platform === 'darwin',
    keychainFreshMs: () => MINUTE,
    now: () => world.clock,
    cache: kept,
    ...overrides,
  });
  return world;
}

describe('credentialFileStamp', () => {
  it('should stamp a missing file, and a path under a file, as absent', async () => {
    // Arrange
    const root = await scratch();
    await writeFile(join(root, 'file'), 'x');

    // Act / Assert
    should(await credentialFileStamp(join(root, 'missing.json'))).equal('absent');
    should(await credentialFileStamp(join(root, 'file', 'below.json'))).equal('absent');
  });

  it('should hold for an untouched file and move on an atomic save and on an in-place write', async () => {
    // Arrange
    const root = await scratch();
    const path = join(root, '.credentials.json');
    await writeFile(path, 'one');
    const first = await credentialFileStamp(path);

    // Act
    const untouched = await credentialFileStamp(path);
    await writeFile(join(root, 'next'), 'two');
    await rename(join(root, 'next'), path);
    const saved = await credentialFileStamp(path);
    await writeFile(path, 'three, longer');
    const written = await credentialFileStamp(path);

    // Assert
    should(first).be.a.String();
    should(untouched).equal(first);
    should(saved).not.equal(first);
    should(written).not.equal(saved);
    should(first).not.match(/one|two|three/);
  });

  it('should stamp a link by itself and what it points at, and a dangling link as dangling', async () => {
    // Arrange
    const root = await scratch();
    await writeFile(join(root, 'a.json'), 'a');
    await writeFile(join(root, 'b.json'), 'bb');
    await symlink(join(root, 'a.json'), join(root, 'link.json'));
    await symlink(join(root, 'gone.json'), join(root, 'dangling.json'));
    const before = await credentialFileStamp(join(root, 'link.json'));

    // Act
    await rename(join(root, 'b.json'), join(root, 'a.json'));
    const after = await credentialFileStamp(join(root, 'link.json'));
    const dangling = await credentialFileStamp(join(root, 'dangling.json'));

    // Assert
    should(before).match(/>/);
    should(after).not.equal(before);
    should(dangling).match(/>dangling$/);
  });

  it('should give no stamp for a path that cannot be looked at', async () => {
    // Arrange — a link that points at itself: lstat works, following it cannot.
    const root = await scratch();
    await symlink(join(root, 'loop.json'), join(root, 'loop.json'));

    // Act / Assert
    should(await credentialFileStamp(join(root, 'loop.json'))).be.undefined();
  });
});

describe('CachedCredentialReads', () => {
  it('should read a file store once while its stamp holds, and again once it moves', async () => {
    // Arrange
    const directory = await scratch();
    const resolution = claudeAt(directory);
    await writeFile(resolution.credentialFile, claudeBlob('access-TESTONLY'));
    const world = worldOf();

    // Act
    const first = await world.reads.local(resolution);
    const second = await world.reads.local(resolution);
    await writeFile(join(directory, 'next'), claudeBlob('replaced-TESTONLY', NOW - HOUR));
    await rename(join(directory, 'next'), resolution.credentialFile);
    const third = await world.reads.local(resolution);

    // Assert
    should(world.materials.length).equal(2);
    should(second).equal(first);
    should(first.shape).match({ kind: 'tokens', expiresAt: NOW + HOUR });
    should(third.shape).match({ kind: 'tokens', expiresAt: NOW - HOUR });
    should(third.fingerprint).not.equal(first.fingerprint);
  });

  it('should read again for a fresh read, and keep nothing for a store it cannot stamp', async () => {
    // Arrange
    const directory = await scratch();
    const resolution = codexAt(directory);
    await writeFile(
      resolution.canonicalFile,
      JSON.stringify({ tokens: { access_token: jwt({ exp: (NOW + HOUR) / 1000 }) } }),
    );
    const world = worldOf();
    const unstamped = worldOf({ stamp: async () => undefined });

    // Act
    await world.reads.local(resolution);
    await world.reads.local(resolution, { fresh: true });
    await unstamped.reads.local(resolution);
    await unstamped.reads.local(resolution);

    // Assert
    should(world.materials.length).equal(2);
    should(unstamped.materials.length).equal(2);
    should(unstamped.kept.size).equal(0);
  });

  it('should make a free read from ONE read of the store, keep its facts, and need no read after', async () => {
    // Arrange
    const directory = await scratch();
    const resolution = claudeAt(directory);
    await writeFile(resolution.credentialFile, claudeBlob('access-TESTONLY'));
    const world = worldOf();

    // Act
    const read = await world.reads.active(resolution);
    const after = await world.reads.local(resolution);

    // Assert — the probe was handed the very material that was read, and nothing read it again.
    should(world.materials.length).equal(1);
    should(world.probed).deepEqual(world.materials);
    should(read.result).match({ ok: true, credentialSignal: 'accepted' });
    should(after).equal(read.local);
  });

  it('should answer an inconclusive free read, with the facts it read, when the probe throws', async () => {
    // Arrange
    const directory = await scratch();
    const resolution = claudeAt(directory);
    await writeFile(resolution.credentialFile, claudeBlob('access-TESTONLY'));
    const world = worldOf({
      probe: async () => {
        throw new Error('the probe broke');
      },
    });

    // Act
    const read = await world.reads.active(resolution);

    // Assert
    should(read.result).deepEqual({ usageBased: true, ok: false, credentialSignal: 'inconclusive' });
    should(read.local.fingerprint).be.a.String();
  });

  it('should keep a keychain store for one interval, and its fallback file must hold too', async () => {
    // Arrange — a Mac whose keychain answers every read.
    const directory = await scratch();
    const resolution = claudeAt(directory);
    const command = keychain(() => ({ code: 0, stdout: claudeBlob('keychain-TESTONLY') }));
    const world = worldOf({ platform: 'darwin', command });

    // Act
    await world.reads.local(resolution);
    world.clock = NOW + MINUTE - 1;
    await world.reads.local(resolution);
    const withinInterval = command.spawns;
    world.clock = NOW + MINUTE;
    await world.reads.local(resolution);
    const pastInterval = command.spawns;
    await writeFile(resolution.credentialFile, claudeBlob('file-TESTONLY'));
    await world.reads.local(resolution);
    const fileMoved = command.spawns;
    world.clock = NOW;
    await world.reads.local(resolution);

    // Assert — and a clock that went backwards is never "still fresh".
    should([withinInterval, pastInterval, fileMoved, command.spawns]).deepEqual([1, 2, 3, 4]);
  });

  it('should carry Codex facts and the display email, keyed by the store each credential names', async () => {
    // Arrange
    const directory = await scratch();
    const resolution = codexAt(directory);
    await writeFile(
      resolution.canonicalFile,
      JSON.stringify({
        last_refresh: new Date(NOW).toISOString(),
        tokens: {
          access_token: jwt({ exp: (NOW + HOUR) / 1000 }),
          refresh_token: 'refresh-TESTONLY',
          id_token: jwt({ email: 'team@example.com' }),
        },
      }),
    );
    const world = worldOf();

    // Act
    const facts = await world.reads.local(resolution);

    // Assert
    should(facts.codex).match({ state: 'tokens', email: 'team@example.com', lastRefreshAt: NOW });
    should([...world.kept.keys()]).deepEqual([`codex\u0000${resolution.canonicalFile}`]);
  });
});

describe('the probes, handed material their caller read', () => {
  const reply =
    (status: number, body: unknown): QuotaFetch =>
    async () => {
      const bytes = new TextEncoder().encode(JSON.stringify(body));
      return {
        status,
        ok: status >= 200 && status < 300,
        headerNames: ['content-type'],
        header: name => (name === 'content-type' ? 'application/json' : null),
        body: { bytes, truncated: false },
      } satisfies QuotaResponse;
    };

  it('should make the Anthropic read with the token in the material it was handed', async () => {
    // Arrange
    const asked: string[] = [];
    const probe = new AnthropicUsageProbe({
      fetch: async request => {
        asked.push(request.headers.Authorization ?? '');
        return await reply(200, { five_hour: { utilization: 12 } })(request);
      },
      credentials: { material: async () => ({ outcome: 'absent' }) },
    });

    // Act
    const result = await probe.probeMaterial({ outcome: 'found', blob: claudeBlob('handed-TESTONLY') });

    // Assert
    should(asked).deepEqual(['Bearer handed-TESTONLY']);
    should(result).match({ ok: true, credentialSignal: 'accepted' });
  });

  it('should make the Codex read with the token and account in the material it was handed', async () => {
    // Arrange
    const asked: string[] = [];
    const probe = new CodexUsageProbe({
      fetch: async request => {
        asked.push(`${request.headers.Authorization} ${request.headers['ChatGPT-Account-Id']}`);
        return await reply(200, { rate_limit: { primary_window: { used_percent: 3 } } })(request);
      },
      stored: { storedMaterial: async () => ({ outcome: 'absent' }) },
      now: () => NOW,
    });

    // Act
    await probe.probeMaterial({
      outcome: 'found',
      blob: JSON.stringify({ tokens: { access_token: 'handed-TESTONLY', account_id: 'acct-1' } }),
    });

    // Assert
    should(asked).deepEqual(['Bearer handed-TESTONLY acct-1']);
  });
});

/**
 * THE CANARY (housekeeping-worker.md §2.4 rule 5, for what PR 1 keeps on main): a fake store holds a
 * known token. Every path runs — success, HTTP 401, a timeout, a request that throws quoting the
 * header, a response that echoes the token, material that is not JSON, a locked keychain falling back
 * to its file, a probe that throws — and the token, in plain, base64 and base64url form, must appear in
 * nothing kept, nothing returned, no status head, no view and no line written to the console.
 */
describe('the canary: no token reaches what is kept, returned or logged', () => {
  const CANARY = 'CANARY-7f3a9c1e-never-leave-the-call';
  const FORMS = [
    CANARY,
    Buffer.from(CANARY).toString('base64'),
    Buffer.from(CANARY).toString('base64url'),
    Buffer.from(CANARY).toString('hex'),
  ];

  const logged: string[] = [];
  const originals = { ...console };
  beforeEach(() => {
    for (const level of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
      console[level] = (...args: unknown[]) => {
        logged.push(args.map(arg => (typeof arg === 'string' ? arg : Bun.inspect(arg))).join(' '));
      };
    }
  });
  afterEach(() => {
    Object.assign(console, originals);
    logged.splice(0);
  });

  type Answer = 'ok' | 'unauthorized' | 'timeout' | 'throws-quoting' | 'echo';
  const fetchOf =
    (answer: Answer): QuotaFetch =>
    async request => {
      if (answer === 'timeout') throw Object.assign(new Error('the operation timed out'), { name: 'AbortError' });
      if (answer === 'throws-quoting') throw new Error(`connect failed with ${JSON.stringify(request.headers)}`);
      const status = answer === 'unauthorized' ? 401 : answer === 'echo' ? 500 : 200;
      const body =
        answer === 'echo'
          ? { error: { message: `bad token ${CANARY}` } }
          : request.url === CODEX_USAGE_URL
            ? { rate_limit: { primary_window: { used_percent: 9 } } }
            : { five_hour: { utilization: 9 } };
      const bytes = new TextEncoder().encode(JSON.stringify(body));
      return {
        status,
        ok: status === 200,
        headerNames: ['content-type'],
        header: name => (name === 'content-type' ? 'application/json' : null),
        body: { bytes, truncated: false },
      };
    };

  /** Everything this run produced that anyone could ever see or keep, as one string. */
  async function everything(
    run: () => Promise<unknown[]>,
    kept: Map<string, KeptCredentialFacts>,
    heads: InMemoryCredentialStatusStore,
  ): Promise<string> {
    const produced = await run();
    const stored = await Promise.all(['work', 'cx'].map(async id => await heads.read(id)));
    return Bun.inspect({ produced, kept: [...kept.entries()], stored, logged }, { depth: 20 });
  }

  const claudeMaterials: Readonly<Record<string, (directory: string) => Promise<void>>> = {
    'a valid login': async directory => {
      await writeFile(join(directory, '.credentials.json'), claudeBlob(CANARY));
    },
    'material that is not JSON': async directory => {
      await writeFile(join(directory, '.credentials.json'), `{"claudeAiOauth":{"accessToken":"${CANARY}"`);
    },
  };

  for (const [material, write] of Object.entries(claudeMaterials)) {
    for (const answer of ['ok', 'unauthorized', 'timeout', 'throws-quoting', 'echo'] as const) {
      it(`should keep the token of ${material} out of everything when the read answers ${answer}`, async () => {
        // Arrange
        const directory = await scratch();
        await write(directory);
        const resolution = claudeAt(directory);
        const kept = new Map<string, KeptCredentialFacts>();
        const heads = new InMemoryCredentialStatusStore();
        const anthropic = new AnthropicUsageProbe({
          fetch: fetchOf(answer),
          credentials: { material: async () => ({ outcome: 'absent' }) },
        });
        const reads = new CachedCredentialReads({
          store: storeOf('linux'),
          probe: async (_resolution, handed) => await anthropic.probeMaterial(handed),
          stamp: credentialFileStamp,
          keychain: false,
          keychainFreshMs: () => MINUTE,
          now: () => NOW,
          cache: kept,
        });
        const service = new CredentialStatusService(portsOf(reads, heads));
        const subject = { id: 'work', resolution };

        // Act
        const seen = await everything(
          async () => [
            await reads.active(resolution),
            await service.observe(subject),
            await service.view(subject),
            await service.checkNow(subject),
          ],
          kept,
          heads,
        );

        // Assert
        for (const form of FORMS) should(seen.includes(form)).be.false();
        should(seen).match(/fingerprint/);
      });
    }
  }

  it('should keep the token out of everything when a locked keychain falls back to its file', async () => {
    // Arrange — `security` exits 36 (locked); Claude's own fallback file holds the login.
    const directory = await scratch();
    await writeFile(join(directory, '.credentials.json'), claudeBlob(CANARY));
    const resolution = claudeAt(directory);
    const kept = new Map<string, KeptCredentialFacts>();
    const heads = new InMemoryCredentialStatusStore();
    const anthropic = new AnthropicUsageProbe({
      fetch: fetchOf('unauthorized'),
      credentials: { material: async () => ({ outcome: 'absent' }) },
    });
    const reads = new CachedCredentialReads({
      store: storeOf(
        'darwin',
        keychain(() => ({ code: 36, stdout: '' })),
      ),
      probe: async (_resolution, handed) => await anthropic.probeMaterial(handed),
      stamp: credentialFileStamp,
      keychain: true,
      keychainFreshMs: () => MINUTE,
      now: () => NOW,
      cache: kept,
    });
    const service = new CredentialStatusService(portsOf(reads, heads));

    // Act
    const seen = await everything(
      async () => [await service.observe({ id: 'work', resolution }), await reads.local(resolution, { fresh: true })],
      kept,
      heads,
    );

    // Assert
    for (const form of FORMS) should(seen.includes(form)).be.false();
  });

  it('should keep the token out of everything when the probe itself throws quoting it', async () => {
    // Arrange
    const directory = await scratch();
    await writeFile(join(directory, '.credentials.json'), claudeBlob(CANARY));
    const resolution = claudeAt(directory);
    const kept = new Map<string, KeptCredentialFacts>();
    const heads = new InMemoryCredentialStatusStore();
    const reads = new CachedCredentialReads({
      store: storeOf('linux'),
      probe: async (_resolution, handed) => {
        throw new Error(`probe failed on ${handed.outcome === 'found' ? handed.blob : ''}`);
      },
      stamp: credentialFileStamp,
      keychain: false,
      keychainFreshMs: () => MINUTE,
      now: () => NOW,
      cache: kept,
    });
    const service = new CredentialStatusService(portsOf(reads, heads));

    // Act
    const seen = await everything(async () => [await service.observe({ id: 'work', resolution })], kept, heads);

    // Assert
    for (const form of FORMS) should(seen.includes(form)).be.false();
  });

  for (const answer of ['ok', 'unauthorized', 'timeout', 'throws-quoting', 'echo'] as const) {
    it(`should keep a Codex token out of everything when the read answers ${answer}`, async () => {
      // Arrange
      const directory = await scratch();
      const resolution = codexAt(directory);
      await mkdir(directory, { recursive: true });
      await writeFile(
        resolution.canonicalFile,
        JSON.stringify({
          last_refresh: new Date(NOW).toISOString(),
          tokens: {
            access_token: jwt({ exp: (NOW + HOUR) / 1000 }, CANARY),
            refresh_token: CANARY,
            account_id: CANARY,
            id_token: jwt({ email: 'team@example.com' }, CANARY),
          },
        }),
      );
      const kept = new Map<string, KeptCredentialFacts>();
      const heads = new InMemoryCredentialStatusStore();
      const codex = new CodexUsageProbe({
        fetch: fetchOf(answer),
        stored: { storedMaterial: async () => ({ outcome: 'absent' }) },
        now: () => NOW,
      });
      const reads = new CachedCredentialReads({
        store: storeOf('linux'),
        probe: async (_resolution, handed) => await codex.probeMaterial(handed),
        stamp: credentialFileStamp,
        keychain: false,
        keychainFreshMs: () => MINUTE,
        now: () => NOW,
        cache: kept,
      });
      const service = new CredentialStatusService(portsOf(reads, heads));
      const subject = { id: 'cx', resolution };

      // Act
      const seen = await everything(
        async () => [await reads.active(resolution), await service.observe(subject), await service.view(subject)],
        kept,
        heads,
      );

      // Assert
      for (const form of FORMS) should(seen.includes(form)).be.false();
      should(seen).match(/team@example\.com/);
    });
  }

  function portsOf(reads: CachedCredentialReads, heads: InMemoryCredentialStatusStore): CredentialStatusPorts {
    return {
      local: async (resolution, options) => await reads.local(resolution, options),
      passiveUsage: async () => undefined,
      activeUsage: async resolution => await reads.active(resolution),
      refresh: { refresh: async () => ({ outcome: 'error', reason: 'not in this test' }) },
      heads,
      now: () => NOW,
      usageIntervalMs: MINUTE,
    };
  }
});
