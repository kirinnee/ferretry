/**
 * The account model's credentials, as the daemon serves them (docs/design/account-model.md §3.2, §7,
 * §9.4).
 *
 * The claims: the catalog reads the machine's account model and says where each login lives; a sign-in
 * by credential launches against that credential's STORE; the list carries status and usage and the
 * sentences a surface shows — never material; Check now is gated exactly as a sign-in is; the usage
 * pass observes stored credentials only and never rejects; and passive Codex usage is attributed
 * through the sessions this daemon launched, never guessed.
 *
 * NO CREDENTIAL MATERIAL APPEARS HERE. Every port is a fake answering classifications and paths, and
 * every path is a string no test ever opens.
 */
import { describe, it } from 'bun:test';
import {
  type AccountModel,
  builtInPresets,
  type Credential,
  type CredentialStatus,
  type CredentialStatusView,
  type CredentialSubject,
  type CredentialUsage,
  type HarnessKind,
  type LocalCredentialReading,
  type PassiveUsageRecord,
  resolveCredentialStore,
  type StoredCredentialResolution,
} from '@ferretry/fleet';
import should from 'should';
import type { CallerGovernance } from '../../../src/lib/api/capability.ts';
import {
  attributedTranscripts,
  CREDENTIAL_LIST_FRESH_MS,
  type CredentialEmailSource,
  type CredentialEnvironmentDeps,
  type CredentialHarnessRun,
  type CredentialListCache,
  type CredentialSessionRecord,
  type CredentialStatusReader,
  createFleetCredentialsSubsystem,
  credentialLaunch,
  credentialPassiveUsage,
  FleetCredentialCatalog,
  FleetCredentialRefusal,
  type FleetCredentialsService,
  signOutSentence,
} from '../../../src/lib/fleet/credentials-service.ts';
import type { ProviderProbeSubject } from '../../../src/lib/provider-probe/service.ts';

const PATHS = { fleetRoot: '/fy/fleet', userHome: '/home/person', hostCodexHome: '/home/person/.codex' } as const;
const NO_CODEX_HOME = { fleetRoot: '/fy/fleet', userHome: '/home/person' } as const;

const claudeFerretry: Credential = { harness: 'claude', store: 'ferretry' };
const claudeHost: Credential = { harness: 'claude', store: 'host' };
const codexFerretry: Credential = { harness: 'codex', store: 'ferretry' };
const codexHost: Credential = { harness: 'codex', store: 'host' };
const claudeEnvironment: Credential = {
  harness: 'claude',
  store: 'environment',
  env: { ANTHROPIC_BASE_URL: 'https://example.invalid' },
};

/** An account model, reduced to the two tables the catalog reads. */
const v2 = (
  credentials: Readonly<Record<string, Credential>>,
  runtimes: Readonly<Record<string, string>> = {},
): AccountModel =>
  ({
    version: 2,
    credentials,
    runtimes: Object.fromEntries(Object.entries(runtimes).map(([name, credential]) => [name, { credential }])),
  }) as unknown as AccountModel;

/** The store path a classification is keyed by: the file a harness keeps the login in. */
const storeFile = (resolution: StoredCredentialResolution): string =>
  resolution.harness === 'claude' ? resolution.credentialFile : resolution.canonicalFile;

interface CatalogOptions {
  readonly document?: () => Promise<AccountModel | undefined>;
  readonly readings?: Readonly<Record<string, LocalCredentialReading | 'throw'>>;
  readonly paths?: typeof PATHS | typeof NO_CODEX_HOME;
  readonly created?: string[];
}

const catalogOf = (document: AccountModel | undefined, options: CatalogOptions = {}): FleetCredentialCatalog =>
  new FleetCredentialCatalog({
    document: options.document ?? (async () => document),
    paths: options.paths ?? PATHS,
    inspect: async resolution => {
      const reading = options.readings?.[storeFile(resolution)];
      if (reading === 'throw') throw new Error('locked keychain');
      const location = `the file ${storeFile(resolution)}`;
      return reading === undefined
        ? { reading: { state: 'missing' }, checked: [{ location, found: 'nothing' }] }
        : { reading, checked: [{ location, found: 'present' }] };
    },
    ensureDirectory: async path => {
      options.created?.push(path);
    },
  });

const status = (overrides: Partial<CredentialStatus> = {}): CredentialStatus => ({
  word: 'ready',
  reason: 'not_checked_yet',
  lastCheckInconclusive: false,
  ...overrides,
});

/** A status reader that answers a configured word per credential and records every call. */
class FakeStatus implements CredentialStatusReader {
  readonly calls: string[] = [];
  readonly words = new Map<string, Partial<CredentialStatus>>();
  usage: CredentialUsage = { fiveHour: {}, weekly: {} };
  failObserve = false;

  #view(subject: CredentialSubject): CredentialStatusView {
    return {
      id: subject.id,
      harness: subject.resolution.harness,
      status: status(this.words.get(subject.id)),
      usage: this.usage,
    };
  }

  async view(subject: CredentialSubject): Promise<CredentialStatusView> {
    this.calls.push(`view:${subject.id}`);
    return this.#view(subject);
  }

  async observe(subject: CredentialSubject): Promise<CredentialStatusView> {
    this.calls.push(`observe:${subject.id}`);
    if (this.failObserve) throw new Error('probe failed');
    return this.#view(subject);
  }

  async checkNow(subject: CredentialSubject): Promise<CredentialStatusView> {
    this.calls.push(`check:${subject.id}`);
    return this.#view(subject);
  }
}

interface ServiceOptions {
  readonly emails?: Readonly<Record<string, string>>;
  readonly binary?: string;
  readonly exitCode?: number;
  readonly runs?: CredentialHarnessRun[];
  readonly afterRun?: () => void;
  readonly listCache?: CredentialListCache;
}

const emailKey = (source: CredentialEmailSource): string =>
  source.harness === 'claude' ? source.accountFile : storeFile(source.resolution);

const serviceOf = (
  catalog: FleetCredentialCatalog,
  fake: FakeStatus,
  options: ServiceOptions = {},
): FleetCredentialsService =>
  createFleetCredentialsSubsystem({
    catalog,
    status: fake,
    email: async source => {
      const email = options.emails?.[emailKey(source)];
      if (email === 'throw') throw new Error('unreadable');
      return email;
    },
    machineName: () => 'studio',
    locate: harness => (options.binary === undefined ? undefined : `${options.binary}/${harness}`),
    run: async spec => {
      options.runs?.push(spec);
      options.afterRun?.();
      return options.exitCode ?? 0;
    },
    baseEnvironment: () => ({ PATH: '/usr/bin' }),
    ...(options.listCache === undefined ? {} : { listCache: options.listCache }),
  });

const governed = { governed: true } as CallerGovernance;

const refusalOf = async (work: () => Promise<unknown>): Promise<FleetCredentialRefusal> => {
  try {
    await work();
  } catch (error) {
    should(error).be.instanceOf(FleetCredentialRefusal);
    return error as FleetCredentialRefusal;
  }
  throw new Error('expected a refusal');
};

const resolved = (id: string, credential: Credential, paths: typeof PATHS | typeof NO_CODEX_HOME = PATHS) =>
  resolveCredentialStore(id, credential, paths);

const claudeOwned = resolved('work', claudeFerretry) as Extract<StoredCredentialResolution, { harness: 'claude' }>;

describe('the credential catalog', () => {
  it('should list the model’s credentials with the runtimes that use each, sorted', async () => {
    // Arrange
    const catalog = catalogOf(
      v2({ work: claudeFerretry, keyed: claudeEnvironment }, { zeta: 'work', alpha: 'work', other: 'keyed' }),
    );

    // Act
    const actual = await catalog.entries();

    // Assert
    should(actual.format).equal(2);
    should(actual.entries.map(entry => [entry.id, entry.usedBy])).deepEqual([
      ['work', ['alpha', 'zeta']],
      ['keyed', ['other']],
    ]);
    should(actual.entries[0]?.resolution).deepEqual(resolved('work', claudeFerretry));
    should(actual.entries[1]?.resolution.store).equal('environment');
  });

  it('should answer no credentials when there is no fleet document yet', async () => {
    // Act
    const actual = await catalogOf(undefined).entries();

    // Assert
    should(actual).deepEqual({ format: 2, entries: [] });
  });

  it('should refuse in words when the document cannot be read', async () => {
    // Arrange
    const failing = catalogOf(undefined, {
      document: async () => {
        throw new Error('bad indentation on line 3');
      },
    });
    const silent = catalogOf(undefined, {
      document: async () => {
        throw 'nothing useful';
      },
    });

    // Act
    const loud = await refusalOf(async () => await failing.entries());
    const quiet = await refusalOf(async () => await silent.entries());

    // Assert
    should(loud.code).equal('fleet_credentials_unreadable');
    should(loud.message).containEql('bad indentation on line 3');
    should(quiet.message).endWith(': unreadable');
  });

  it('should refuse an unknown id by name', async () => {
    // Act
    const actual = await refusalOf(async () => await catalogOf(v2({})).entry('ghost'));

    // Assert
    should(actual.code).equal('fleet_credential_unknown');
    should(actual.message).containEql('"ghost"');
  });

  it('should say where each kind of login records its email', async () => {
    // Arrange
    const modern = catalogOf(
      v2({ mine: claudeHost, work: claudeFerretry, codex: codexFerretry, keyed: claudeEnvironment }),
    );

    // Act
    const sources = (await modern.entries()).entries.map(entry => modern.emailSource(entry));

    // Assert
    should(sources).deepEqual([
      { harness: 'claude', accountFile: '/home/person/.claude.json' },
      { harness: 'claude', accountFile: `${claudeOwned.ownedDirectory}/sign-in/.claude.json` },
      { harness: 'codex', resolution: resolved('codex', codexFerretry) },
      undefined,
    ]);
  });
});

describe('signing a credential in', () => {
  it('should launch a Ferretry Claude sign-in against its own store, in a config directory inside it', async () => {
    // Arrange
    const created: string[] = [];
    const catalog = catalogOf(v2({ work: claudeFerretry }), {
      created,
      readings: { [claudeOwned.credentialFile]: { state: 'valid' } },
    });

    // Act
    const target = catalog.signInTarget(await catalog.entry('work'));
    if (target.kind !== 'store') throw new Error('expected a store sign-in');
    await target.prepare();

    // Assert
    const owned = claudeOwned.ownedDirectory ?? '';
    should(target.harness).equal('claude');
    should(target.environment).deepEqual({
      CLAUDE_SECURESTORAGE_CONFIG_DIR: claudeOwned.secureStorage,
      CLAUDE_CONFIG_DIR: `${owned}/sign-in`,
    });
    should(target.arguments).deepEqual([]);
    should(created).deepEqual([owned, `${owned}/sign-in`]);
    should(await target.check()).deepEqual({ signedIn: true });
  });

  it('should sign the person’s own Claude in with the empty secure-storage value and no config directory', async () => {
    // Arrange
    const created: string[] = [];
    const catalog = catalogOf(v2({ mine: claudeHost }), {
      created,
      readings: { '/home/person/.claude/.credentials.json': 'throw' },
    });

    // Act
    const target = catalog.signInTarget(await catalog.entry('mine'));
    if (target.kind !== 'store') throw new Error('expected a store sign-in');
    await target.prepare();

    // Assert — and a store that cannot be read is not signed in, and says so.
    should(target.environment).deepEqual({ CLAUDE_SECURESTORAGE_CONFIG_DIR: '' });
    should(created).deepEqual([]);
    should(await target.check()).deepEqual({
      signedIn: false,
      finding: 'The store this login is kept in could not be read.',
    });
  });

  it('should sign Codex in at the canonical file’s directory with file storage forced', async () => {
    // Arrange
    const created: string[] = [];
    const catalog = catalogOf(v2({ codex: codexFerretry, mine: codexHost }), { created });
    const owned = resolved('codex', codexFerretry);

    // Act
    const [own, host] = await Promise.all(
      ['codex', 'mine'].map(async id => catalog.signInTarget(await catalog.entry(id))),
    );
    if (own?.kind !== 'store' || host?.kind !== 'store') throw new Error('expected store sign-ins');
    await own.prepare();
    await host.prepare();

    // Assert
    should(own.environment).deepEqual({ CODEX_HOME: owned.store === 'ferretry' ? owned.ownedDirectory : '' });
    should(own.arguments).deepEqual(['-c', 'cli_auth_credentials_store="file"']);
    should(host.environment).deepEqual({ CODEX_HOME: '/home/person/.codex' });
    should(created).deepEqual([owned.store === 'ferretry' ? owned.ownedDirectory : '']);
    // An empty store says where it looked.
    should(await own.check()).deepEqual({
      signedIn: false,
      finding: `Checked the file ${owned.store === 'ferretry' && owned.harness === 'codex' ? owned.canonicalFile : ''} — nothing there.`,
    });
  });

  it('should refuse an environment credential and a store this machine cannot name', async () => {
    // Arrange
    const catalog = catalogOf(v2({ keyed: claudeEnvironment, mine: codexHost }), { paths: NO_CODEX_HOME });

    // Act
    const [keyed, mine] = (await catalog.entries()).entries.map(entry => catalog.signInTarget(entry));

    // Assert
    should(keyed).deepEqual({
      kind: 'refused',
      credentialId: 'keyed',
      reason: '"keyed" is authenticated by its environment variables, so there is nothing to sign in to',
    });
    should(mine).deepEqual({
      kind: 'refused',
      credentialId: 'mine',
      reason: 'your own Codex home could not be named, because CODEX_HOME is set to a relative path',
    });
  });

  it('should spell a launch against each kind of store', () => {
    // Act / Assert
    should(credentialLaunch(resolved('mine', claudeHost) as StoredCredentialResolution)).deepEqual({
      environment: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '' },
      arguments: [],
      directories: [],
    });
    should(credentialLaunch(resolved('mine', codexHost) as StoredCredentialResolution)).deepEqual({
      environment: { CODEX_HOME: '/home/person/.codex' },
      arguments: ['-c', 'cli_auth_credentials_store="file"'],
      directories: [],
    });
  });
});

describe('the sign-out sentence', () => {
  const entryOf = async (credential: Credential, runtimes: Readonly<Record<string, string>>) =>
    await catalogOf(v2({ work: { ...credential } }, runtimes)).entry('work');

  it('should say that a host sign-out also signs out the terminal, and how many runtimes need sign-in', async () => {
    // Arrange
    const entry = await entryOf({ ...claudeHost, label: 'personal' }, { a: 'work', b: 'work', c: 'work' });

    // Act
    const actual = signOutSentence(entry, 'kirin@example.com', 'studio');

    // Assert
    should(actual).deepEqual({
      available: true,
      sentence:
        'Sign out of kirin@example.com (personal)? This also signs out claude in your terminal on studio. 3 runtimes will need sign-in.',
      runtimesAffected: 3,
      signsOutTerminal: true,
    });
  });

  it('should name the login by email, label or id, and count one runtime or none', async () => {
    // Act
    const one = signOutSentence(await entryOf(codexFerretry, { a: 'work' }), 'kirin@example.com', 'studio');
    const labelled = signOutSentence(await entryOf({ ...codexFerretry, label: 'team' }, {}), undefined, 'studio');
    const bare = signOutSentence(await entryOf(codexFerretry, {}), undefined, 'studio');

    // Assert
    should(one.sentence).equal('Sign out of kirin@example.com? 1 runtime will need sign-in.');
    should(one.signsOutTerminal).be.false();
    should(labelled.sentence).equal('Sign out of team? No runtime uses it.');
    should(bare.sentence).equal('Sign out of work? No runtime uses it.');
  });

  it('should not offer sign-out where it cannot run', async () => {
    // Arrange
    const keyed = await entryOf(claudeEnvironment, {});
    const unnamed = await catalogOf(v2({ work: codexHost }), { paths: NO_CODEX_HOME }).entry('work');

    // Act / Assert
    should([keyed, unnamed].map(entry => signOutSentence(entry, undefined, 'studio').available)).deepEqual([
      false,
      false,
    ]);
  });
});

describe('the credential list', () => {
  it('should answer each login’s status, usage and acts, parsed through the wire shape', async () => {
    // Arrange
    const fake = new FakeStatus();
    fake.words.set('work', {
      word: 'refresh_due',
      reason: 'access_expired_refreshable',
      since: 1_000,
      lastCheckedAt: 2_000,
      lastCheckInconclusive: true,
      planType: 'pro',
    });
    fake.usage = {
      fiveHour: { usedPercent: 42, resetAt: 3_000 },
      weekly: {},
      source: 'anthropic-usage',
      at: 4_000,
    };
    const service = serviceOf(
      catalogOf(
        v2({ work: { ...claudeFerretry, clonedFrom: 'laptop', clonedFromDaemon: 'sha256:laptop' } }, { a: 'work' }),
      ),
      fake,
    );

    // Act
    const actual = await service.list();

    // Assert
    should(actual.format).equal(2);
    should(actual.machine).equal('studio');
    should(actual.credentials).deepEqual([
      {
        id: 'work',
        harness: 'claude',
        harnesses: ['claude'],
        store: 'ferretry',
        needsLabel: false,
        clonedFrom: 'laptop',
        clonedFromDaemon: 'sha256:laptop',
        sharedWithTerminal: false,
        status: {
          word: 'refresh_due',
          label: 'Refresh due',
          reason: 'access_expired_refreshable',
          explanation: 'The access token has expired. It renews itself the next time it is used.',
          since: '1970-01-01T00:00:01.000Z',
          lastCheckedAt: '1970-01-01T00:00:02.000Z',
          lastCheckInconclusive: true,
          planType: 'pro',
        },
        usage: {
          fiveHour: { usedPercent: 42, resetsAt: '1970-01-01T00:00:03.000Z' },
          weekly: {},
          source: 'anthropic-usage',
          at: '1970-01-01T00:00:04.000Z',
        },
        usedBy: ['a'],
        signIn: { available: true },
        checkNow: { available: true },
        signOut: {
          available: true,
          sentence: 'Sign out of work? 1 runtime will need sign-in.',
          runtimesAffected: 1,
          signsOutTerminal: false,
        },
      },
    ]);
  });

  it('should ask for labels only where two logins of one harness share an email and are not told apart (E26)', async () => {
    // Arrange
    const owned = (id: string, harness: HarnessKind): string => {
      const resolution = resolved(id, { harness, store: 'ferretry' }) as StoredCredentialResolution;
      return resolution.harness === 'claude'
        ? `${resolution.ownedDirectory}/sign-in/.claude.json`
        : storeFile(resolution);
    };
    const same = 'same@example.com';
    const service = serviceOf(
      catalogOf(
        v2({
          bare1: claudeFerretry,
          bare2: claudeFerretry,
          tagged: { ...claudeFerretry, label: 'work' },
          other: { ...codexFerretry },
          alone: { ...codexFerretry, label: 'x' },
          twin1: { harness: 'codex', store: 'ferretry', label: 'twin' },
          twin2: { harness: 'codex', store: 'ferretry', label: 'twin' },
          quiet: claudeFerretry,
        }),
      ),
      new FakeStatus(),
      {
        emails: {
          [owned('bare1', 'claude')]: same,
          [owned('bare2', 'claude')]: same,
          [owned('tagged', 'claude')]: same,
          [owned('other', 'codex')]: same,
          [owned('alone', 'codex')]: 'alone@example.com',
          [owned('twin1', 'codex')]: 'twin@example.com',
          [owned('twin2', 'codex')]: 'twin@example.com',
          [owned('quiet', 'claude')]: 'throw',
        },
      },
    );

    // Act
    const actual = await service.list();

    // Assert
    should(Object.fromEntries(actual.credentials.map(row => [row.id, [row.email, row.needsLabel]]))).deepEqual({
      bare1: [same, true],
      bare2: [same, true],
      // Labelled while the others are not: the UNLABELLED ones still need one, this one does not.
      tagged: [same, false],
      // Another harness with the same email is another rate-limit pool, so it is no collision.
      other: [same, false],
      alone: ['alone@example.com', false],
      twin1: ['twin@example.com', true],
      twin2: ['twin@example.com', true],
      quiet: [undefined, false],
    });
  });

  it('should show a login switched off, with the reason and when it comes back, and none once that has passed', async () => {
    // Arrange
    const clock = { now: Date.parse('2026-10-30T12:00:00Z') };
    const service = serviceOf(
      catalogOf(
        v2({
          paused: { ...claudeFerretry, disabled: { reason: 'spend limit', until: '2026-11-01' } },
          lapsed: { ...claudeFerretry, disabled: { until: '2026-10-01' } },
          open: claudeFerretry,
        }),
      ),
      new FakeStatus(),
      { listCache: { now: () => clock.now, freshMs: 0 } },
    );

    // Act
    const actual = await service.list();

    // Assert
    const by = (id: string) => actual.credentials.find(row => row.id === id);
    should(by('paused')?.disabled).eql({ reason: 'spend limit', until: '2026-11-01T00:00:00.000Z', source: 'login' });
    should(by('lapsed')?.disabled).be.undefined();
    should(by('open')?.disabled).be.undefined();
  });

  it('should say why sign-in and Check now are not offered on an environment login or an unnamed store', async () => {
    // Arrange
    const service = serviceOf(
      catalogOf(v2({ keyed: claudeEnvironment, mine: codexHost }), { paths: NO_CODEX_HOME }),
      new FakeStatus(),
    );

    // Act
    const [keyed, mine] = (await service.list()).credentials;

    // Assert
    should(keyed?.sharedWithTerminal).be.false();
    should(keyed?.signIn).deepEqual({
      available: false,
      reason: '"keyed" is authenticated by its environment variables, so there is nothing to sign in to.',
    });
    should(keyed?.checkNow).deepEqual({
      available: false,
      reason: 'This login comes from environment variables, so there is nothing to check.',
    });
    should(mine?.sharedWithTerminal).be.true();
    should(mine?.signIn).deepEqual({
      available: false,
      reason: 'Your own Codex home could not be named, because CODEX_HOME is set to a relative path.',
    });
    should(mine?.checkNow).deepEqual({
      available: false,
      reason: 'your own Codex home could not be named, because CODEX_HOME is set to a relative path',
    });
  });
});

describe('the shared credential list', () => {
  /** A list's inputs, counted: each catalogue read, and each login's status asked. */
  const counted = (model: AccountModel = v2({ work: claudeFerretry, cx: codexFerretry })) => {
    const clock = { now: 1_786_000_000_000 };
    const reads = { catalog: 0 };
    let current = model;
    const fake = new FakeStatus();
    const catalog = catalogOf(undefined, {
      document: async () => {
        reads.catalog += 1;
        return current;
      },
    });
    const service = serviceOf(catalog, fake, {
      binary: '/usr/local/bin',
      listCache: { now: () => clock.now, freshMs: CREDENTIAL_LIST_FRESH_MS },
    });
    const listsMade = () => fake.calls.filter(call => call === 'view:work').length;
    return {
      clock,
      fake,
      reads,
      service,
      listsMade,
      change: (next: AccountModel) => {
        current = next;
      },
    };
  };

  it('should answer repeated lists within the keep from ONE made list', async () => {
    // Arrange
    const { clock, service, listsMade } = counted();

    // Act
    const first = await service.list();
    clock.now += CREDENTIAL_LIST_FRESH_MS - 1;
    const again = await service.list();
    const third = await service.list();
    clock.now += 1;
    const expired = await service.list();

    // Assert — one list for the first three, a new one once the keep ran out.
    should(again).equal(first);
    should(third).equal(first);
    should(expired).not.equal(first);
    should(listsMade()).equal(2);
  });

  it('should make ONE list for callers asking at once, with or without a keep', async () => {
    // Arrange
    const kept = counted();
    const fake = new FakeStatus();
    const unkept = serviceOf(catalogOf(v2({ work: claudeFerretry })), fake);

    // Act
    const [a, b, c] = await Promise.all([kept.service.list(), kept.service.list(), kept.service.list()]);
    const [d, e] = await Promise.all([unkept.list(), unkept.list()]);
    const after = await unkept.list();

    // Assert — without a keep, a list is shared only while it is being made.
    should(kept.listsMade()).equal(1);
    should(b).equal(a);
    should(c).equal(a);
    should(e).equal(d);
    should(after).not.equal(d);
    should(fake.calls).deepEqual(['view:work', 'view:work']);
  });

  it('should keep a settled list apart from a live one', async () => {
    // Arrange
    const { service, listsMade } = counted();

    // Act
    const live = await service.list();
    const settled = await service.list({ settled: true });
    const settledAgain = await service.list({ settled: true });

    // Assert
    should(settled).not.equal(live);
    should(settledAgain).equal(settled);
    should(listsMade()).equal(2);
  });

  it('should make a new list when the catalogue changes', async () => {
    // Arrange
    const { service, change, listsMade } = counted();
    await service.list();

    // Act
    change(v2({ work: claudeFerretry, cx: codexFerretry, more: claudeFerretry }));
    const changed = await service.list();

    // Assert
    should(changed.credentials.map(row => row.id)).deepEqual(['work', 'cx', 'more']);
    should(listsMade()).equal(2);
  });

  it('should drop the kept list after a usage pass, a Check now and a sign-out', async () => {
    // Arrange
    const { service, listsMade } = counted();
    await service.list();

    // Act
    await service.observeAll();
    await service.list();
    await service.check('cx', governed);
    await service.list();
    await service.signOut('work');
    await service.list();

    // Assert — every list after something that changes a word is a new one.
    should(listsMade()).equal(5);
  });

  it('should make a new list when an environment login’s quota reading moves', async () => {
    // Arrange
    const clock = { now: 1_786_000_000_000 };
    const fake = new FakeStatus();
    let usedPercent = 40;
    const service = createFleetCredentialsSubsystem({
      catalog: catalogOf(v2({ keyed: claudeEnvironment, work: claudeFerretry })),
      status: fake,
      email: async () => undefined,
      machineName: () => 'studio',
      locate: () => undefined,
      run: async () => 0,
      baseEnvironment: () => ({}),
      providerQuota: {
        peek: () => ({
          source: 'zai-coding-plan',
          via: 'endpoint',
          windows: [{ label: '5h', usedPercent }],
          exhausted: false,
          unverified: true,
          at: '2026-10-16T09:00:00.000Z',
        }),
      },
      listCache: { now: () => clock.now, freshMs: CREDENTIAL_LIST_FRESH_MS },
    });
    const first = await service.list();

    // Act — a person watching the logins page had the quota read again.
    const unchanged = await service.list();
    usedPercent = 55;
    const moved = await service.list();

    // Assert
    should(unchanged).equal(first);
    should(moved.credentials.find(row => row.id === 'keyed')?.usage.fiveHour.usedPercent).equal(55);
  });

  it('should not keep a list that failed', async () => {
    // Arrange
    const { fake, service, listsMade } = counted();
    let failing = true;
    const view = fake.view.bind(fake);
    fake.view = async subject => {
      if (failing && subject.id === 'cx') throw new Error('status unreadable');
      return await view(subject);
    };

    // Act
    const failure = await service.list().then(
      () => undefined,
      (error: unknown) => error,
    );
    failing = false;
    const recovered = await service.list();

    // Assert
    should(failure).be.instanceOf(Error);
    should(recovered.credentials).have.length(2);
    should(listsMade()).equal(2);
  });
});

describe('the usage pass', () => {
  it('should observe every stored credential and nothing that has no store', async () => {
    // Arrange
    const fake = new FakeStatus();
    fake.failObserve = true;
    const service = serviceOf(
      catalogOf(v2({ work: claudeFerretry, keyed: claudeEnvironment, mine: codexHost, codex: codexFerretry }), {
        paths: NO_CODEX_HOME,
      }),
      fake,
    );

    // Act — an observation that fails is settled, never a rejection out of the pass.
    await service.observeAll();

    // Assert
    should(fake.calls).deepEqual(['observe:work', 'observe:codex']);
  });

  it('should observe only the credentials it is told are due', async () => {
    // Arrange
    const fake = new FakeStatus();
    const service = serviceOf(catalogOf(v2({ work: claudeFerretry, codex: codexFerretry })), fake);

    // Act
    await service.observeAll(['codex']);

    // Assert
    should(fake.calls).deepEqual(['observe:codex']);
  });

  it('should leave every word as it was when the document cannot be read', async () => {
    // Arrange
    const fake = new FakeStatus();
    const service = serviceOf(
      catalogOf(undefined, {
        document: async () => {
          throw new Error('unreadable');
        },
      }),
      fake,
    );

    // Act
    await service.observeAll();

    // Assert
    should(fake.calls).deepEqual([]);
  });
});

describe('Check now', () => {
  const work = (): FleetCredentialCatalog => catalogOf(v2({ work: codexFerretry, keyed: claudeEnvironment }));

  it('should refuse when nobody can say whether this caller may check', async () => {
    // Act
    const actual = await refusalOf(async () => await serviceOf(work(), new FakeStatus()).check('work', undefined));

    // Assert
    should(actual.code).equal('fleet_credential_unauthorized');
  });

  it('should refuse an unknown login and one that cannot be checked', async () => {
    // Arrange
    const fake = new FakeStatus();
    const service = serviceOf(work(), fake);

    // Act
    const unknown = await refusalOf(async () => await service.check('ghost', governed));
    const keyed = await refusalOf(async () => await service.check('keyed', governed));

    // Assert
    should(unknown.code).equal('fleet_credential_unknown');
    should(keyed.code).equal('fleet_credential_unavailable');
    should(keyed.message).equal('This login comes from environment variables, so there is nothing to check.');
    should(fake.calls).deepEqual([]);
  });

  it('should check a login for a caller the boundary let through', async () => {
    // Arrange
    const fake = new FakeStatus();

    // Act
    const actual = await serviceOf(work(), fake).check('work', governed);

    // Assert
    should(actual.id).equal('work');
    should(fake.calls).deepEqual(['check:work']);
  });
});

describe('signing a credential out', () => {
  it('should refuse an unknown login, an environment login and an unnamed store', async () => {
    // Arrange
    const modern = serviceOf(
      catalogOf(v2({ keyed: claudeEnvironment, mine: codexHost }), { paths: NO_CODEX_HOME }),
      new FakeStatus(),
    );

    // Act
    const unknown = await refusalOf(async () => await modern.signOut('ghost'));
    const keyed = await refusalOf(async () => await modern.signOut('keyed'));
    const mine = await refusalOf(async () => await modern.signOut('mine'));

    // Assert
    should(unknown.code).equal('fleet_credential_unknown');
    should(keyed.code).equal('fleet_credential_unavailable');
    should(keyed.message).equal(
      '"keyed" is authenticated by its environment variables, so there is nothing to sign out of.',
    );
    should(mine.message).equal('This login cannot be reached on this machine.');
  });

  it('should fail in words when the harness is not installed, launching nothing', async () => {
    // Arrange
    const runs: CredentialHarnessRun[] = [];
    const service = serviceOf(catalogOf(v2({ work: claudeFerretry })), new FakeStatus(), { runs });

    // Act
    const actual = await service.signOut('work');

    // Assert
    should(actual.outcome).equal('failed');
    should(actual.outcome === 'failed' && actual.reason).equal(
      'the claude command is not installed on this machine, so its login could not be signed out',
    );
    should(runs).deepEqual([]);
  });

  it('should run the harness’s own logout against the one store, and answer signed-out once nothing is left', async () => {
    // Arrange
    const fake = new FakeStatus();
    const runs: CredentialHarnessRun[] = [];
    const service = serviceOf(catalogOf(v2({ work: claudeFerretry }, { a: 'work' })), fake, {
      binary: '/opt/bin',
      runs,
      afterRun: () => fake.words.set('work', { word: 'needs_sign_in', reason: 'not_signed_in' }),
    });

    // Act
    const actual = await service.signOut('work');

    // Assert
    should(actual.outcome).equal('signed-out');
    should(actual.credential.status.word).equal('needs_sign_in');
    should(runs).deepEqual([
      {
        command: ['/opt/bin/claude', 'auth', 'logout'],
        environment: {
          PATH: '/usr/bin',
          CLAUDE_SECURESTORAGE_CONFIG_DIR: claudeOwned.secureStorage,
          CLAUDE_CONFIG_DIR: `${claudeOwned.ownedDirectory}/sign-in`,
        },
      },
    ]);
  });

  it('should say a login is still there, whether the harness claimed success or not', async () => {
    // Arrange
    const runs: CredentialHarnessRun[] = [];
    const claimed = serviceOf(catalogOf(v2({ codex: codexFerretry })), new FakeStatus(), { binary: '/opt/bin', runs });
    const failed = serviceOf(catalogOf(v2({ codex: codexFerretry })), new FakeStatus(), {
      binary: '/opt/bin',
      exitCode: 3,
    });

    // Act
    const zero = await claimed.signOut('codex');
    const three = await failed.signOut('codex');

    // Assert
    should(zero.outcome === 'failed' && zero.reason).equal(
      'the harness said it signed out, but a login is still there',
    );
    should(three.outcome === 'failed' && three.reason).equal('the harness could not sign out (it exited with code 3)');
    should(runs[0]?.command).deepEqual(['/opt/bin/codex', '-c', 'cli_auth_credentials_store="file"', 'logout']);
  });
});

describe('passive usage', () => {
  const sessions: readonly CredentialSessionRecord[] = [
    { agent: 'alpha', transcript: { home: '/homes/x', file: '/pool/b.jsonl' } },
    { agent: 'alpha', transcript: { home: '/homes/x', file: '/pool/a.jsonl' } },
    { agent: 'alpha', transcript: { home: '/homes/x', file: '/pool/a.jsonl' } },
    { agent: 'alpha', transcript: { home: '/homes/x' } },
    { agent: 'alpha' },
    { agent: 'stranger', transcript: { home: '/homes/copy', file: '/homes/copy/sessions/c.jsonl' } },
    { agent: 'stranger', transcript: { home: '/homes/other', file: '/homes/other/sessions/d.jsonl' } },
  ];

  it('should attribute a transcript only by the runtime that ran it, once each', () => {
    // Act
    const actual = attributedTranscripts({ usedBy: ['alpha'] }, sessions);

    // Assert — a stranger's rollout is never attributed, whatever directory it was written in.
    should(actual).deepEqual(['/pool/a.jsonl', '/pool/b.jsonl']);
  });

  it('should read Claude from its statusLine file and Codex from its attributed rollouts', async () => {
    // Arrange
    const record: PassiveUsageRecord = { version: 1, source: 'codex-rollout', at: 5, fiveHour: { usedPercent: 10 } };
    const asked: (readonly string[])[] = [];
    const claudeIds: string[] = [];
    const catalog = catalogOf(
      v2({ work: claudeFerretry, codex: codexFerretry, idle: codexFerretry }, { alpha: 'codex' }),
    );
    const passive = credentialPassiveUsage({
      catalog,
      claude: async id => {
        claudeIds.push(id);
        return undefined;
      },
      sessions: async () => sessions,
      newestRollout: async files => {
        asked.push(files);
        return record;
      },
    });

    // Act
    const claude = await passive({ id: 'work', resolution: resolved('work', claudeFerretry) });
    const codex = await passive({ id: 'codex', resolution: resolved('codex', codexFerretry) });
    const idle = await passive({ id: 'idle', resolution: resolved('idle', codexFerretry) });

    // Assert — a credential no recorded session ran on reads nothing at all.
    should(claude).be.undefined();
    should(claudeIds).deepEqual(['work']);
    should(codex).deepEqual(record);
    should(idle).be.undefined();
    should(asked).deepEqual([['/pool/a.jsonl', '/pool/b.jsonl']]);
  });
});

describe('FleetCredentialsService — environment logins (docs/provider-presets.md)', () => {
  const PRESETS = builtInPresets();
  const glm: Credential = {
    harness: 'claude',
    store: 'environment',
    preset: 'zai-glm',
    env: { ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic', ANTHROPIC_AUTH_TOKEN: '${secret:ZAI_API_KEY}' },
  };
  const tested: { subject: ProviderProbeSubject; consent: { allowInference: boolean } }[] = [];
  const environment = (held: ReadonlySet<string> | undefined): CredentialEnvironmentDeps => ({
    catalog: async () => ({ presets: [] }),
    presets: async () => PRESETS,
    secretNames: async () => held,
    test: async (subject, consent) => {
      tested.push({ subject, consent });
      return {
        credentialId: subject.id,
        ok: true,
        code: 'ok',
        message: 'The provider accepted this login.',
        spent: 'nothing',
        at: '2026-10-16T09:00:00.000Z',
      };
    },
  });
  const serviceWith = (model: AccountModel, held: ReadonlySet<string> | undefined = new Set()) =>
    createFleetCredentialsSubsystem({
      catalog: catalogOf(model),
      status: new FakeStatus(),
      email: async () => undefined,
      machineName: () => 'studio',
      locate: () => undefined,
      run: async () => 0,
      baseEnvironment: () => ({}),
      environment: environment(held),
    });

  it('should list an environment login with its variables and its Test, and a sign-in without them', async () => {
    // Act
    const list = await serviceWith(v2({ glm, signed: claudeFerretry }), new Set(['ZAI_API_KEY'])).list();

    // Assert
    const row = list.credentials.find(entry => entry.id === 'glm');
    should(row?.environment?.preset?.label).equal('GLM / Z.ai');
    should(row?.environment?.variables).containDeep([{ name: 'ANTHROPIC_AUTH_TOKEN', kind: 'secret', set: true }]);
    should(row?.environment?.test).containDeep({ available: true });
    should(list.credentials.find(entry => entry.id === 'signed')).not.have.property('environment');
  });

  it('should lay an environment login’s provider quota on its row, and none on a sign-in', async () => {
    // Arrange
    const reading = {
      source: 'zai-coding-plan' as const,
      via: 'endpoint' as const,
      windows: [{ label: '5h' as const, usedPercent: 40 }],
      exhausted: false,
      unverified: true,
      at: '2026-10-16T09:00:00.000Z',
    };
    const peeked: string[] = [];
    const service = createFleetCredentialsSubsystem({
      catalog: catalogOf(v2({ glm, signed: claudeFerretry })),
      status: new FakeStatus(),
      email: async () => undefined,
      machineName: () => 'studio',
      locate: () => undefined,
      run: async () => 0,
      baseEnvironment: () => ({}),
      environment: environment(new Set(['ZAI_API_KEY'])),
      providerQuota: {
        peek: id => {
          peeked.push(id);
          return reading;
        },
      },
    });

    // Act
    const list = await service.list();

    // Assert
    should(list.credentials.find(entry => entry.id === 'glm')?.usage).containDeep({
      fiveHour: { usedPercent: 40 },
      source: 'provider-quota',
      provider: reading,
    });
    should(list.credentials.find(entry => entry.id === 'signed')?.usage).not.have.property('provider');
    should(new Set(peeked)).deepEqual(new Set(['glm']));
  });

  it('should list a machine with no environment login without reading presets or secrets', async () => {
    // Arrange
    let read = 0;
    const service = createFleetCredentialsSubsystem({
      catalog: catalogOf(v2({ signed: claudeFerretry })),
      status: new FakeStatus(),
      email: async () => undefined,
      machineName: () => 'studio',
      locate: () => undefined,
      run: async () => 0,
      baseEnvironment: () => ({}),
      environment: {
        ...environment(new Set()),
        presets: async () => {
          read += 1;
          return PRESETS;
        },
      },
    });

    // Act
    await service.list();

    // Assert
    should(read).equal(0);
  });

  it('should hand a Test the login and its preset, with the consent as given', async () => {
    // Arrange
    tested.length = 0;

    // Act
    const actual = await serviceWith(v2({ glm })).test('glm', { allowInference: true }, governed);

    // Assert
    should(actual.ok).be.true();
    should(tested[0]?.subject.preset?.id).equal('zai-glm');
    should(tested[0]?.consent).deepEqual({ allowInference: true });
  });

  it('should hand a Test no preset when the login names one this machine does not have', async () => {
    // Arrange
    tested.length = 0;

    // Act
    await serviceWith(v2({ odd: { ...glm, preset: 'gone' } })).test('odd', { allowInference: false }, governed);
    await serviceWith(v2({ bare: claudeEnvironment })).test('bare', { allowInference: false }, governed);

    // Assert
    should(tested.map(call => call.subject.preset)).deepEqual([undefined, undefined]);
  });

  it('should refuse a Test of a sign-in, an unknown login, or by a caller nobody can judge', async () => {
    const service = serviceWith(v2({ glm, signed: claudeFerretry }));
    should((await refusalOf(() => service.test('signed', { allowInference: false }, governed))).code).equal(
      'fleet_credential_unavailable',
    );
    should((await refusalOf(() => service.test('nobody', { allowInference: false }, governed))).code).equal(
      'fleet_credential_unknown',
    );
    should((await refusalOf(() => service.test('glm', { allowInference: false }, undefined))).code).equal(
      'fleet_credential_unauthorized',
    );
  });

  it('should offer the preset catalogue, and none on a daemon without presets', async () => {
    should(await serviceWith(v2({})).presets()).deepEqual({ presets: [] });
    should(await serviceOf(catalogOf(v2({})), new FakeStatus()).presets()).deepEqual({ presets: [] });
    should((await serviceOf(catalogOf(v2({ glm })), new FakeStatus()).list()).credentials[0]).not.have.property(
      'environment',
    );
  });
});
