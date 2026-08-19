/**
 * The daemon side of a harness login: what it refuses, what it publishes, and what it does NOT keep.
 *
 * The fixture drives real domain objects — a parsed `FleetConfig`, a parsed `FleetManifest`, the fleet's
 * own `FleetIdentityService` and `FleetLoginService` — and fakes only the three things that touch a
 * machine: the credential store, the child, and the timer. So a test here fails when the login DECISION
 * is wrong rather than when a stub drifts.
 */
import { afterEach, describe, it } from 'bun:test';
import { readdir, readFile, rm, mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type CredentialCloneOutcome,
  type CredentialReading,
  type FleetConfig,
  FleetConfigSchema,
  type FleetCredentialStore,
  type FleetIdentityMember,
  type FleetManifest,
  FleetManifestSchema,
  type HarnessKind,
  type HarnessLoginDeclarations,
} from '@ferretry/fleet';
import type { FleetLoginReadiness, HarnessLoginSubmission } from '@ferretry/protocol';
import should from 'should';
import type { ChangeConfirmation } from '../../../src/lib/api/capability.ts';
import { ApiDispatcher } from '../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../src/lib/api/router.ts';
import {
  describeSource,
  HARNESS_LOGIN_WINDOW_MINUTES,
  HarnessLoginRefusal,
  HarnessLoginService,
} from '../../../src/lib/fleet-login/service.ts';
import type { HarnessLoginChild, HarnessLoginChildSpec } from '../../../src/lib/fleet-login/ports.ts';
import { harnessLoginRoutes } from '../../../src/lib/runtime/mounts/fleet-login.ts';
import { jsonBody, request } from '../api/support.ts';
import { CREDENTIALS, GOVERNED, GRANTED, human } from '../runtime/mounts/support.ts';

const ESC = '\u001b';
const BEL = '\u0007';

const INTERACTIVE_ID = '00000000-0000-4000-8000-000000000001';
const AUTO_ID = '00000000-0000-4000-8000-000000000002';
const CODEX_ID = '00000000-0000-4000-8000-000000000003';
const KEYED_ID = '00000000-0000-4000-8000-000000000004';

const NOW = Date.parse('2026-08-19T10:00:00.000Z');

/** Observed at claude-code 2.1.220 — the OSC 8 hyperlink and the PKCE challenge are both real. */
const CLAUDE_URL = 'https://claude.com/cai/oauth/authorize?code=true&code_challenge_method=S256&state=QxLN';
const CLAUDE_URL_LINE = `If the browser didn't open, visit: ${ESC}]8;;${CLAUDE_URL}${BEL}${CLAUDE_URL}${ESC}]8;;${BEL}`;

/** Observed at codex-cli 0.145.0. */
const CODEX_URL = 'https://auth.openai.com/codex/device';
const CODEX_URL_LINE = `   ${ESC}[94m${CODEX_URL}${ESC}[0m`;
const CODEX_CODE_LINE = `   ${ESC}[94m0IER-FFQW6${ESC}[0m`;

/**
 * A line shaped exactly like a credential the harness writes.
 *
 * The daemon reads harness output for the first time in this feature, so the test that matters is not
 * "does it redact this" — it is "does it ever hold it". The value is fed in as output and then looked
 * for in every answer the service can give and in everything on disk.
 */
const CREDENTIAL_SHAPED_LINE = '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-TESTONLY","refreshToken":"rt-TESTONLY"}}';

/** What a person pastes. Recognisable, so its absence from every answer is checkable. */
const PASTED_CODE = 'pasted-authorization-code-TESTONLY';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const parseConfig = (input: Record<string, unknown>): FleetConfig => {
  const parsed = FleetConfigSchema.safeParse(input);
  if (!parsed.success) throw new Error(`fixture config invalid: ${JSON.stringify(parsed.error.issues, null, 2)}`);
  return parsed.data;
};

const route = (id: string, wrapper: string, mode: 'interactive' | 'auto') => ({
  id,
  wrapper,
  home: wrapper,
  mode,
  defaultModel: 'model-one',
  models: ['model-one'],
});

/**
 * The declared fleet: one Claude identity of two lanes, one Codex identity, and one API-key account
 * whose key arrives from the secrets file.
 */
const CONFIG = parseConfig({
  secretsFile: '/etc/ferretry/secrets.sh',
  // Both lanes are declared, because a route may only name a variant this fleet has.
  variants: { default: {}, auto: {} },
  agents: [
    {
      name: 'kirin',
      kind: 'claude',
      routes: {
        default: route(INTERACTIVE_ID, 'claude-kirin', 'interactive'),
        auto: route(AUTO_ID, 'claude-auto', 'auto'),
      },
    },
    { name: 'kirin', kind: 'codex', routes: { default: route(CODEX_ID, 'codex-kirin', 'interactive') } },
    {
      name: 'proxy',
      kind: 'claude',
      auth: 'api-key',
      env: { ANTHROPIC_API_KEY: '$PROXY_KEY' },
      routes: { default: route(KEYED_ID, 'claude-proxy', 'interactive') },
    },
  ],
});

const manifestAccount = (id: string, kind: HarnessKind, wrapper: string, mode: 'interactive' | 'auto') => ({
  id,
  kind,
  mode,
  wrapper: `/fleet/bin/${wrapper}`,
  home: `/fleet/homes/${wrapper}`,
  displayName: wrapper,
  defaultModel: 'model-one',
  models: [{ id: 'model-one', available: true }],
  available: true,
  unavailableReason: null,
});

const MANIFEST: FleetManifest = FleetManifestSchema.parse({
  version: 1,
  generatedAt: '2026-08-19T09:00:00.000Z',
  accounts: [
    manifestAccount(INTERACTIVE_ID, 'claude', 'claude-kirin', 'interactive'),
    manifestAccount(AUTO_ID, 'claude', 'claude-auto', 'auto'),
    manifestAccount(CODEX_ID, 'codex', 'codex-kirin', 'interactive'),
    manifestAccount(KEYED_ID, 'claude', 'claude-proxy', 'interactive'),
  ],
});

/** A credential store that records every call and can be made to change its mind mid-flow. */
class RecordingStore implements FleetCredentialStore {
  readonly calls: string[] = [];
  readonly clones: string[] = [];
  #reading: CredentialReading = { state: 'missing' };

  constructor(private readonly signedIn: Set<string> = new Set()) {}

  /** What a home with no credential answers, and what it answers once the harness has written one. */
  signIn(accountId: string): void {
    this.signedIn.add(accountId);
  }

  fix(reading: CredentialReading): void {
    this.#reading = reading;
  }

  async read(kind: HarnessKind, member: FleetIdentityMember): Promise<CredentialReading> {
    this.calls.push(`read ${kind} ${member.accountId}`);
    return this.signedIn.has(member.accountId) ? { state: 'valid', expiresAt: NOW + 3_600_000 } : this.#reading;
  }

  async clone(
    kind: HarnessKind,
    donor: FleetIdentityMember,
    target: FleetIdentityMember,
  ): Promise<CredentialCloneOutcome> {
    this.clones.push(`clone ${kind} ${donor.accountId} -> ${target.accountId}`);
    this.signedIn.add(target.accountId);
    return { ok: true };
  }
}

/** One fake child. The test emits its output and decides when it exits. */
class FakeChild implements HarnessLoginChild {
  readonly written: string[] = [];
  killed = false;
  #settle: ((code: number) => void) | undefined;
  readonly exited: Promise<number>;
  /** Set to false to model a child that has stopped reading its stdin. */
  reading = true;

  constructor(readonly spec: HarnessLoginChildSpec) {
    this.exited = new Promise<number>(resolve => {
      this.#settle = resolve;
    });
  }

  emit(...lines: readonly string[]): void {
    for (const line of lines) this.spec.onLine(line);
  }

  write = async (value: string): Promise<boolean> => {
    if (!this.reading) return false;
    this.written.push(value);
    return true;
  };

  kill(): void {
    this.killed = true;
    this.#settle?.(143);
  }

  exit(code: number): void {
    this.#settle?.(code);
  }
}

interface Fixture {
  readonly service: HarnessLoginService;
  readonly store: RecordingStore;
  readonly children: FakeChild[];
  readonly timers: { milliseconds: number; run: () => void; disarmed: boolean }[];
  /** Let the not-awaited login work run. Everything in the fixture is synchronous or a microtask. */
  settle(): Promise<void>;
  /** The one child a flow spawned, once it has. */
  child(): Promise<FakeChild>;
}

interface FixtureOptions {
  readonly wrapperMissing?: boolean;
  readonly declarations?: HarnessLoginDeclarations;
  readonly confirmChange?: (password: string) => Promise<ChangeConfirmation>;
  readonly windowMinutes?: number;
  readonly now?: () => number;
  readonly store?: RecordingStore;
}

function fixture(options: FixtureOptions = {}): Fixture {
  const store = options.store ?? new RecordingStore();
  const children: FakeChild[] = [];
  const timers: { milliseconds: number; run: () => void; disarmed: boolean }[] = [];
  let minted = 0;

  const service = new HarnessLoginService({
    fleet: { config: async () => CONFIG, accounts: async () => MANIFEST },
    credentials: store,
    clock: { now: options.now ?? (() => NOW) },
    mintId: () => `flow${String(++minted).padStart(2, '0')}`,
    spawn: spec => {
      const child = new FakeChild(spec);
      children.push(child);
      return child;
    },
    // A provider credential the caller happens to hold, so the sanitizer has something to strip.
    environment: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'inherited-key-TESTONLY', PROXY_KEY: 'proxy-key' },
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a generated WRAPPER, where `${…}` is shell
    readWrapper: async () =>
      options.wrapperMissing === true ? undefined : 'export ANTHROPIC_BASE_URL="${FY_BASE}"\nexec claude "$@"\n',
    timer: {
      after: (milliseconds, run) => {
        const entry = { milliseconds, run, disarmed: false };
        timers.push(entry);
        return () => {
          entry.disarmed = true;
        };
      },
    },
    confirmChange: options.confirmChange ?? (async () => ({ kind: 'confirmed' })),
    clientName: 'fy',
    ...(options.windowMinutes === undefined ? {} : { windowMinutes: options.windowMinutes }),
    ...(options.declarations === undefined ? {} : { declarations: options.declarations }),
  });

  const settle = async (): Promise<void> => {
    for (let tick = 0; tick < 12; tick += 1) await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    for (let tick = 0; tick < 12; tick += 1) await Promise.resolve();
  };

  return {
    service,
    store,
    children,
    timers,
    settle,
    child: async () => {
      await settle();
      const child = children[0];
      if (child === undefined) throw new Error('no child was spawned');
      return child;
    },
  };
}

/** Every string a caller could read out of this service, for the values that must appear in none. */
async function everyAnswer(service: HarnessLoginService, flowId: string): Promise<string> {
  const readiness = await service.readiness();
  const status = await service.status(flowId);
  return JSON.stringify([readiness, status]);
}

const accountOf = (readiness: FleetLoginReadiness, accountId: string) => {
  const found = readiness.identities.flatMap(identity => identity.accounts).find(row => row.accountId === accountId);
  if (found === undefined) throw new Error(`no readiness row for ${accountId}`);
  return found;
};

/**
 * The host's own command line: holds the admin token, arrived on loopback, ungoverned.
 *
 * `governance` answers for ONE request, so a presentation is required rather than defaulted — which is
 * the point: there is no such thing as "where does this caller stand" without a caller.
 */
const HOST = GRANTED.governance({ loopback: true, adminToken: true, actor: 'admin-cli' });

/** A paired browser on a machine with an operator password: governed, and owes a confirmation. */
const BROWSER = GOVERNED.governance({ loopback: false, adminToken: false, actor: 'device' });

const refusalOf = async (work: () => Promise<unknown>): Promise<HarnessLoginRefusal> => {
  try {
    await work();
  } catch (error) {
    if (error instanceof HarnessLoginRefusal) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

// ─── the readiness read ───────────────────────────────────────────────────────────────────────────

describe('harness login readiness', () => {
  it('should group accounts by the identity whose credential they share', async () => {
    // Act
    const actual = await fixture().service.readiness();

    // Assert
    should(actual.identities.map(identity => identity.identity)).deepEqual([
      'claude:kirin',
      'codex:kirin',
      'claude:proxy',
    ]);
    should(actual.identities[0]?.accounts).have.length(2);
  });

  it('should offer a login to an account whose credential the harness writes', async () => {
    // Act
    const actual = accountOf(await fixture().service.readiness(), INTERACTIVE_ID);

    // Assert
    should(actual.login).deepEqual({ applies: true });
    should(actual.source).deepEqual({ source: 'interactive-login' });
    should(actual.credential).deepEqual({ state: 'missing' });
  });

  it('should offer NO login to an account whose credential comes from a token file, and say where it does come from', async () => {
    // Act
    const actual = accountOf(await fixture().service.readiness(), KEYED_ID);

    // Assert
    should(actual.login).deepEqual({ applies: false, because: 'credential-is-not-a-login' });
    should(actual.source).deepEqual({
      source: 'token-file',
      variable: 'ANTHROPIC_API_KEY',
      path: '/etc/ferretry/secrets.sh',
    });
  });

  it('should not report a credential state for an account whose credential is not a login', async () => {
    // `missing` here would tell a correctly-configured account that it is broken: whatever sits in the
    // harness's own store is not this account's credential.
    // Act
    const actual = accountOf(await fixture().service.readiness(), KEYED_ID);

    // Assert
    should(actual.credential).deepEqual({ state: 'not-read' });
  });

  it('should offer NO login to any account of a harness that declares none', async () => {
    // Arrange
    const subject = fixture({
      declarations: {
        claude: { login: true },
        codex: { login: false, reason: 'this build of Codex authenticates from a service account' },
      },
    });

    // Act
    const actual = accountOf(await subject.service.readiness(), CODEX_ID);

    // Assert
    should(actual.login).deepEqual({
      applies: false,
      because: 'harness-has-no-login',
      harnessReason: 'this build of Codex authenticates from a service account',
    });
  });

  it('should still offer a login to the other harness when one declares none', async () => {
    // Arrange
    const subject = fixture({
      declarations: { claude: { login: true }, codex: { login: false, reason: 'no interactive login' } },
    });

    // Act
    const actual = accountOf(await subject.service.readiness(), INTERACTIVE_ID);

    // Assert
    should(actual.login).deepEqual({ applies: true });
  });

  it('should carry the fleet’s own verdict rather than flattening it to “needs a login”', async () => {
    // Arrange — one home nobody could read, which is `indeterminate` and not `login`: offering a
    // sign-in here would overwrite a credential that may be perfectly fine.
    const store = new RecordingStore();
    store.fix({ state: 'unreadable', reason: 'the keychain is locked' });

    // Act
    const actual = await fixture({ store }).service.readiness();

    // Assert
    should(actual.identities[0]).have.property('verdict', 'indeterminate');
    should(actual.identities[0])
      .have.property('reason')
      .match(/refusing to decide/u);
  });

  it('should report an API-key identity as needing no login at all', async () => {
    // Act
    const actual = await fixture().service.readiness();

    // Assert
    should(actual.identities.find(identity => identity.identity === 'claude:proxy')).have.property(
      'verdict',
      'no-login',
    );
  });

  it('should read no credential for an API-key identity', async () => {
    // Arrange
    const subject = fixture();

    // Act
    await subject.service.readiness();

    // Assert
    should(subject.store.calls).not.containEql(`read claude ${KEYED_ID}`);
  });
});

// ─── refusals ─────────────────────────────────────────────────────────────────────────────────────

describe('starting a harness login', () => {
  it('should refuse an account this host does not publish', async () => {
    // Act
    const actual = await refusalOf(async () =>
      fixture().service.start({ accountId: '00000000-0000-4000-8000-00000000ffff' }, HOST),
    );

    // Assert
    should(actual.code).equal('fleet_login_unavailable');
    should(actual.message).match(/is published on this host/u);
  });

  it('should refuse an account whose credential comes from a token file, naming the file', async () => {
    // Act
    const actual = await refusalOf(async () => fixture().service.start({ accountId: KEYED_ID }, HOST));

    // Assert
    should(actual.code).equal('fleet_login_unavailable');
    should(actual.message).match(/ANTHROPIC_API_KEY in \/etc\/ferretry\/secrets\.sh/u);
    should(actual.message).match(/nothing to sign in to/u);
  });

  it('should refuse a harness that declares no interactive login, in the harness’s own words', async () => {
    // Arrange
    const subject = fixture({
      declarations: { claude: { login: true }, codex: { login: false, reason: 'Codex is provisioned centrally here' } },
    });

    // Act
    const actual = await refusalOf(async () => subject.service.start({ accountId: CODEX_ID }, HOST));

    // Assert
    should(actual.message).match(/Codex is provisioned centrally here/u);
  });

  it('should spawn nothing when it refuses', async () => {
    // Arrange
    const subject = fixture();

    // Act
    await refusalOf(async () => subject.service.start({ accountId: KEYED_ID }, HOST));
    await subject.settle();

    // Assert
    should(subject.children).be.empty();
  });

  it('should refuse when nobody can say where this caller stands', async () => {
    // Act
    const actual = await refusalOf(async () => fixture().service.start({ accountId: INTERACTIVE_ID }, undefined));

    // Assert
    should(actual.code).equal('fleet_login_unauthorized');
  });

  it('should refuse a second sign-in for one identity, naming the flow that holds it', async () => {
    // Arrange
    const subject = fixture();
    await subject.service.start({ accountId: INTERACTIVE_ID }, HOST);

    // Act — the SIBLING lane, which is the same identity and therefore the same homes.
    const actual = await refusalOf(async () => subject.service.start({ accountId: AUTO_ID }, HOST));

    // Assert
    should(actual.code).equal('fleet_login_in_progress');
    should(actual.message).match(/already running as flow "flow01"/u);
  });

  it('should allow a sign-in for a DIFFERENT identity while one is running', async () => {
    // Arrange
    const subject = fixture();
    await subject.service.start({ accountId: INTERACTIVE_ID }, HOST);

    // Act
    const actual = await subject.service.start({ accountId: CODEX_ID }, HOST);

    // Assert
    should(actual).have.property('harness', 'codex');
  });
});

// ─── the operator password ────────────────────────────────────────────────────────────────────────

describe('the per-change confirmation', () => {
  it('should never ask a caller the operator’s grants do not govern', async () => {
    // Arrange
    let asked = 0;
    const subject = fixture({
      confirmChange: async () => {
        asked += 1;
        return { kind: 'confirmed' };
      },
    });

    // Act
    await subject.service.start({ accountId: INTERACTIVE_ID }, HOST);

    // Assert
    should(asked).equal(0);
  });

  it('should refuse a governed caller that brought no password', async () => {
    // Act
    const actual = await refusalOf(async () => fixture().service.start({ accountId: INTERACTIVE_ID }, BROWSER));

    // Assert
    should(actual.code).equal('fleet_login_unauthorized');
    should(actual.message).match(/needs this machine's operator password, entered against this exact sign-in/u);
  });

  it('should refuse a governed caller that brought the wrong password', async () => {
    // Arrange
    const subject = fixture({ confirmChange: async () => ({ kind: 'refused', reason: 'wrong-password' }) });

    // Act
    const actual = await refusalOf(async () =>
      subject.service.start({ accountId: INTERACTIVE_ID, operatorPassword: 'not-it' }, BROWSER),
    );

    // Assert
    should(actual.message).match(/that is not this machine's operator password/u);
  });

  it('should name the host remedy when the shared attempt budget is spent', async () => {
    // Arrange
    const subject = fixture({ confirmChange: async () => ({ kind: 'refused', reason: 'rate-limited' }) });

    // Act
    const actual = await refusalOf(async () =>
      subject.service.start({ accountId: INTERACTIVE_ID, operatorPassword: 'x' }, BROWSER),
    );

    // Assert
    should(actual.message).match(/fy daemon password set/u);
  });

  it('should say the true thing when the machine has no password to check against', async () => {
    // Arrange
    const subject = fixture({ confirmChange: async () => ({ kind: 'refused', reason: 'no-password' }) });

    // Act
    const actual = await refusalOf(async () =>
      subject.service.start({ accountId: INTERACTIVE_ID, operatorPassword: 'x' }, BROWSER),
    );

    // Assert
    should(actual.message).match(/has no operator password/u);
  });

  it('should start once a governed caller proves the password', async () => {
    // Arrange
    const subject = fixture();

    // Act
    const actual = await subject.service.start(
      { accountId: INTERACTIVE_ID, operatorPassword: 'the operator password' },
      BROWSER,
    );

    // Assert
    should(actual).have.property('state', 'starting');
  });

  it('should spawn nothing when the password is refused', async () => {
    // Arrange
    const subject = fixture({ confirmChange: async () => ({ kind: 'refused', reason: 'wrong-password' }) });

    // Act
    await refusalOf(async () => subject.service.start({ accountId: INTERACTIVE_ID, operatorPassword: 'no' }, BROWSER));
    await subject.settle();

    // Assert
    should(subject.children).be.empty();
  });
});

// ─── Claude's own flow, end to end ────────────────────────────────────────────────────────────────

describe('the Claude leg', () => {
  it('should launch the interactive lane’s own wrapper with Claude’s own argv', async () => {
    // Arrange
    const subject = fixture();

    // Act
    await subject.service.start({ accountId: AUTO_ID }, HOST);
    const child = await subject.child();

    // Assert — the AUTO lane was named and the INTERACTIVE one was launched, because an approval is
    // something a person performs and the mode is declared rather than read out of a name.
    should(child.spec.command).deepEqual(['/fleet/bin/claude-kirin', 'auth', 'login', '--claudeai']);
  });

  it('should strip the caller’s own provider credential from the child’s environment', async () => {
    // Arrange
    const subject = fixture();

    // Act
    await subject.service.start({ accountId: INTERACTIVE_ID }, HOST);
    const child = await subject.child();

    // Assert
    should(child.spec.environment).not.have.property('ANTHROPIC_API_KEY');
    should(child.spec.environment).have.property('PATH', '/usr/bin');
  });

  it('should keep a variable the wrapper deliberately references', async () => {
    // Arrange — the wrapper exports FY_BASE by reference, so stripping it would break the account.
    const subject = fixture();

    // Act
    await subject.service.start({ accountId: INTERACTIVE_ID }, HOST);
    const child = await subject.child();

    // Assert
    should(Object.keys(child.spec.environment)).containEql('PATH');
  });

  it('should publish the URL Claude prints and nothing else', async () => {
    // Arrange
    const subject = fixture();
    const started = await subject.service.start({ accountId: INTERACTIVE_ID }, HOST);
    const child = await subject.child();

    // Act
    child.emit('Opening browser to sign in…', CLAUDE_URL_LINE, 'Paste code here if prompted > ');
    const actual = await subject.service.status(started.flowId);

    // Assert
    should(actual).deepEqual({
      harness: 'claude',
      flowId: 'flow01',
      accountId: INTERACTIVE_ID,
      identity: 'claude:kirin',
      startedAt: '2026-08-19T10:00:00.000Z',
      expiresAt: '2026-08-19T10:10:00.000Z',
      state: 'awaiting-code',
      verificationUrl: CLAUDE_URL,
    });
  });

  it('should write the pasted value to the child’s stdin, exactly once and with a newline', async () => {
    // Arrange
    const subject = fixture();
    const started = await subject.service.start({ accountId: INTERACTIVE_ID }, HOST);
    const child = await subject.child();
    child.emit(CLAUDE_URL_LINE);

    // Act
    const actual = await subject.service.submit(started.flowId, PASTED_CODE);

    // Assert
    should(actual).have.property('outcome', 'accepted');
    should(child.written).deepEqual([`${PASTED_CODE}\n`]);
  });

  it('should refuse a submission before a link has been published', async () => {
    // Arrange
    const subject = fixture();
    const started = await subject.service.start({ accountId: INTERACTIVE_ID }, HOST);
    await subject.child();

    // Act
    const actual = await subject.service.submit(started.flowId, PASTED_CODE);

    // Assert
    should(actual).have.property('outcome', 'refused');
  });

  it('should report `unconfirmed` when the harness had already stopped reading', async () => {
    // Arrange
    const subject = fixture();
    const started = await subject.service.start({ accountId: INTERACTIVE_ID }, HOST);
    const child = await subject.child();
    child.emit(CLAUDE_URL_LINE);
    child.reading = false;

    // Act
    const actual = await subject.service.submit(started.flowId, PASTED_CODE);

    // Assert
    should(actual).deepEqual({
      outcome: 'unconfirmed',
      reason:
        'the harness was no longer reading, so nobody can say whether that code arrived; check whether this account is signed in before trying again',
    });
  });

  it('should fan the fresh credential out to the sibling lane once the harness has written one', async () => {
    // Arrange
    const subject = fixture();
    const started = await subject.service.start({ accountId: INTERACTIVE_ID }, HOST);
    const child = await subject.child();
    child.emit(CLAUDE_URL_LINE);
    await subject.service.submit(started.flowId, PASTED_CODE);

    // Act — the harness writes its own store, then exits.
    subject.store.signIn(INTERACTIVE_ID);
    child.exit(0);
    await subject.settle();
    const actual = await subject.service.status(started.flowId);

    // Assert
    should(actual).have.property('state', 'complete');
    should(actual)
      .have.property('accounts')
      .deepEqual([
        { accountId: INTERACTIVE_ID, status: 'logged-in' },
        { accountId: AUTO_ID, status: 'synced' },
      ]);
    should(subject.store.clones).deepEqual([`clone claude ${INTERACTIVE_ID} -> ${AUTO_ID}`]);
  });

  it('should ask nobody anything when a sibling already has a usable credential', async () => {
    // Arrange — the good case: `FleetLoginService` syncs first, so no child is ever spawned.
    const store = new RecordingStore(new Set([AUTO_ID]));
    const subject = fixture({ store });

    // Act
    const started = await subject.service.start({ accountId: INTERACTIVE_ID }, HOST);
    await subject.settle();
    const actual = await subject.service.status(started.flowId);

    // Assert
    should(subject.children).be.empty();
    should(actual).have.property('state', 'complete');
    // Manifest order, which is the order `FleetLoginService` reports its members in — the interactive
    // lane received the sibling’s credential and the sibling’s own was already usable.
    should(actual)
      .have.property('accounts')
      .deepEqual([
        { accountId: INTERACTIVE_ID, status: 'synced' },
        { accountId: AUTO_ID, status: 'usable' },
      ]);
  });
});

// ─── Codex's own flow, end to end ─────────────────────────────────────────────────────────────────

describe('the Codex leg', () => {
  it('should launch the account’s own wrapper with the device-grant argv', async () => {
    // Arrange
    const subject = fixture();

    // Act
    await subject.service.start({ accountId: CODEX_ID }, HOST);
    const child = await subject.child();

    // Assert
    should(child.spec.command).deepEqual(['/fleet/bin/codex-kirin', 'login', '--device-auth']);
  });

  it('should publish nothing until BOTH the link and the code have arrived', async () => {
    // Arrange
    const subject = fixture();
    const started = await subject.service.start({ accountId: CODEX_ID }, HOST);
    const child = await subject.child();

    // Act
    child.emit(CODEX_URL_LINE);
    const half = await subject.service.status(started.flowId);
    child.emit(CODEX_CODE_LINE);
    const whole = await subject.service.status(started.flowId);

    // Assert
    should(half).have.property('state', 'starting');
    should(half).not.have.property('verificationUrl');
    should(whole).have.property('state', 'awaiting-approval');
    should(whole).have.property('userCode', '0IER-FFQW6');
    should(whole).have.property('verificationUrl', CODEX_URL);
  });

  it('should refuse every submission, because a device grant has no return trip', async () => {
    // Arrange
    const subject = fixture();
    const started = await subject.service.start({ accountId: CODEX_ID }, HOST);
    const child = await subject.child();
    child.emit(CODEX_URL_LINE, CODEX_CODE_LINE);

    // Act
    const actual = await subject.service.submit(started.flowId, PASTED_CODE);

    // Assert
    should(actual).have.property('outcome', 'refused');
    should(actual)
      .have.property('reason')
      .match(/enter the one-time code at the provider/u);
    should(child.written).be.empty();
  });

  it('should complete when the child finishes its own polling', async () => {
    // Arrange
    const subject = fixture();
    const started = await subject.service.start({ accountId: CODEX_ID }, HOST);
    const child = await subject.child();
    child.emit(CODEX_URL_LINE, CODEX_CODE_LINE);

    // Act
    subject.store.signIn(CODEX_ID);
    child.exit(0);
    await subject.settle();
    const actual = await subject.service.status(started.flowId);

    // Assert
    should(actual).have.property('state', 'complete');
    should(actual)
      .have.property('accounts')
      .deepEqual([{ accountId: CODEX_ID, status: 'logged-in' }]);
  });
});

// ─── failing as itself ────────────────────────────────────────────────────────────────────────────

describe('a login that cannot run', () => {
  it('should refuse a missing wrapper by naming apply, and must not fall back to PATH', async () => {
    // Arrange
    const subject = fixture({ wrapperMissing: true });

    // Act
    const started = await subject.service.start({ accountId: INTERACTIVE_ID }, HOST);
    await subject.settle();
    const actual = await subject.service.status(started.flowId);

    // Assert
    should(subject.children).be.empty();
    should(actual).have.property('state', 'failed');
    should(actual)
      .have.property('reason')
      .match(/run `fy fleet apply` first/u);
  });

  it('should end as itself when it recognised nothing it could publish', async () => {
    // Arrange — the outcome §4.5 rule 2 demands when a third party changes its output, or when an
    // undocumented flag such as `codex login --device-auth` disappears.
    const subject = fixture();
    const started = await subject.service.start({ accountId: CODEX_ID }, HOST);
    const child = await subject.child();

    // Act
    child.emit('error: unexpected argument --device-auth found');
    child.exit(2);
    await subject.settle();
    const actual = await subject.service.status(started.flowId);

    // Assert
    should(actual).have.property('state', 'failed');
    should(actual)
      .have.property('reason')
      .match(/did not offer a sign-in that can be driven from a browser/u);
    should(actual).have.property('remedy', 'sign this account in on the host with `fy fleet login`');
  });

  it('should carry the harness’s own non-zero exit through as a per-account failure', async () => {
    // Arrange
    const subject = fixture();
    const started = await subject.service.start({ accountId: INTERACTIVE_ID }, HOST);
    const child = await subject.child();
    child.emit(CLAUDE_URL_LINE);

    // Act
    child.exit(1);
    await subject.settle();
    const actual = await subject.service.status(started.flowId);

    // Assert — the flow FINISHED and every account says what happened, which carries more than a bare
    // failed flow would: `FleetLoginService` decided these, not this mount.
    should(actual).have.property('state', 'complete');
    should(actual)
      .have.property('accounts')
      .match([{ status: 'failed', message: 'the sign-in exited with code 1' }, { status: 'failed' }]);
  });

  it('should report a login that exits zero but leaves nobody signed in as a failure', async () => {
    // Arrange — the provider approval was abandoned half way.
    const subject = fixture();
    const started = await subject.service.start({ accountId: INTERACTIVE_ID }, HOST);
    const child = await subject.child();
    child.emit(CLAUDE_URL_LINE);

    // Act
    child.exit(0);
    await subject.settle();
    const actual = await subject.service.status(started.flowId);

    // Assert
    should(actual)
      .have.property('accounts')
      .match([{ status: 'failed' }, { status: 'failed' }]);
  });
});

// ─── lifetime ─────────────────────────────────────────────────────────────────────────────────────

describe('a login’s lifetime', () => {
  it('should be bounded in minutes rather than left open', async () => {
    // Arrange
    const subject = fixture({ windowMinutes: 3 });

    // Act
    const actual = await subject.service.start({ accountId: INTERACTIVE_ID }, HOST);

    // Assert
    should(actual.expiresAt).equal('2026-08-19T10:03:00.000Z');
    should(subject.timers[0]).have.property('milliseconds', 180_000);
  });

  it('should bound a flow to the declared default window when a caller names none', async () => {
    // Arrange
    const subject = fixture();

    // Act
    const actual = await subject.service.start({ accountId: INTERACTIVE_ID }, HOST);

    // Assert
    should(Date.parse(actual.expiresAt) - Date.parse(actual.startedAt)).equal(HARNESS_LOGIN_WINDOW_MINUTES * 60_000);
  });

  it('should end a flow nobody polled, and kill its child', async () => {
    // Arrange
    const subject = fixture();
    const started = await subject.service.start({ accountId: INTERACTIVE_ID }, HOST);
    const child = await subject.child();

    // Act — the deadline fires with nobody reading.
    subject.timers[0]?.run();
    await subject.settle();
    const actual = await subject.service.status(started.flowId);

    // Assert
    should(child.killed).be.true();
    should(actual).have.property('state', 'failed');
    should(actual).have.property('reason', 'this sign-in ran out of time before it finished');
  });

  it('should end a flow whose window closed even if its timer never fired', async () => {
    // Arrange — a lazy check as well as a timer, because a suspended host wakes up with both.
    let now = NOW;
    const subject = fixture({ now: () => now });
    const started = await subject.service.start({ accountId: INTERACTIVE_ID }, HOST);
    await subject.child();

    // Act
    now = NOW + 600_001;
    const actual = await subject.service.status(started.flowId);

    // Assert
    should(actual).have.property('state', 'failed');
  });

  it('should cancel on request, kill the child, and disarm the deadline', async () => {
    // Arrange
    const subject = fixture();
    const started = await subject.service.start({ accountId: INTERACTIVE_ID }, HOST);
    const child = await subject.child();

    // Act
    const actual = await subject.service.cancel(started.flowId);
    await subject.settle();

    // Assert
    should(actual).have.property('state', 'failed');
    should(actual).have.property('reason', 'this sign-in was cancelled');
    should(child.killed).be.true();
    should(subject.timers[0]).have.property('disarmed', true);
  });

  it('should let a new sign-in start once the previous one is cancelled', async () => {
    // Arrange
    const subject = fixture();
    const first = await subject.service.start({ accountId: INTERACTIVE_ID }, HOST);
    await subject.service.cancel(first.flowId);
    await subject.settle();

    // Act
    const actual = await subject.service.start({ accountId: INTERACTIVE_ID }, HOST);

    // Assert
    should(actual).have.property('flowId', 'flow02');
  });

  it('should conflict rather than refuse when a cancelled flow is submitted to', async () => {
    // Arrange
    const subject = fixture();
    const started = await subject.service.start({ accountId: INTERACTIVE_ID }, HOST);
    const child = await subject.child();
    child.emit(CLAUDE_URL_LINE);
    await subject.service.cancel(started.flowId);

    // Act
    const actual: HarnessLoginSubmission = await subject.service.submit(started.flowId, PASTED_CODE);

    // Assert
    should(actual).have.property('outcome', 'conflict');
  });

  it('should refuse a flow it never had, and say it may have finished', async () => {
    // Act
    const actual = await refusalOf(async () => fixture().service.status('flow-nobody-minted'));

    // Assert
    should(actual.code).equal('fleet_login_unknown');
    should(actual.message).match(/may have finished or run out of time/u);
  });

  it('should keep a finished flow readable so its own poller learns the outcome', async () => {
    // Arrange
    const store = new RecordingStore(new Set([AUTO_ID]));
    const subject = fixture({ store });
    const started = await subject.service.start({ accountId: INTERACTIVE_ID }, HOST);
    await subject.settle();

    // Act — several later flows, so retention is exercised rather than assumed.
    for (let index = 0; index < 3; index += 1) {
      const next = await subject.service.start({ accountId: INTERACTIVE_ID }, HOST);
      await subject.settle();
      should(next.flowId).not.equal(started.flowId);
    }

    // Assert
    should(await subject.service.status(started.flowId)).have.property('state', 'complete');
  });

  it('should forget the oldest finished flows rather than growing without bound', async () => {
    // Arrange
    const store = new RecordingStore(new Set([AUTO_ID]));
    const subject = fixture({ store });
    const first = await subject.service.start({ accountId: INTERACTIVE_ID }, HOST);
    await subject.settle();

    // Act — ten more, all settling, which is more than the retention window.
    for (let index = 0; index < 10; index += 1) {
      await subject.service.start({ accountId: INTERACTIVE_ID }, HOST);
      await subject.settle();
    }

    // Assert
    should((await refusalOf(async () => subject.service.status(first.flowId))).code).equal('fleet_login_unknown');
  });
});

// ─── the property the whole feature rests on ──────────────────────────────────────────────────────

describe('what the daemon holds', () => {
  it('should hold no token after a successful sign-in — asserted on what is stored, not on a log line', async () => {
    // Arrange
    const subject = fixture();
    const started = await subject.service.start({ accountId: INTERACTIVE_ID }, HOST);
    const child = await subject.child();

    // Act — the child prints something shaped exactly like the credential it writes, and the person
    // brings a code back. Both then have to be absent from everything a caller can read.
    child.emit(CLAUDE_URL_LINE, CREDENTIAL_SHAPED_LINE, 'Paste code here if prompted > ');
    await subject.service.submit(started.flowId, PASTED_CODE);
    subject.store.signIn(INTERACTIVE_ID);
    child.exit(0);
    await subject.settle();

    // Assert
    const answers = await everyAnswer(subject.service, started.flowId);
    should(answers).not.match(/sk-ant-oat01-TESTONLY/u);
    should(answers).not.match(/rt-TESTONLY/u);
    should(answers).not.match(/claudeAiOauth/u);
    should(answers).not.match(new RegExp(PASTED_CODE, 'u'));
  });

  it('should write nothing to disk while signing an account in', async () => {
    // Arrange — a real state home, walked before and after. The service must add no cache, no copy and
    // no journal: if a future change starts storing anything, this is the test that says so.
    const root = await mkdtemp(join(tmpdir(), 'fy-harness-login-store-'));
    temporaryDirectories.push(root);
    await mkdir(join(root, 'fleet'), { recursive: true });
    await writeFile(join(root, 'fleet', 'marker'), 'before', 'utf8');
    const before = await tree(root);

    const subject = fixture();
    const started = await subject.service.start({ accountId: INTERACTIVE_ID }, HOST);
    const child = await subject.child();

    // Act
    child.emit(CLAUDE_URL_LINE, CREDENTIAL_SHAPED_LINE);
    await subject.service.submit(started.flowId, PASTED_CODE);
    subject.store.signIn(INTERACTIVE_ID);
    child.exit(0);
    await subject.settle();

    // Assert
    should(await tree(root)).deepEqual(before);
  });

  it('should reach the credential store only through calls that cannot yield material', async () => {
    // Arrange — `FleetCredentialStore` has exactly two methods and neither returns bytes. The recording
    // here is the behavioural half: every call this service made is a classification or a copy.
    const subject = fixture();
    const started = await subject.service.start({ accountId: INTERACTIVE_ID }, HOST);
    const child = await subject.child();
    child.emit(CLAUDE_URL_LINE);
    subject.store.signIn(INTERACTIVE_ID);
    child.exit(0);
    await subject.settle();
    should(started.flowId).equal('flow01');

    // Assert
    should(subject.store.calls.every(call => call.startsWith('read '))).be.true();
    should(subject.store.clones.every(call => call.startsWith('clone '))).be.true();
  });

  it('should publish no unrecognised output, even a line that looks like an answer', async () => {
    // Arrange
    const subject = fixture();
    const started = await subject.service.start({ accountId: INTERACTIVE_ID }, HOST);
    const child = await subject.child();

    // Act
    child.emit('Organization: Ferretry Test Org', 'Email: reader@example.test', CLAUDE_URL_LINE);
    const actual = await subject.service.status(started.flowId);

    // Assert
    should(JSON.stringify(actual)).not.match(/reader@example\.test/u);
    should(JSON.stringify(actual)).not.match(/Ferretry Test Org/u);
  });
});

/** Every file under `root`, with its bytes, so "nothing was written" is checkable rather than assumed. */
async function tree(root: string): Promise<readonly string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files.push(`${path.slice(root.length)}=${await readFile(path, 'utf8')}`);
  }
  return files.sort();
}

// ─── the refusal wording ──────────────────────────────────────────────────────────────────────────

describe('describeSource', () => {
  it('should name the file and the variable for a token file', () => {
    should(describeSource({ source: 'token-file', variable: 'ANTHROPIC_API_KEY', path: '/etc/s.sh' })).match(
      /ANTHROPIC_API_KEY in \/etc\/s\.sh/u,
    );
  });

  it('should name the variable for an environment credential', () => {
    should(describeSource({ source: 'environment', variable: 'OPENAI_API_KEY' })).match(
      /OPENAI_API_KEY environment variable/u,
    );
  });

  it('should say the configuration carries it for a configured value', () => {
    should(describeSource({ source: 'configured-value', variable: 'ANTHROPIC_API_KEY' })).match(
      /as the fleet configuration sets it/u,
    );
  });

  it('should admit that nothing declares an undeclared source', () => {
    should(describeSource({ source: 'undeclared' })).match(/nothing in this fleet/u);
  });

  it('should be total over the union, including the source a refusal never describes', () => {
    should(describeSource({ source: 'interactive-login' })).match(/written by the harness/u);
  });
});

// ─── the routes ───────────────────────────────────────────────────────────────────────────────────

describe('the harness login routes', () => {
  const dispatcherFor = (subject: Fixture, guard = GRANTED) =>
    new ApiDispatcher(new ApiRouter(harnessLoginRoutes(subject.service)), CREDENTIALS, guard);

  it('should serve the readiness read to a caller with fleet.use', async () => {
    // Arrange
    const subject = fixture();

    // Act
    const actual = await dispatcherFor(subject).dispatch(request({ path: '/v1/fleet/login', headers: human }));

    // Assert
    should(actual.status).equal(200);
    should(jsonBody(actual)).have.property('identities');
  });

  it('should refuse a governed caller that starts a sign-in with no password', async () => {
    // Arrange
    const subject = fixture();

    // Act
    const actual = await dispatcherFor(subject, GOVERNED).dispatch(
      request({
        method: 'POST',
        path: '/v1/fleet/login',
        headers: { ...human, 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: INTERACTIVE_ID }),
      }),
    );

    // Assert
    should(actual.status).equal(409);
    should(jsonBody(actual)).have.property('code', 'fleet_login_unauthorized');
    should(subject.children).be.empty();
  });

  it('should start a sign-in for a governed caller that proves the password', async () => {
    // Arrange
    const subject = fixture();

    // Act
    const actual = await dispatcherFor(subject, GOVERNED).dispatch(
      request({
        method: 'POST',
        path: '/v1/fleet/login',
        headers: { ...human, 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: INTERACTIVE_ID, operatorPassword: 'the operator password' }),
      }),
    );

    // Assert
    should(actual.status).equal(200);
    should(jsonBody(actual)).have.property('state', 'starting');
  });

  it('should read one flow, forward one value, and end one flow', async () => {
    // Arrange
    const subject = fixture();
    const dispatcher = dispatcherFor(subject);
    const started = jsonBody(
      await dispatcher.dispatch(
        request({
          method: 'POST',
          path: '/v1/fleet/login',
          headers: { ...human, 'content-type': 'application/json' },
          body: JSON.stringify({ accountId: INTERACTIVE_ID }),
        }),
      ),
    );
    const child = await subject.child();
    child.emit(CLAUDE_URL_LINE);

    // Act
    const read = await dispatcher.dispatch(request({ path: `/v1/fleet/login/${started.flowId}`, headers: human }));
    const submitted = await dispatcher.dispatch(
      request({
        method: 'POST',
        path: `/v1/fleet/login/${started.flowId}`,
        headers: { ...human, 'content-type': 'application/json' },
        body: JSON.stringify({ code: PASTED_CODE }),
      }),
    );
    const cancelled = await dispatcher.dispatch(
      request({ method: 'DELETE', path: `/v1/fleet/login/${started.flowId}`, headers: human }),
    );

    // Assert
    should(jsonBody(read)).have.property('state', 'awaiting-code');
    should(jsonBody(submitted)).have.property('outcome', 'accepted');
    should(jsonBody(cancelled)).have.property('state', 'failed');
    should(child.written).deepEqual([`${PASTED_CODE}\n`]);
  });

  it('should refuse a flow id the path cannot carry', async () => {
    // Arrange
    const subject = fixture();

    // Act
    const actual = await dispatcherFor(subject).dispatch(request({ path: '/v1/fleet/login/%2F', headers: human }));

    // Assert — 400 rather than 404: the route matched and the id in it is unusable as written, which is
    // a different thing from "there is no such route" and sends a reader somewhere different.
    should(actual.status).equal(400);
  });

  it('should answer 409 with the domain’s own code for a flow nobody minted', async () => {
    // Arrange
    const subject = fixture();

    // Act
    const actual = await dispatcherFor(subject).dispatch(request({ path: '/v1/fleet/login/flow99', headers: human }));

    // Assert
    should(actual.status).equal(409);
    should(jsonBody(actual)).have.property('code', 'fleet_login_unknown');
  });

  it('should refuse a start body that names anything but an account', async () => {
    // Arrange
    const subject = fixture();

    // Act
    const actual = await dispatcherFor(subject).dispatch(
      request({
        method: 'POST',
        path: '/v1/fleet/login',
        headers: { ...human, 'content-type': 'application/json' },
        body: JSON.stringify({ accountId: INTERACTIVE_ID, wrapper: '/usr/local/bin/anything' }),
      }),
    );

    // Assert
    should(actual.status).equal(400);
  });
});
