/**
 * The default account per place (docs/config-files.md, `account-defaults.yaml`), at the daemon's front door.
 *
 * The REAL secret subsystem and the REAL configuration files service run over in-memory stores, because the
 * guarantees here are about how they act together: a ferret's line is only ever a held suggestion, the owner's
 * one-line write is in effect at once without confirming a ferret's other lines, a paired device needs the
 * passkey step-up, and an account's delete, merge or rename moves the lines in the same act — never leaving a line
 * a later account of the same handle could inherit.
 */
import { describe, it } from 'bun:test';
import { createHash } from 'node:crypto';
import type { AcceptedConfigFiles, ConfigFileText } from '@ferretry/fleet';
import { type AccountId, STEP_UP_REQUIRED_CODE } from '@ferretry/protocol';
import should from 'should';
import type { AuthenticatedCredential } from '../../../../src/lib/api/authentication.ts';
import type { CallerGovernance } from '../../../../src/lib/api/capability.ts';
import { ApiError } from '../../../../src/lib/api/error.ts';
import type { ApiResponse } from '../../../../src/lib/api/http.ts';
import type { RouteContext } from '../../../../src/lib/api/route.ts';
import { ApiRouter } from '../../../../src/lib/api/router.ts';
import {
  type AcceptedConfigStore,
  type ConfigDirectoryPort,
  ConfigFilesService,
} from '../../../../src/lib/config-files/index.ts';
import { type SecretSubsystem, secretRoutes } from '../../../../src/lib/runtime/mounts/secrets.ts';
import { AccountDefaults } from '../../../../src/lib/secrets/index.ts';
import { jsonBody, request } from '../../api/support.ts';
import { secretSubsystem } from './support.ts';

const PATH = 'account-defaults.yaml';
const digest = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

class MemoryDirectory implements ConfigDirectoryPort {
  readonly directory = '/home/operator/.fy/config';
  readonly texts = new Map<string, string>();
  async list(): Promise<{ readonly files: readonly ConfigFileText[]; readonly unreadable: readonly string[] }> {
    return { files: [...this.texts].map(([path, text]) => ({ path, text })), unreadable: [] };
  }
  async fingerprint(): Promise<string> {
    return [...this.texts.entries()].join('\n');
  }
  async read(path: string): Promise<string | undefined> {
    return this.texts.get(path);
  }
  async write(path: string, text: string): Promise<void> {
    this.texts.set(path, text);
  }
  async remove(path: string): Promise<void> {
    this.texts.delete(path);
  }
  async writeSchemas(): Promise<void> {}
}

class MemoryAccepted implements AcceptedConfigStore {
  accepted: AcceptedConfigFiles = {};
  async read(): Promise<AcceptedConfigFiles> {
    return this.accepted;
  }
  async write(accepted: AcceptedConfigFiles): Promise<void> {
    this.accepted = accepted;
  }
}

interface Caller {
  readonly kind: 'host' | 'device' | 'agent';
  readonly fresh?: boolean;
}
const HOST: Caller = { kind: 'host' };
const DEVICE: Caller = { kind: 'device' };
const FRESH_DEVICE: Caller = { kind: 'device', fresh: true };
const FERRET: Caller = { kind: 'agent' };

const CREDENTIAL: Record<Caller['kind'], AuthenticatedCredential> = {
  host: { kind: 'authenticated', tokenClass: 'admin' },
  device: { kind: 'authenticated', tokenClass: 'device', deviceId: 'd1' },
  agent: { kind: 'authenticated', tokenClass: 'admin' },
};
const ACTOR: Record<Caller['kind'], string> = { host: 'admin-cli', device: 'device:d1', agent: 'peer:s1' };

interface World {
  readonly directory: MemoryDirectory;
  readonly config: ConfigFilesService;
  readonly subsystem: SecretSubsystem;
  readonly defaults: AccountDefaults;
  readonly projects: { id: string; name: string }[];
  drive(caller: Caller, method: string, path: string, body?: unknown, using?: SecretSubsystem): Promise<Answer>;
}

interface Answer {
  readonly status: number;
  readonly code?: string;
  readonly body?: Record<string, unknown>;
  readonly spent: number;
  /** Whether the request body was read: a refusal that comes first leaves it unread. */
  readonly consumed: boolean;
}

async function world(): Promise<World> {
  const directory = new MemoryDirectory();
  const config = new ConfigFilesService({
    directory,
    accepted: new MemoryAccepted(),
    log: { issue: () => undefined, pending: () => undefined },
    digest,
    now: () => new Date('2026-10-16T09:00:00.000Z'),
  });
  const projects: { id: string; name: string }[] = [];
  const base = secretSubsystem();
  const defaults = new AccountDefaults({
    config,
    listing: async () => await (base.accounts as NonNullable<SecretSubsystem['accounts']>).list(),
    projects: async () =>
      projects.map(p => ({ ...p, path: '/srv', source: 'existing-folder', createdAt: '' })) as never,
  });
  const subsystem: SecretSubsystem = { ...base, accountDefaults: defaults };
  const accounts = subsystem.accounts as NonNullable<SecretSubsystem['accounts']>;
  accounts.followDefaultsWith(async changes => await defaults.repoint(changes));
  config.warnWith(async snapshot => await defaults.warnings(await accounts.list(), snapshot));
  const drive = async (
    caller: Caller,
    method: string,
    path: string,
    body?: unknown,
    using: SecretSubsystem = subsystem,
  ): Promise<Answer> => {
    const found = new ApiRouter(secretRoutes(using)).lookup(method, path);
    if (found.kind !== 'matched') throw new Error(`no route ${method} ${path}`);
    let spent = 0;
    const reads = { limits: [], consumed: false, discarded: false };
    const governance: CallerGovernance = {
      governed: caller.kind === 'device',
      decide: () => ({ allowed: true, refusal: 'granted' }),
    };
    const context: RouteContext = {
      request: request({
        method,
        path,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        reads,
      }),
      params: found.params,
      actor: ACTOR[caller.kind],
      credential: CREDENTIAL[caller.kind],
      governance,
      presentation: {
        loopback: caller.kind !== 'device',
        adminToken: caller.kind !== 'device',
        actor: ACTOR[caller.kind],
        stepUp: caller.fresh === true,
        freshStepUp: caller.fresh === true,
      },
      spendFreshStepUp: () => {
        spent += 1;
      },
    };
    let response: ApiResponse;
    try {
      response = await found.route.handle(context);
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      return { status: error.status, code: error.code, spent, consumed: reads.consumed };
    }
    const parsed = jsonBody(response) as Record<string, unknown>;
    return {
      status: response.status,
      body: parsed,
      ...(typeof parsed.code === 'string' ? { code: parsed.code } : {}),
      spent,
      consumed: reads.consumed,
    };
  };
  return { directory, config, subsystem, defaults, projects, drive };
}

const SITE_LINE = { scope: 'sites', key: 'app.clickup.com', account: 'CLICKUP_A' } as const;

/** Two ClickUp accounts that each sign in to app.clickup.com, and an unrelated one. */
async function withAccounts(w: World): Promise<void> {
  const accounts = w.subsystem.accounts as NonNullable<SecretSubsystem['accounts']>;
  for (const [id, domains] of [
    ['CLICKUP_A', ['app.clickup.com']],
    ['CLICKUP_B', ['app.clickup.com']],
    ['GITHUB', ['github.com']],
  ] as const) {
    await accounts.putAccount(id as AccountId, { label: id });
    await accounts.addSignIn(id as AccountId, { place: { kind: 'site', domains: [...domains], match: [] } });
  }
}

const text = (w: World): string | undefined => w.directory.texts.get(PATH);
const inEffect = async (w: World) => (await w.config.load()).evaluation.effective.accountDefaults;

describe('PUT /v1/accounts/defaults', () => {
  it('should write one line, in effect at once, when the owner is at the machine', async () => {
    const w = await world();
    await withAccounts(w);

    const answer = await w.drive(HOST, 'PUT', '/v1/accounts/defaults', SITE_LINE);

    should(answer.status).equal(200);
    should(answer.body).deepEqual({ defaults: { sites: { 'app.clickup.com': 'CLICKUP_A' } } });
    should(await inEffect(w)).deepEqual({ sites: { 'app.clickup.com': 'CLICKUP_A' } });
    should((await w.config.load()).evaluation.pending).deepEqual([]);
  });

  it('should keep the owner’s comments and other lines when it changes one', async () => {
    const w = await world();
    await withAccounts(w);
    await w.config.writeOwn(PATH, '# my defaults\nsites:\n  github.com: GITHUB # work\n');

    await w.drive(HOST, 'PUT', '/v1/accounts/defaults', SITE_LINE);

    should(text(w)).containEql('# my defaults');
    should(text(w)).containEql('github.com: GITHUB # work');
    should(text(w)).containEql('app.clickup.com: CLICKUP_A');
  });

  it('should remove a line with null', async () => {
    const w = await world();
    await withAccounts(w);
    await w.drive(HOST, 'PUT', '/v1/accounts/defaults', SITE_LINE);

    const answer = await w.drive(HOST, 'PUT', '/v1/accounts/defaults', { ...SITE_LINE, account: null });

    should(answer.status).equal(200);
    should(await inEffect(w)).deepEqual({});
  });

  it('should refuse a ferret before reading the body, and write nothing', async () => {
    const w = await world();
    const answer = await w.drive(FERRET, 'PUT', '/v1/accounts/defaults', SITE_LINE);

    should(answer.status).equal(403);
    should(answer.code).equal('forbidden');
    should(answer.consumed).be.false();
    should(text(w)).be.undefined();
  });

  it('should ask a paired device for the passkey step-up, then spend it on the one write', async () => {
    const w = await world();
    await withAccounts(w);

    const asked = await w.drive(DEVICE, 'PUT', '/v1/accounts/defaults', SITE_LINE);
    should(asked.status).equal(403);
    should(asked.code).equal(STEP_UP_REQUIRED_CODE);
    should(text(w)).be.undefined();

    const done = await w.drive(FRESH_DEVICE, 'PUT', '/v1/accounts/defaults', SITE_LINE);
    should(done.status).equal(200);
    should(done.spent).equal(1);
    should(await inEffect(w)).deepEqual({ sites: { 'app.clickup.com': 'CLICKUP_A' } });
  });

  it('should refuse a body that names a place wrongly', async () => {
    const w = await world();
    for (const body of [
      { ...SITE_LINE, key: 'App.ClickUp.com' },
      { ...SITE_LINE, within: 'ferretry' },
      { scope: 'projects', key: 'github.com', account: 'GITHUB' },
    ]) {
      const answer = await w.drive(HOST, 'PUT', '/v1/accounts/defaults', body);
      should(answer.status).equal(400);
    }
    should(text(w)).be.undefined();
  });

  it('should not write over a defaults file that does not check', async () => {
    const w = await world();
    await withAccounts(w);
    w.directory.texts.set(PATH, 'sites: [this is not a map\n');

    const answer = await w.drive(HOST, 'PUT', '/v1/accounts/defaults', SITE_LINE);

    should(answer.status).equal(409);
    should(answer.code).equal('defaults_file_invalid');
    should(text(w)).equal('sites: [this is not a map\n');
  });

  it('should refuse a line for an account with no sign-in on that place, and one that does not exist', async () => {
    const w = await world();
    await withAccounts(w);

    for (const account of ['GITHUB', 'NOBODY']) {
      const answer = await w.drive(HOST, 'PUT', '/v1/accounts/defaults', { ...SITE_LINE, account });
      should(answer.status).equal(409);
      should(answer.code).equal('no_sign_in_here');
    }
    should(text(w)).be.undefined();
  });

  it('should always allow clearing a line, even one that names an account that is gone', async () => {
    const w = await world();
    await w.config.writeOwn(PATH, 'sites:\n  app.clickup.com: GONE\n');

    const answer = await w.drive(HOST, 'PUT', '/v1/accounts/defaults', { ...SITE_LINE, account: null });

    should(answer.status).equal(200);
    should(answer.body).deepEqual({ defaults: {} });
    should(await inEffect(w)).deepEqual({});
  });

  it('should answer what is actually in effect after the write, when a ferret holds the same line', async () => {
    const w = await world();
    await withAccounts(w);
    await w.config.write(PATH, 'sites:\n  app.clickup.com: CLICKUP_B\n', undefined, false);
    should(await inEffect(w)).deepEqual({});

    const answer = await w.drive(HOST, 'PUT', '/v1/accounts/defaults', { ...SITE_LINE, account: 'CLICKUP_B' });

    should(answer.body).deepEqual({ defaults: await inEffect(w) });
    should(await inEffect(w)).deepEqual({ sites: { 'app.clickup.com': 'CLICKUP_B' } });
    should((await w.config.load()).evaluation.pending).deepEqual([]);
  });

  it('should leave a ferret’s other held lines held, and confirm only the owner’s one line', async () => {
    const w = await world();
    await withAccounts(w);
    // A ferret suggests a line for github.com through its ordinary config write: it is held.
    const suggested = await w.config.write(PATH, 'sites:\n  github.com: GITHUB\n', undefined, false);
    should(suggested.outcome).equal('pending');
    should(await inEffect(w)).deepEqual({});

    // The owner sets a different line.
    await w.drive(HOST, 'PUT', '/v1/accounts/defaults', SITE_LINE);

    // The owner's line is in effect; the ferret's is still waiting for the owner's own confirmation.
    should(await inEffect(w)).deepEqual({ sites: { 'app.clickup.com': 'CLICKUP_A' } });
    const pending = (await w.config.load()).evaluation.pending;
    should(pending.map(p => p.path)).deepEqual([PATH]);
    should(pending[0]?.changes).deepEqual([
      'changes which account a card offers first for github.com in every session on this machine',
    ]);
    should(text(w)).containEql('github.com: GITHUB');
  });
});

describe('the route table', () => {
  it('should not mount the defaults route when there are no defaults, so the handle route takes the path', async () => {
    const w = await world();
    const using: SecretSubsystem = { ...w.subsystem, accountDefaults: undefined };

    const found = new ApiRouter(secretRoutes(using)).lookup('PUT', '/v1/accounts/defaults');

    should(found.kind).equal('matched');
    should(found.kind === 'matched' && found.route.path).equal('/v1/accounts/:id');
  });

  it('should let an error that is not the file’s or the sign-in’s propagate', async () => {
    const w = await world();
    const using: SecretSubsystem = {
      ...w.subsystem,
      accountDefaults: {
        set: async () => {
          throw new Error('the disk is gone');
        },
      } as unknown as AccountDefaults,
    };

    await w.drive(HOST, 'PUT', '/v1/accounts/defaults', SITE_LINE, using).should.be.rejectedWith('the disk is gone');
  });
});

describe('a ferret’s write to account-defaults.yaml', () => {
  it('should only ever be a held suggestion: nothing is in effect until the owner confirms', async () => {
    const w = await world();
    await withAccounts(w);

    const answer = await w.config.write(PATH, 'sites:\n  app.clickup.com: CLICKUP_B\n', undefined, false);

    should(answer.outcome).equal('pending');
    should(await inEffect(w)).deepEqual({});
  });
});

describe('the defaults follow the owner’s account acts', () => {
  const accountsOf = (w: World) => w.subsystem.accounts as NonNullable<SecretSubsystem['accounts']>;
  const seed = async (w: World, lines: string) => {
    await withAccounts(w);
    await w.config.writeOwn(PATH, lines);
  };

  it('should follow a rename: the line names the new handle in the same act', async () => {
    const w = await world();
    await seed(w, 'sites:\n  app.clickup.com: CLICKUP_A\n');

    await accountsOf(w).renameAccount('CLICKUP_A' as AccountId, 'CLICKUP_WORK' as AccountId);

    should(await inEffect(w)).deepEqual({ sites: { 'app.clickup.com': 'CLICKUP_WORK' } });
  });

  it('should drop a deleted account’s lines, so a new account with that handle inherits nothing', async () => {
    const w = await world();
    await seed(w, 'sites:\n  app.clickup.com: CLICKUP_A\nprojects:\n  ferretry:\n    github.com: CLICKUP_A\n');

    await accountsOf(w).removeAccount('CLICKUP_A' as AccountId);
    should(await inEffect(w)).deepEqual({});

    await accountsOf(w).putAccount('CLICKUP_A' as AccountId, { label: 'A again' });
    should(await inEffect(w)).deepEqual({});
    should(text(w)).not.containEql('CLICKUP_A');
  });

  const lineOfA = 'sites:\n  app.clickup.com: CLICKUP_A\n';
  const reuse = async (w: World) => {
    await accountsOf(w).removeAccount('CLICKUP_A' as AccountId);
    should(await inEffect(w)).deepEqual({});
    await accountsOf(w).putAccount('CLICKUP_A' as AccountId, { label: 'A again' });
    await accountsOf(w).addSignIn('CLICKUP_A' as AccountId, {
      place: { kind: 'site', domains: ['app.clickup.com'], match: [] },
    });
    should(await inEffect(w)).deepEqual({});
  };

  it('should not let a reused handle inherit when a ferret’s held suggestion lacks the line', async () => {
    const w = await world();
    await seed(w, lineOfA);
    await w.config.write(PATH, 'sites:\n  github.com: GITHUB\n', undefined, false);
    should((await w.config.load()).evaluation.pending.map(p => p.path)).deepEqual([PATH]);

    await reuse(w);

    should((await w.config.load()).evaluation.pending.map(p => p.path)).deepEqual([PATH]);
  });

  it('should not let a reused handle inherit when the file’s deletion is held', async () => {
    const w = await world();
    await seed(w, lineOfA);
    w.directory.texts.delete(PATH);

    await reuse(w);
  });

  it('should not let a reused handle inherit when the file does not check', async () => {
    const w = await world();
    await seed(w, lineOfA);
    w.directory.texts.set(PATH, 'sites: [broken\n');

    await reuse(w);

    should(text(w)).equal('sites: [broken\n');
  });

  it('should strip a stale line that names a handle the moment an account is created with it', async () => {
    const w = await world();
    await withAccounts(w);
    // A line left over from an account that is gone (a rewrite that failed): it names a handle nobody holds.
    await w.config.writeOwn(PATH, 'sites:\n  app.clickup.com: GHOST\n');

    await accountsOf(w).putAccount('GHOST' as AccountId, { label: 'Somebody new' });

    should(await inEffect(w)).deepEqual({});
  });

  it('should strip a stale line when an account is renamed to the handle it names', async () => {
    const w = await world();
    await withAccounts(w);
    await w.config.writeOwn(PATH, 'sites:\n  github.com: GHOST\n  app.clickup.com: CLICKUP_A\n');

    await accountsOf(w).renameAccount('CLICKUP_A' as AccountId, 'GHOST' as AccountId);

    should(await inEffect(w)).deepEqual({ sites: { 'app.clickup.com': 'GHOST' } });
  });

  it('should follow a merge: the lines name the account that kept the sign-ins', async () => {
    const w = await world();
    await seed(w, 'sites:\n  app.clickup.com: CLICKUP_B\nprojects:\n  ferretry:\n    github.com: GITHUB\n');
    const accounts = accountsOf(w);
    // GITHUB keeps; CLICKUP_B signs in somewhere GITHUB does not, so the merge moves its sign-in over.
    await accounts.merge('GITHUB' as AccountId, 'CLICKUP_B' as AccountId);

    should((await accounts.list()).accounts.map(account => account.id)).not.containEql('CLICKUP_B');
    should(await inEffect(w)).deepEqual({
      sites: { 'app.clickup.com': 'GITHUB' },
      projects: { ferretry: { 'github.com': 'GITHUB' } },
    });
  });

  it('should leave the account change standing when the defaults file cannot be rewritten', async () => {
    const w = await world();
    await seed(w, 'sites:\n  app.clickup.com: CLICKUP_A\n');
    w.directory.texts.set(PATH, 'sites: [broken\n');

    await accountsOf(w).renameAccount('CLICKUP_A' as AccountId, 'CLICKUP_WORK' as AccountId);

    should((await accountsOf(w).list()).accounts.map(a => a.id)).containEql('CLICKUP_WORK');
    should(text(w)).equal('sites: [broken\n');
    should(await inEffect(w)).deepEqual({ sites: { 'app.clickup.com': 'CLICKUP_WORK' } });
  });
});

describe('GET /v1/config/status warns for a line the daemon cannot use', () => {
  const warningsFor = async (w: World): Promise<string[]> =>
    (await w.config.status()).issues.filter(issue => issue.severity === 'warning').map(issue => issue.message);
  const accept = async (w: World, lines: string) => {
    await w.config.writeOwn(PATH, lines);
  };

  it('should warn about an account that does not exist, and say the line is ignored', async () => {
    const w = await world();
    await accept(w, 'sites:\n  app.clickup.com: NOBODY\n');

    const warnings = await warningsFor(w);

    should(warnings).have.length(1);
    should(warnings[0]).containEql('NOBODY is not an account');
    should(warnings[0]).containEql('ignored');
  });

  it('should warn about an account with no sign-in on that place', async () => {
    const w = await world();
    await withAccounts(w);
    await accept(w, 'sites:\n  app.clickup.com: GITHUB\n');

    const warnings = await warningsFor(w);

    should(warnings[0]).containEql('GITHUB has no sign-in on app.clickup.com');
  });

  it('should warn about a project that is not registered, and one two projects are called', async () => {
    const w = await world();
    await withAccounts(w);
    w.projects.push(
      { id: '11111111-1111-4111-8111-111111111111', name: 'twin' },
      { id: '22222222-2222-4222-8222-222222222222', name: 'twin' },
    );
    await accept(
      w,
      'projects:\n  nowhere:\n    app.clickup.com: CLICKUP_A\n  twin:\n    app.clickup.com: CLICKUP_A\n  11111111-1111-4111-8111-111111111111:\n    app.clickup.com: CLICKUP_A\n',
    );

    const warnings = await warningsFor(w);

    should(warnings).have.length(2);
    should(warnings.some(message => message.includes('no project is named nowhere'))).be.true();
    should(warnings.some(message => message.includes('more than one project is named twin'))).be.true();
  });

  it('should say nothing about a line that works', async () => {
    const w = await world();
    await withAccounts(w);
    await accept(w, 'sites:\n  app.clickup.com: CLICKUP_A\n');

    should(await warningsFor(w)).deepEqual([]);
  });

  it('should not warn about, or act on, a line that is only held for the owner', async () => {
    const w = await world();
    await w.config.write(PATH, 'sites:\n  app.clickup.com: NOBODY\n', undefined, false);

    should(await warningsFor(w)).deepEqual([]);
  });
});
