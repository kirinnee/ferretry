import { describe, it } from 'bun:test';
import should from 'should';
import type { LoginFile, ProviderPresetCatalog, ProviderQuotaReading } from '../../../contract/index.ts';
import type { CredentialStatusView } from '../../../daemon/lib/credentials/credential-status.ts';
import {
  attributedTranscripts,
  type CredentialEntry,
  FleetCredentialCatalog,
  type FleetCredentialCatalogDeps,
  FleetCredentialRefusal,
  FleetCredentialsService,
  type FleetCredentialsServiceDeps,
} from '../../../daemon/lib/credentials/credentials-service.ts';
import { CLAUDE_SECURE_STORAGE_VARIABLE } from '../../../daemon/lib/credentials/credentials.ts';
import type { CredentialStoreInspection } from '../../../daemon/lib/shared/store-inspection.ts';

const PATHS = { fleetRoot: '/fy/fleet', userHome: '/people/you', hostCodexHome: '/people/you/.codex' } as const;
const GOVERNANCE = {} as never;

const files = (entries: Record<string, Record<string, unknown>>): ReadonlyMap<string, LoginFile> =>
  new Map(Object.entries(entries).map(([id, file]) => [id, { store: 'ferretry', ...file } as LoginFile]));

const FILES = files({
  'claude-work': { harness: 'claude-code', label: 'Work' },
  'claude-you': { harness: 'claude-code', store: 'host' },
  'codex-team': { harness: 'codex' },
  glm: {
    harness: 'claude-code',
    store: 'environment',
    env: { ANTHROPIC_AUTH_TOKEN: '${secret:ZAI_API_KEY}' },
  },
});

/**
 * A build that cannot name the store directories, over stored logins only: the production build of that shape (the
 * owned-root adapter) always supplies `resolveStore`, which is what resolves an environment login there.
 */
const STORED_ONLY = new Map([...FILES].filter(([, file]) => file.store !== 'environment'));
const NO_PATHS = { paths: undefined, logins: () => STORED_ONLY } as const;

const catalogOf = (overrides: Partial<FleetCredentialCatalogDeps> = {}) => {
  const ensured: string[] = [];
  const catalog = new FleetCredentialCatalog({
    logins: () => FILES,
    paths: PATHS,
    inspect: async () => ({ reading: { state: 'valid' }, checked: [] }),
    ensureDirectory: async path => {
      ensured.push(path);
    },
    ...overrides,
  });
  return { catalog, ensured };
};

const entryOf = async (catalog: FleetCredentialCatalog, id: string): Promise<CredentialEntry> => catalog.entry(id);

const rejection = async (work: Promise<unknown>): Promise<FleetCredentialRefusal> =>
  (await work.then(
    () => {
      throw new Error('expected a refusal');
    },
    caught => caught,
  )) as FleetCredentialRefusal;

describe('FleetCredentialCatalog — which credentials exist and where each one lives', () => {
  it('should list the logins sorted by id, each with the runtimes that use it sorted', async () => {
    const { catalog } = catalogOf({ usedBy: id => (id === 'claude-work' ? ['zeta', 'alpha'] : []) });
    const { entries } = await catalog.entries();
    should(entries.map(entry => entry.id)).eql(['claude-work', 'claude-you', 'codex-team', 'glm']);
    should(entries[0]?.usedBy).eql(['alpha', 'zeta']);
    should(entries[1]?.usedBy).eql([]);
  });

  it('should say the logins could not be read, with the reason when there is one', async () => {
    for (const [thrown, reason] of [
      [new Error('config is broken'), 'config is broken'],
      [new Error(''), 'unreadable'],
      ['not an error', 'unreadable'],
    ] as const) {
      const { catalog } = catalogOf({
        logins: () => {
          throw thrown;
        },
      });
      const refusal = await rejection(catalog.entries());
      should(refusal.code).equal('fleet_credentials_unreadable');
      should(refusal.message).equal(`this machine's logins could not be read, so they cannot be listed: ${reason}`);
    }
  });

  it('should refuse a login that does not exist, by id', async () => {
    const refusal = await rejection(catalogOf().catalog.entry('nobody'));
    should(refusal.code).equal('fleet_credential_unknown');
    should(refusal.message).equal('no login "nobody" exists on this machine');
  });

  it('should read a stored login as unreachable when this build cannot name the directories', async () => {
    const { catalog } = catalogOf(NO_PATHS);
    const work = await entryOf(catalog, 'claude-work');
    should(work.resolution).match({ unavailable: /cannot reach the directories logins are signed in to/u });
  });

  it('should take a resolution the host gives over its own', async () => {
    const { catalog } = catalogOf({
      resolveStore: (_id, credential) => ({
        harness: credential.harness,
        store: 'host',
        unavailable: 'the host says no',
      }),
    });
    should((await entryOf(catalog, 'claude-work')).resolution).match({ unavailable: 'the host says no' });
  });
});

describe('FleetCredentialCatalog — where each login’s email is recorded', () => {
  it('should look in the person’s own .claude.json for a host Claude login, and in the store’s sign-in directory for an owned one', async () => {
    const { catalog } = catalogOf();
    should(catalog.emailSource(await entryOf(catalog, 'claude-you'))).eql({
      harness: 'claude',
      accountFile: '/people/you/.claude.json',
    });
    should(catalog.emailSource(await entryOf(catalog, 'claude-work'))).eql({
      harness: 'claude',
      accountFile: '/fy/fleet/credentials/claude-work/sign-in/.claude.json',
    });
  });

  it('should name the Codex store for a Codex login, and nothing for one with no store', async () => {
    const { catalog } = catalogOf();
    should(catalog.emailSource(await entryOf(catalog, 'codex-team'))).match({ harness: 'codex' });
    should(catalog.emailSource(await entryOf(catalog, 'glm'))).be.undefined();
    const unreachable = catalogOf(NO_PATHS);
    should(unreachable.catalog.emailSource(await entryOf(unreachable.catalog, 'claude-work'))).be.undefined();
  });
});

describe('FleetCredentialCatalog — what a sign-in launches', () => {
  it('should launch a host Claude login as the person’s own, with the empty secure-storage value and no directories', async () => {
    const { catalog, ensured } = catalogOf();
    const target = catalog.signInTarget(await entryOf(catalog, 'claude-you'));
    if (target.kind !== 'store') throw new Error('expected a store target');
    should(target.environment).eql({ [CLAUDE_SECURE_STORAGE_VARIABLE]: '' });
    should(target.arguments).eql([]);
    await target.prepare();
    should(ensured).eql([]);
  });

  it('should launch an owned Claude login in its own store, creating the store and the sign-in directory', async () => {
    const { catalog, ensured } = catalogOf();
    const target = catalog.signInTarget(await entryOf(catalog, 'claude-work'));
    if (target.kind !== 'store') throw new Error('expected a store target');
    should(target.environment).eql({
      [CLAUDE_SECURE_STORAGE_VARIABLE]: '/fy/fleet/credentials/claude-work',
      CLAUDE_CONFIG_DIR: '/fy/fleet/credentials/claude-work/sign-in',
    });
    await target.prepare();
    should(ensured).eql(['/fy/fleet/credentials/claude-work', '/fy/fleet/credentials/claude-work/sign-in']);
  });

  it('should launch Codex with its home and file storage forced', async () => {
    const { catalog, ensured } = catalogOf();
    const target = catalog.signInTarget(await entryOf(catalog, 'codex-team'));
    if (target.kind !== 'store') throw new Error('expected a store target');
    should(Object.keys(target.environment)).eql(['CODEX_HOME']);
    should(target.arguments[0]).equal('-c');
    await target.prepare();
    should(ensured).have.length(1);
  });

  it('should say there is nothing to sign in to for an environment login, and why a login cannot be reached', async () => {
    const { catalog } = catalogOf();
    should(catalog.signInTarget(await entryOf(catalog, 'glm'))).match({
      kind: 'refused',
      reason: '"glm" is authenticated by its environment variables, so there is nothing to sign in to',
    });
    const unreachable = catalogOf(NO_PATHS);
    should(unreachable.catalog.signInTarget(await entryOf(unreachable.catalog, 'claude-work'))).match({
      kind: 'refused',
    });
  });

  it('should check the store again each time: signed in when a usable login is there, with words when not', async () => {
    const inspections: CredentialStoreInspection[] = [
      { reading: { state: 'valid' }, checked: [] },
      { reading: { state: 'missing' }, checked: [{ location: 'the file /x.json', found: 'nothing' }] },
    ];
    const { catalog } = catalogOf({ inspect: async () => inspections.shift() as CredentialStoreInspection });
    const target = catalog.signInTarget(await entryOf(catalog, 'claude-work'));
    if (target.kind !== 'store') throw new Error('expected a store target');
    should(await target.check()).eql({ signedIn: true });
    should(await target.check()).eql({
      signedIn: false,
      finding: 'Checked the file /x.json — nothing there.',
    });
  });

  it('should say the store could not be read when looking in it throws', async () => {
    const { catalog } = catalogOf({
      inspect: async () => {
        throw new Error('keychain locked');
      },
    });
    const target = catalog.signInTarget(await entryOf(catalog, 'claude-work'));
    if (target.kind !== 'store') throw new Error('expected a store target');
    should(await target.check()).eql({
      signedIn: false,
      finding: 'The store this login is kept in could not be read.',
    });
  });
});

// ── The service ──────────────────────────────────────────────────────────────────────────────────

const statusOf = (id: string, word: 'ready' | 'needs_sign_in' = 'ready'): CredentialStatusView =>
  ({
    id,
    harness: id.startsWith('codex') ? 'codex' : 'claude',
    status: {
      word,
      reason: word === 'ready' ? 'access_current' : 'not_signed_in',
      lastCheckInconclusive: false,
    },
    usage: { fiveHour: {}, weekly: {} },
  }) as unknown as CredentialStatusView;

function serviceOf(
  overrides: Partial<FleetCredentialsServiceDeps> = {},
  catalogOverrides: Partial<FleetCredentialCatalogDeps> = {},
  logins: ReadonlyMap<string, LoginFile> = FILES,
) {
  const seen: string[] = [];
  const runs: { command: readonly string[]; environment: Readonly<Record<string, string | undefined>> }[] = [];
  const { catalog } = catalogOf({ logins: () => logins, ...catalogOverrides });
  const service = new FleetCredentialsService({
    catalog,
    status: {
      view: async subject => {
        seen.push(`view ${subject.id}`);
        return statusOf(subject.id);
      },
      observe: async subject => {
        seen.push(`observe ${subject.id}`);
        return statusOf(subject.id);
      },
      checkNow: async subject => {
        seen.push(`check ${subject.id}`);
        return statusOf(subject.id);
      },
    },
    email: async () => undefined,
    machineName: () => 'box',
    locate: harness => `/usr/bin/${harness}`,
    run: async spec => {
      runs.push(spec);
      return 0;
    },
    baseEnvironment: () => ({ PATH: '/usr/bin' }),
    ...overrides,
  });
  return { service, seen, runs };
}

describe('FleetCredentialsService — listing', () => {
  it('should list every login with its status, who uses it and the acts it offers', async () => {
    const { service } = serviceOf({}, { usedBy: id => (id === 'claude-work' ? ['main'] : []) });
    const list = await service.list();
    should(list).match({ format: 1, machine: 'box' });
    should(list.logins.map(login => login.id)).eql(['claude-work', 'claude-you', 'codex-team', 'glm']);
    const work = list.logins.find(login => login.id === 'claude-work');
    should(work).match({ label: 'Work', usedBy: ['main'], sharedWithTerminal: false, status: { word: 'ready' } });
    should(work?.signOut.sentence).equal('Sign out of Work? 1 runtime will need sign-in.');
    should(list.logins.find(login => login.id === 'claude-you')?.signOut.sentence).equal(
      'Sign out of claude-you? This also signs out claude in your terminal on box. No runtime uses it.',
    );
    should(list.logins.find(login => login.id === 'glm')).match({
      checkNow: { available: false },
      signIn: {
        available: false,
        reason: '"glm" is authenticated by its environment variables, so there is nothing to sign in to.',
      },
    });
  });

  it('should not read twice for two lists asked together, and read again after a failure', async () => {
    let failing = true;
    const { service, seen } = serviceOf({
      status: {
        view: async subject => {
          seen.push(`view ${subject.id}`);
          if (failing) throw new Error('status unreadable');
          return statusOf(subject.id);
        },
        observe: async subject => statusOf(subject.id),
        checkNow: async subject => statusOf(subject.id),
      },
    });
    const outcomes = await Promise.allSettled([service.list(), service.list()]);
    should(outcomes.map(outcome => outcome.status)).eql(['rejected', 'rejected']);
    should(seen.filter(entry => entry === 'view claude-work')).have.length(1);

    failing = false;
    should((await service.list()).logins).have.length(4);
  });

  it('should carry the label rule: two logins of one harness with one email need labels that differ', async () => {
    const twins = files({
      one: { harness: 'claude-code' },
      two: { harness: 'claude-code', label: 'Second' },
      four: { harness: 'claude-code', label: 'Second' },
      five: { harness: 'claude-code', label: 'Distinct' },
      three: { harness: 'codex' },
    });
    const { service } = serviceOf({ email: async () => 'you@example.com' }, {}, twins);
    const list = await service.list();
    should(list.logins.map(login => [login.id, login.needsLabel])).eql([
      ['five', false],
      ['four', true],
      ['one', true],
      ['three', false],
      ['two', true],
    ]);
  });

  it('should carry where a clone came from, a disabled block and a budget it was stood against', async () => {
    const special = files({
      cloned: {
        harness: 'claude-code',
        clonedFrom: 'claude-work',
        clonedFromDaemon: 'other-box',
        disabled: { reason: 'spend limit', until: '2099-01-01' },
        budget: { daily: { hard: 5 } },
      },
    });
    const budget = {
      timeZone: 'UTC',
      timeZoneSet: true,
      level: 'ok',
      unpriced: 0,
      measured: true,
    };
    const { service } = serviceOf({ budget: { view: () => budget as never } }, {}, special);
    const [login] = (await service.list()).logins;
    should(login).match({
      clonedFrom: 'claude-work',
      clonedFromDaemon: 'other-box',
      disabled: { reason: 'spend limit', source: 'login' },
      budget,
    });
  });

  it('should lay an environment login’s provider quota over its usage', async () => {
    const reading: ProviderQuotaReading = {
      source: 'zai-coding-plan',
      via: 'endpoint',
      windows: [
        { label: '5h', usedPercent: 12, resetsAt: '2026-11-01T15:00:00.000Z' as never },
        { label: 'week', usedPercent: 40 },
      ],
      exhausted: false,
      unverified: false,
      at: '2026-11-01T10:00:00.000Z' as never,
    };
    const { service } = serviceOf({ providerQuota: { peek: id => (id === 'glm' ? reading : undefined) } });
    const glm = (await service.list()).logins.find(login => login.id === 'glm');
    should(glm?.usage).match({
      fiveHour: { usedPercent: 12, resetsAt: '2026-11-01T15:00:00.000Z' },
      weekly: { usedPercent: 40 },
      source: 'provider-quota',
      provider: { source: 'zai-coding-plan' },
    });
  });
});

describe('FleetCredentialsService — the usage pass and Check now', () => {
  it('should observe only the stored logins asked for, and say nothing when the logins cannot be read', async () => {
    const { service, seen } = serviceOf();
    await service.observeAll(['claude-work', 'glm']);
    should(seen).eql(['observe claude-work']);
    await service.observeAll();
    should(seen.filter(entry => entry.startsWith('observe'))).have.length(1 + 3);

    const broken = serviceOf(
      {},
      {
        logins: () => {
          throw new Error('unreadable');
        },
      },
    );
    await broken.service.observeAll();
    should(broken.seen).eql([]);
  });

  it('should refuse a Check now from a caller nobody can vouch for', async () => {
    const refusal = await rejection(serviceOf().service.check('claude-work', undefined));
    should(refusal.code).equal('fleet_credential_unauthorized');
  });

  it('should check a login now and answer its row', async () => {
    const { service, seen } = serviceOf();
    const row = await service.check('claude-work', GOVERNANCE);
    should(row.id).equal('claude-work');
    should(seen).eql(['check claude-work']);
  });

  it('should refuse a Check now for a login that does not exist, or one that has nothing to check', async () => {
    const { service } = serviceOf();
    should((await rejection(service.checkForLaunch('nobody'))).code).equal('fleet_credential_unknown');
    const environment = await rejection(service.checkForLaunch('glm'));
    should(environment.code).equal('fleet_credential_unavailable');
    should(environment.message).equal('This login comes from environment variables, so there is nothing to check.');
    const unreachable = serviceOf({}, NO_PATHS);
    should((await rejection(unreachable.service.checkForLaunch('claude-work'))).code).equal(
      'fleet_credential_unavailable',
    );
  });
});

describe('FleetCredentialsService — signing out', () => {
  const afterLogout = (word: 'ready' | 'needs_sign_in', code = 0) => {
    let signedOut = false;
    const ran: { command: readonly string[]; environment: Readonly<Record<string, string | undefined>> }[] = [];
    const world = serviceOf({
      status: {
        view: async subject => statusOf(subject.id, signedOut ? word : 'ready'),
        observe: async subject => statusOf(subject.id),
        checkNow: async subject => statusOf(subject.id),
      },
      run: async spec => {
        ran.push(spec);
        signedOut = true;
        return code;
      },
    });
    return { service: world.service, runs: ran };
  };

  it('should run the harness’s own logout against the one store and report the login signed out', async () => {
    const { service, runs } = afterLogout('needs_sign_in');
    const outcome = await service.signOut('claude-work');
    should(outcome.outcome).equal('signed-out');
    should(runs[0]?.command).eql(['/usr/bin/claude', 'auth', 'logout']);
    should(runs[0]?.environment).match({
      PATH: '/usr/bin',
      [CLAUDE_SECURE_STORAGE_VARIABLE]: '/fy/fleet/credentials/claude-work',
    });
  });

  it('should say a Codex login is signed out with codex logout, in its own home', async () => {
    const { service, runs } = afterLogout('needs_sign_in');
    await service.signOut('codex-team');
    should(runs[0]?.command.slice(-1)).eql(['logout']);
    should(Object.keys(runs[0]?.environment ?? {})).containEql('CODEX_HOME');
  });

  it('should say a login that is still there afterwards failed to sign out, by the harness’s exit code', async () => {
    const quiet = afterLogout('ready', 0);
    should(await quiet.service.signOut('claude-work')).match({
      outcome: 'failed',
      reason: 'the harness said it signed out, but a login is still there',
    });
    const failing = afterLogout('ready', 3);
    should(await failing.service.signOut('claude-work')).match({
      outcome: 'failed',
      reason: 'the harness could not sign out (it exited with code 3)',
    });
  });

  it('should say the harness command is not installed rather than run nothing', async () => {
    const { service, runs } = serviceOf({ locate: () => undefined });
    should(await service.signOut('claude-work')).match({
      outcome: 'failed',
      reason: 'the claude command is not installed on this machine, so its login could not be signed out',
    });
    should(runs).eql([]);
  });

  it('should refuse a login that does not exist, one with nothing to sign out of, and one that cannot be reached', async () => {
    const { service } = serviceOf();
    should((await rejection(service.signOut('nobody'))).code).equal('fleet_credential_unknown');
    const environment = await rejection(service.signOut('glm'));
    should(environment.code).equal('fleet_credential_unavailable');
    should(environment.message).equal(
      '"glm" is authenticated by its environment variables, so there is nothing to sign out of.',
    );
    const unreachable = serviceOf({}, NO_PATHS);
    should((await rejection(unreachable.service.signOut('claude-work'))).message).equal(
      'This login cannot be reached on this machine.',
    );
  });
});

describe('FleetCredentialsService — Test and the presets', () => {
  const tested: unknown[] = [];
  const environment = (presets: ProviderPresetCatalog = { presets: [] }) => ({
    catalog: async () => presets,
    presets: async () => [{ id: 'zai-glm' } as never],
    secretNames: async () => new Set<string>(['ZAI_API_KEY']),
    test: async (subject: unknown, consent: unknown) => {
      tested.push([subject, consent]);
      return {
        loginId: 'glm',
        ok: true,
        code: 'ok',
        message: 'Works.',
        spent: 'nothing',
        at: '2026-11-01T10:00:00.000Z',
      } as never;
    },
  });

  it('should refuse a Test from a caller nobody can vouch for', async () => {
    should((await rejection(serviceOf().service.test('glm', { allowInference: false }, undefined))).code).equal(
      'fleet_credential_unauthorized',
    );
  });

  it('should refuse a Test of a sign-in, and when this daemon has no environment support', async () => {
    const withEnvironment = serviceOf({ environment: environment() });
    const sentence = 'Only a login made from environment variables has a Test. Use Check now for a sign-in.';
    should(
      (await rejection(withEnvironment.service.test('claude-work', { allowInference: false }, GOVERNANCE))).message,
    ).equal(sentence);
    should((await rejection(serviceOf().service.test('glm', { allowInference: false }, GOVERNANCE))).message).equal(
      sentence,
    );
  });

  it('should hand the login, its preset and the consent to the Test', async () => {
    tested.length = 0;
    const logins = files({
      glm: { harness: 'claude-code', store: 'environment', preset: 'zai-glm', env: { A: '${secret:ZAI_API_KEY}' } },
    });
    const { service } = serviceOf({ environment: environment() }, {}, logins);
    const result = await service.test('glm', { allowInference: true }, GOVERNANCE);
    should(result.ok).be.true();
    should(tested[0]).match([{ id: 'glm', preset: { id: 'zai-glm' } }, { allowInference: true }]);
  });

  it('should offer the presets this daemon has, and none when it has none', async () => {
    should(await serviceOf().service.presets()).eql({ presets: [] });
    const catalog = { presets: [] } as ProviderPresetCatalog;
    should(await serviceOf({ environment: environment(catalog) }).service.presets()).equal(catalog);
  });
});

describe('attributedTranscripts — only a session this daemon launched on the login', () => {
  it('should name the transcripts of sessions on the login’s runtimes, once each and in order', () => {
    const sessions = [
      { agent: 'b', transcript: { home: '/h', file: '/h/b.jsonl' } },
      { agent: 'a', transcript: { home: '/h', file: '/h/a.jsonl' } },
      { agent: 'a', transcript: { home: '/h', file: '/h/a.jsonl' } },
      { agent: 'other', transcript: { home: '/h', file: '/h/other.jsonl' } },
      { agent: 'a', transcript: { home: '/h' } },
      { agent: 'a' },
    ];
    should(attributedTranscripts({ usedBy: ['a', 'b'] }, sessions)).eql(['/h/a.jsonl', '/h/b.jsonl']);
    should(attributedTranscripts({ usedBy: [] }, sessions)).eql([]);
  });
});
