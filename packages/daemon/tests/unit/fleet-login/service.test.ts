/**
 * The daemon side of a harness login: what it refuses, what it publishes, and what it does NOT keep.
 *
 * A sign-in names one account-model CREDENTIAL. The fixture fakes only the things that touch a machine
 * — the credential's resolved store, the child, the locator and the timer — so a test here fails when
 * the login DECISION is wrong rather than when a stub drifts.
 */
import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessKind } from '@ferretry/fleet';
import type { HarnessLoginSubmission } from '@ferretry/protocol';
import should from 'should';
import type { CallerGovernance } from '../../../src/lib/api/capability.ts';
import { ApiDispatcher } from '../../../src/lib/api/dispatcher.ts';
import { ApiRouter } from '../../../src/lib/api/router.ts';
import {
  type CredentialSignInTarget,
  FleetCredentialRefusal,
  type SignInCheck,
} from '../../../src/lib/fleet/credentials-service.ts';
import type { CodexCallbackDelivery } from '../../../src/lib/fleet-login/codex-link.ts';
import type { CallbackPortHolder } from '../../../src/lib/fleet-login/port-holders.ts';
import type {
  HarnessLoginCallbackDeliver,
  HarnessLoginChild,
  HarnessLoginChildSpec,
} from '../../../src/lib/fleet-login/ports.ts';
import {
  HARNESS_LOGIN_IDLE_MINUTES,
  HARNESS_LOGIN_LINK_SECONDS,
  HARNESS_LOGIN_SHUTDOWN_GRACE_MS,
  HARNESS_LOGIN_WINDOW_MINUTES,
  HarnessLoginRefusal,
  HarnessLoginService,
  NO_USABLE_LOGIN,
} from '../../../src/lib/fleet-login/service.ts';
import { codexSharedHostEnding } from '../../../src/lib/fleet-login/codex-flow.ts';
import { harnessLoginRoutes } from '../../../src/lib/runtime/mounts/fleet-login.ts';
import { jsonBody, request } from '../api/support.ts';
import { CREDENTIALS, GRANTED, human, NARROWED } from '../runtime/mounts/support.ts';

const ESC = '\u001b';
const BEL = '\u0007';

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

/** The one Claude credential, the one Codex credential, and one whose login lives in its environment. */
const CLAUDE_CREDENTIAL = 'work';
const CODEX_CREDENTIAL = 'team';
const ENVIRONMENT_CREDENTIAL = 'envkey';

const ENVIRONMENT_REASON = '"envkey" is authenticated by its environment variables, so there is nothing to sign in to';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

type StoreTarget = Extract<CredentialSignInTarget, { kind: 'store' }>;

/** What a store check found, as the catalog words it: where it looked, never a value. */
const MISSING_FINDING = 'Checked the keychain item "Claude Code-credentials-0a1b2c3d" (account "sam") — nothing there.';

const checkOf = (signedIn: boolean): SignInCheck =>
  signedIn ? { signedIn: true } : { signedIn: false, finding: MISSING_FINDING };

/** A credential's store sign-in, recording what it was asked to do. */
function storeTarget(overrides: Partial<Omit<StoreTarget, 'kind'>> = {}): StoreTarget {
  return {
    kind: 'store',
    credentialId: overrides.credentialId ?? CLAUDE_CREDENTIAL,
    harness: overrides.harness ?? 'claude',
    environment: overrides.environment ?? {
      CLAUDE_SECURESTORAGE_CONFIG_DIR: '/fy/fleet/credentials/work',
      CLAUDE_CONFIG_DIR: '/fy/fleet/credentials/work/sign-in',
    },
    arguments: overrides.arguments ?? [],
    prepare: overrides.prepare ?? (async () => undefined),
    check: overrides.check ?? (async () => ({ signedIn: true })),
  };
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

  /** Every signal sent, in order. */
  readonly signals: string[] = [];
  /** Set to true to model a child that ignores SIGTERM — or whose grandchild holds its pipes. */
  stubborn = false;

  kill(signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM'): void {
    this.killed = true;
    this.signals.push(signal);
    if (!this.stubborn || signal === 'SIGKILL') this.#settle?.(143);
  }

  exit(code: number): void {
    this.#settle?.(code);
  }
}

interface Fixture {
  readonly service: HarnessLoginService;
  readonly children: FakeChild[];
  readonly timers: { milliseconds: number; run: () => void; disarmed: boolean }[];
  /** Every credential id a start asked to resolve, in order. */
  readonly resolved: string[];
  /** Every store a start prepared, in order. */
  readonly prepared: string[];
  /** The credentials whose store now holds a usable login. The harness "writes" one by adding to it. */
  readonly logins: Set<string>;
  /** Every request a Codex link sign-in delivered to Codex's listener, in order. */
  readonly deliveries: CodexCallbackDelivery[];
  /** Every pid starting over stopped, in order, and every port list it asked about. */
  readonly stopped: number[];
  readonly askedPorts: (readonly number[])[];
  /** Every credential a completed sign-in was announced for, in order. */
  readonly signedIn: string[];
  /** Let the not-awaited login work run. Everything in the fixture is synchronous or a microtask. */
  settle(): Promise<void>;
  /** The child a flow spawned, once it has. `index` picks one out of a run of several flows. */
  child(index?: number): Promise<FakeChild>;
}

interface FixtureOptions {
  readonly windowMinutes?: number;
  readonly now?: () => number;
  /** Replaces the default resolution, so a test can hold or break one target. */
  readonly target?: (credentialId: string, fallback: (id: string) => CredentialSignInTarget) => CredentialSignInTarget;
  readonly locate?: (harness: HarnessKind) => string | undefined;
  /** What Codex's listener answers a delivery with. Delivered, by default. */
  readonly deliver?: HarnessLoginCallbackDeliver;
  /** Who the port table says listens on the callback ports. Nobody, by default. */
  readonly holders?: readonly CallbackPortHolder[] | undefined;
  /** Whether a stop lands. It does, by default. */
  readonly stops?: boolean;
  /** Whether this host shares its loopback ports (`browserPorts` is not `random`). Not shared, by default. */
  readonly sharedHost?: boolean;
}

/** This daemon's own OS user in the fixture. */
const OWN_UID = 501;

const LOCATED = (harness: HarnessKind): string => `/usr/local/bin/${harness}`;

function fixture(options: FixtureOptions = {}): Fixture {
  const children: FakeChild[] = [];
  const timers: { milliseconds: number; run: () => void; disarmed: boolean }[] = [];
  const resolved: string[] = [];
  const prepared: string[] = [];
  const logins = new Set<string>();
  const deliveries: CodexCallbackDelivery[] = [];
  const stopped: number[] = [];
  const askedPorts: (readonly number[])[] = [];
  const signedIn: string[] = [];
  let minted = 0;

  const fallback = (id: string): CredentialSignInTarget => {
    if (id === CLAUDE_CREDENTIAL) {
      return storeTarget({
        prepare: async () => {
          prepared.push(id);
        },
        check: async () => checkOf(logins.has(id)),
      });
    }
    if (id === CODEX_CREDENTIAL) {
      return storeTarget({
        credentialId: id,
        harness: 'codex',
        environment: { CODEX_HOME: '/fy/fleet/credentials/team' },
        arguments: ['-c', 'cli_auth_credentials_store="file"'],
        prepare: async () => {
          prepared.push(id);
        },
        check: async () => checkOf(logins.has(id)),
      });
    }
    if (id === ENVIRONMENT_CREDENTIAL) return { kind: 'refused', credentialId: id, reason: ENVIRONMENT_REASON };
    throw new FleetCredentialRefusal('fleet_credential_unknown', `no login "${id}" exists on this machine`);
  };

  const service = new HarnessLoginService({
    clock: { now: options.now ?? (() => NOW) },
    mintId: () => `flow${String(++minted).padStart(2, '0')}`,
    spawn: spec => {
      const child = new FakeChild(spec);
      children.push(child);
      return child;
    },
    // Provider credentials and store pointers the caller happens to hold, which must never reach a
    // child signing a DIFFERENT login in — and two names nothing strips, which must.
    environment: {
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'inherited-key-TESTONLY',
      OPENAI_API_KEY: 'referenced-key-TESTONLY',
      CLAUDE_CONFIG_DIR: '/home/somebody/.claude',
      PROXY_KEY: 'proxy-key',
    },
    timer: {
      after: (milliseconds, run) => {
        const entry = { milliseconds, run, disarmed: false };
        timers.push(entry);
        return () => {
          entry.disarmed = true;
        };
      },
    },
    clientName: 'fy',
    credentialTargets: {
      target: async id => {
        resolved.push(id);
        return options.target === undefined ? fallback(id) : options.target(id, fallback);
      },
    },
    locate: options.locate ?? LOCATED,
    deliverCallback: async delivery => {
      deliveries.push(delivery);
      return options.deliver === undefined ? 'delivered' : await options.deliver(delivery);
    },
    portHolders: {
      ownUid: OWN_UID,
      holders: async ports => {
        askedPorts.push(ports);
        return 'holders' in options ? options.holders : [];
      },
      stop: async pid => {
        stopped.push(pid);
        return options.stops ?? true;
      },
    },
    onSignedIn: credentialId => {
      signedIn.push(credentialId);
    },
    ...(options.sharedHost === undefined ? {} : { sharedHost: async () => options.sharedHost === true }),
    ...(options.windowMinutes === undefined ? {} : { windowMinutes: options.windowMinutes }),
  });

  const settle = async (): Promise<void> => {
    for (let tick = 0; tick < 12; tick += 1) await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    for (let tick = 0; tick < 12; tick += 1) await Promise.resolve();
  };

  return {
    service,
    children,
    timers,
    resolved,
    prepared,
    logins,
    deliveries,
    stopped,
    askedPorts,
    signedIn,
    settle,
    child: async (index = 0) => {
      await settle();
      const child = children[index];
      if (child === undefined) throw new Error(`no child was spawned at index ${index}`);
      return child;
    },
  };
}

/** A promise the test resolves itself, for holding the flow inside one await. */
function held<T>(value: T): { readonly promise: Promise<T>; release(): void } {
  let release: () => void = () => undefined;
  const promise = new Promise<T>(resolve => {
    release = () => resolve(value);
  });
  return { promise, release: () => release() };
}

/**
 * The host's own command line: holds the admin token, arrived on loopback, ungoverned.
 *
 * `governance` answers for ONE request, so a presentation is required rather than defaulted — which is
 * the point: there is no such thing as "where does this caller stand" without a caller.
 */
const HOST = GRANTED.governance({ loopback: true, adminToken: true, actor: 'admin-cli', stepUp: false });

/** A paired browser the boundary let through (its step-up held): governed, and brings nothing else. */
const BROWSER: CallerGovernance = { governed: true, decide: () => ({ allowed: true, refusal: 'granted' }) };

const refusalOf = async (work: () => Promise<unknown>): Promise<HarnessLoginRefusal> => {
  try {
    await work();
  } catch (error) {
    if (error instanceof HarnessLoginRefusal) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

// ─── the start's refusals ─────────────────────────────────────────────────────────────────────────

describe('starting a harness login', () => {
  it('should refuse when nobody can say where this caller stands, before resolving anything', async () => {
    // Arrange
    const subject = fixture();

    // Act
    const actual = await refusalOf(async () => subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, undefined));
    await subject.settle();

    // Assert
    should(actual.code).equal('fleet_login_unauthorized');
    should(actual.message).equal('this daemon cannot say whether this caller may sign this machine in');
    should(subject.resolved).be.empty();
    should(subject.children).be.empty();
  });

  it('should carry a credential refusal through as the sign-in refusal', async () => {
    // Act
    const actual = await refusalOf(async () => fixture().service.start({ credentialId: 'ghost' }, HOST));

    // Assert
    should(actual.code).equal('fleet_login_unavailable');
    should(actual.message).equal('no login "ghost" exists on this machine');
  });

  it('should let any other resolution failure through untouched', async () => {
    // Arrange
    const subject = fixture({
      target: () => {
        throw new Error('the configuration could not be read');
      },
    });

    // Act / Assert
    await should(subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST)).be.rejectedWith(
      'the configuration could not be read',
    );
  });

  it('should refuse a credential that has nothing to sign in to, with its reason', async () => {
    // Arrange
    const subject = fixture();

    // Act
    const actual = await refusalOf(async () => subject.service.start({ credentialId: ENVIRONMENT_CREDENTIAL }, HOST));
    await subject.settle();

    // Assert
    should(actual.code).equal('fleet_login_unavailable');
    should(actual.message).equal(ENVIRONMENT_REASON);
    should(subject.children).be.empty();
  });

  it('should refuse a credential that has nothing to sign in to for a governed caller too', async () => {
    // Arrange
    const subject = fixture();

    // Act
    const actual = await refusalOf(async () =>
      subject.service.start({ credentialId: ENVIRONMENT_CREDENTIAL }, BROWSER),
    );

    // Assert
    should(actual.code).equal('fleet_login_unavailable');
    should(subject.children).be.empty();
  });

  it('should pick up the sign-in already running for a credential instead of launching a second', async () => {
    // Arrange — a page that reloaded mid sign-in: the link is already on its way to the person.
    const subject = fixture();
    const first = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);
    (await subject.child()).emit(CLAUDE_URL_LINE);

    // Act
    const actual = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);
    await subject.settle();

    // Assert — the same flow, its link intact, said to be picked up; and still one child.
    should(actual).match({ flowId: first.flowId, state: 'awaiting-code', verificationUrl: CLAUDE_URL, resumed: true });
    should(subject.children).have.length(1);
    should(await subject.service.status(first.flowId)).not.have.property('resumed');
  });

  it('should pick up a running sign-in for a governed caller too, whichever method it asks for', async () => {
    // Arrange — a Codex device code started from setup, then "Sign in" again from Credentials.
    const subject = fixture();
    const first = await subject.service.start({ credentialId: CODEX_CREDENTIAL }, BROWSER);
    (await subject.child()).emit(CODEX_URL_LINE, CODEX_CODE_LINE);

    // Act
    const actual = await subject.service.start({ credentialId: CODEX_CREDENTIAL, method: 'link' }, BROWSER);

    // Assert
    should(actual).match({ flowId: first.flowId, state: 'awaiting-approval', userCode: '0IER-FFQW6', resumed: true });
    should(subject.children).have.length(1);
  });

  it('should start over on request: end the running flow, wait for its child, then launch a fresh one', async () => {
    // Arrange — a Codex link sign-in, whose child holds this machine's callback port until it exits.
    const subject = fixture();
    const first = await subject.service.start({ credentialId: CODEX_CREDENTIAL, method: 'link' }, HOST);
    const old = await subject.child();
    old.stubborn = true;

    // Act
    const actual = await subject.service.start({ credentialId: CODEX_CREDENTIAL, restart: true }, HOST);
    await subject.settle();
    const launchedBeforeExit = subject.children.length;
    const grace = subject.timers.find(timer => timer.milliseconds === HARNESS_LOGIN_SHUTDOWN_GRACE_MS);
    if (grace === undefined) throw new Error('no grace timer was armed');
    grace.run();
    await subject.settle();

    // Assert — a new flow on the method asked for; the old one ended in words, and its child was
    // killed outright before the new one launched, so the two never held the port together.
    should(actual.flowId).not.equal(first.flowId);
    should(actual).not.have.property('resumed');
    should(await subject.service.status(first.flowId)).match({
      state: 'failed',
      reason: 'this sign-in was replaced by a new one',
    });
    should(old.signals).deepEqual(['SIGTERM', 'SIGKILL']);
    should(launchedBeforeExit).equal(1);
    should(subject.children).have.length(2);
    should(subject.children[1]?.spec.command).containEql('--device-auth');
  });

  it('should launch at once when starting over finds nothing running', async () => {
    // Arrange
    const subject = fixture();

    // Act
    const actual = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL, restart: true }, HOST);
    await subject.settle();

    // Assert
    should(actual).have.property('state', 'starting');
    should(subject.children).have.length(1);
  });

  it('should spawn nothing for a fresh start that is cancelled while the old child is still exiting', async () => {
    // Arrange
    const subject = fixture();
    await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);
    (await subject.child()).stubborn = true;
    const fresh = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL, restart: true }, HOST);

    // Act
    await subject.service.cancel(fresh.flowId);
    subject.timers.find(timer => timer.milliseconds === HARNESS_LOGIN_SHUTDOWN_GRACE_MS)?.run();
    await subject.settle();

    // Assert
    should(subject.children).have.length(1);
    should(subject.prepared).deepEqual([CLAUDE_CREDENTIAL]);
  });

  it('should not pick up a flow whose window closed while nobody looked, and start a fresh one', async () => {
    // Arrange
    let now = NOW;
    const subject = fixture({ now: () => now });
    const first = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);
    await subject.child();

    // Act
    now = NOW + HARNESS_LOGIN_WINDOW_MINUTES * 60_000;
    const actual = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);

    // Assert
    should(actual.flowId).not.equal(first.flowId);
    should(actual).not.have.property('resumed');
  });

  it('should allow a sign-in for a DIFFERENT credential while one is running', async () => {
    // Arrange
    const subject = fixture();
    await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);

    // Act
    const actual = await subject.service.start({ credentialId: CODEX_CREDENTIAL }, HOST);

    // Assert
    should(actual).have.property('harness', 'codex');
  });

  it('should name the credential on the flow, as its identity too, and no account', async () => {
    // Act
    const actual = await fixture().service.start({ credentialId: CODEX_CREDENTIAL }, HOST);

    // Assert
    should(actual).deepEqual({
      harness: 'codex',
      flowId: 'flow01',
      credentialId: CODEX_CREDENTIAL,
      identity: CODEX_CREDENTIAL,
      startedAt: '2026-08-19T10:00:00.000Z',
      expiresAt: '2026-08-19T10:10:00.000Z',
      state: 'starting',
    });
    should(actual).not.have.property('accountId');
  });
});

// ─── a governed caller ────────────────────────────────────────────────────────────────────────────

describe('a governed caller', () => {
  it('should start a sign-in with nothing but the credential: the step-up was the boundary’s', async () => {
    // Arrange
    const subject = fixture();

    // Act
    const actual = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, BROWSER);
    await subject.child();

    // Assert
    should(actual).have.property('state', 'starting');
  });
});

// ─── Claude's own flow, end to end ────────────────────────────────────────────────────────────────

describe('the Claude leg', () => {
  it('should prepare the store, then launch the located harness with Claude’s own argv', async () => {
    // Arrange
    const subject = fixture();

    // Act
    await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);
    const child = await subject.child();

    // Assert
    should(subject.prepared).deepEqual([CLAUDE_CREDENTIAL]);
    should(child.spec.command).deepEqual(['/usr/local/bin/claude', 'auth', 'login', '--claudeai']);
  });

  it('should strip the caller’s own login from the environment, then give the child the store’s', async () => {
    // Arrange
    const subject = fixture();

    // Act
    await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);
    const child = await subject.child();

    // Assert — the caller's CLAUDE_CONFIG_DIR is replaced, never kept: a sign-in started from inside an
    // agent session must not authenticate against that session's own login.
    should(child.spec.environment).deepEqual({
      PATH: '/usr/bin',
      PROXY_KEY: 'proxy-key',
      CLAUDE_SECURESTORAGE_CONFIG_DIR: '/fy/fleet/credentials/work',
      CLAUDE_CONFIG_DIR: '/fy/fleet/credentials/work/sign-in',
    });
  });

  it('should publish the URL Claude prints and nothing else', async () => {
    // Arrange
    const subject = fixture();
    const started = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);
    const child = await subject.child();

    // Act
    child.emit('Opening browser to sign in…', CLAUDE_URL_LINE, 'Paste code here if prompted > ');
    const actual = await subject.service.status(started.flowId);

    // Assert
    should(actual).deepEqual({
      harness: 'claude',
      flowId: 'flow01',
      credentialId: CLAUDE_CREDENTIAL,
      identity: CLAUDE_CREDENTIAL,
      startedAt: '2026-08-19T10:00:00.000Z',
      expiresAt: '2026-08-19T10:10:00.000Z',
      state: 'awaiting-code',
      verificationUrl: CLAUDE_URL,
    });
  });

  it('should end a Claude sign-in that printed no link in time, and say so', async () => {
    // Arrange — a child that started and never printed its link, as one waiting on a terminal does.
    const subject = fixture();
    const started = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, BROWSER);
    const child = await subject.child();
    const deadline = subject.timers.find(timer => timer.milliseconds === HARNESS_LOGIN_LINK_SECONDS * 1_000);
    if (deadline === undefined) throw new Error('no link deadline was armed');

    // Act
    deadline.run();
    const actual = await subject.service.status(started.flowId);

    // Assert
    should(actual).have.property('state', 'failed');
    should(actual).have.property(
      'reason',
      'Claude Code started but printed no sign-in link within 60 seconds, so this sign-in cannot be finished from a browser',
    );
    should(child.killed).be.true();
  });

  it('should leave a Claude sign-in that printed its link alone when the link deadline passes', async () => {
    // Arrange
    const subject = fixture();
    const started = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, BROWSER);
    (await subject.child()).emit(CLAUDE_URL_LINE);
    const deadline = subject.timers.find(timer => timer.milliseconds === HARNESS_LOGIN_LINK_SECONDS * 1_000);

    // Act — a timer can fire after its disarm raced it, so it is run whether or not it was disarmed.
    deadline?.run();
    const actual = await subject.service.status(started.flowId);

    // Assert
    should(actual).have.property('state', 'awaiting-code');
  });

  it('should disarm the link deadline once a Claude sign-in has ended', async () => {
    // Arrange
    const subject = fixture();
    const started = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, BROWSER);
    await subject.child();

    // Act
    await subject.service.cancel(started.flowId);

    // Assert
    const deadline = subject.timers.find(timer => timer.milliseconds === HARNESS_LOGIN_LINK_SECONDS * 1_000);
    should(deadline).have.property('disarmed', true);
  });

  it('should write the pasted value to the child’s stdin, exactly once and with a newline', async () => {
    // Arrange
    const subject = fixture();
    const started = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);
    const child = await subject.child();
    child.emit(CLAUDE_URL_LINE);

    // Act
    const actual = await subject.service.submit(started.flowId, { code: PASTED_CODE });

    // Assert
    should(actual).have.property('outcome', 'accepted');
    should(child.written).deepEqual([`${PASTED_CODE}\n`]);
  });

  it('should refuse a submission before a link has been published', async () => {
    // Arrange
    const subject = fixture();
    const started = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);
    const child = await subject.child();

    // Act
    const actual = await subject.service.submit(started.flowId, { code: PASTED_CODE });

    // Assert
    should(actual).have.property('outcome', 'refused');
    should(child.written).be.empty();
  });

  it('should report `unconfirmed` when the harness had already stopped reading', async () => {
    // Arrange
    const subject = fixture();
    const started = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);
    const child = await subject.child();
    child.emit(CLAUDE_URL_LINE);
    child.reading = false;

    // Act
    const actual = await subject.service.submit(started.flowId, { code: PASTED_CODE });

    // Assert
    should(actual).deepEqual({
      outcome: 'unconfirmed',
      reason:
        'the harness was no longer reading, so nobody can say whether that code arrived; check whether this login is signed in before trying again',
    });
  });

  it('should report `unconfirmed` when the child has already exited and the store is still being read', async () => {
    // Arrange — the window between the child exiting and the store being proved: the flow still
    // shows a link, and there is no child left to take a code.
    const proving = held<SignInCheck>({ signedIn: true });
    const subject = fixture({
      target: (id, fallback) => {
        const target = fallback(id) as StoreTarget;
        return { ...target, check: () => proving.promise };
      },
    });
    const started = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);
    const child = await subject.child();
    child.emit(CLAUDE_URL_LINE);
    child.exit(0);
    await subject.settle();

    // Act
    const actual = await subject.service.submit(started.flowId, { code: PASTED_CODE });
    proving.release();
    await subject.settle();

    // Assert
    should(actual).have.property('outcome', 'unconfirmed');
    should(child.written).be.empty();
  });

  it('should complete once the store holds a usable login, and carry no per-account outcomes', async () => {
    // Arrange
    const subject = fixture();
    const started = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);
    const child = await subject.child();
    child.emit(CLAUDE_URL_LINE);
    await subject.service.submit(started.flowId, { code: PASTED_CODE });

    // Act — the harness writes its own store, then exits.
    subject.logins.add(CLAUDE_CREDENTIAL);
    child.exit(0);
    await subject.settle();
    const actual = await subject.service.status(started.flowId);

    // Assert
    should(actual).deepEqual({
      harness: 'claude',
      flowId: 'flow01',
      credentialId: CLAUDE_CREDENTIAL,
      identity: CLAUDE_CREDENTIAL,
      startedAt: '2026-08-19T10:00:00.000Z',
      expiresAt: '2026-08-19T10:10:00.000Z',
      state: 'complete',
    });
    should(actual).not.have.property('accounts');
    should(subject.timers[0]).have.property('disarmed', true);
  });
});

// ─── Codex's own flow, end to end ─────────────────────────────────────────────────────────────────

describe('the Codex leg', () => {
  it('should launch the located harness with the store arguments first, then the device-grant argv', async () => {
    // Arrange
    const subject = fixture();

    // Act
    await subject.service.start({ credentialId: CODEX_CREDENTIAL }, HOST);
    const child = await subject.child();

    // Assert
    should(child.spec.command).deepEqual([
      '/usr/local/bin/codex',
      '-c',
      'cli_auth_credentials_store="file"',
      'login',
      '--device-auth',
    ]);
    // Sanitized of the caller's provider credentials, then given the store's.
    should(child.spec.environment).deepEqual({
      PATH: '/usr/bin',
      PROXY_KEY: 'proxy-key',
      CODEX_HOME: '/fy/fleet/credentials/team',
    });
  });

  it('should publish nothing until BOTH the link and the code have arrived', async () => {
    // Arrange
    const subject = fixture();
    const started = await subject.service.start({ credentialId: CODEX_CREDENTIAL }, HOST);
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
    const started = await subject.service.start({ credentialId: CODEX_CREDENTIAL }, HOST);
    const child = await subject.child();
    child.emit(CODEX_URL_LINE, CODEX_CODE_LINE);

    // Act
    const actual = await subject.service.submit(started.flowId, { code: PASTED_CODE });

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
    const started = await subject.service.start({ credentialId: CODEX_CREDENTIAL }, HOST);
    const child = await subject.child();
    child.emit(CODEX_URL_LINE, CODEX_CODE_LINE);

    // Act
    subject.logins.add(CODEX_CREDENTIAL);
    child.exit(0);
    await subject.settle();
    const actual = await subject.service.status(started.flowId);

    // Assert
    should(actual).match({ harness: 'codex', state: 'complete', credentialId: CODEX_CREDENTIAL });
    should(actual).not.have.property('accounts');
    // An open app is told the login moved, though no request of its own changed it.
    should(subject.signedIn).deepEqual([CODEX_CREDENTIAL]);
  });
});

// ─── failing as itself ────────────────────────────────────────────────────────────────────────────

describe('a login that cannot run', () => {
  it('should fail in words when the harness is not installed, launching nothing', async () => {
    // Arrange
    const subject = fixture({ locate: () => undefined });

    // Act
    const started = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);
    await subject.settle();

    // Assert
    should(subject.children).be.empty();
    should(subject.prepared).be.empty();
    should(await subject.service.status(started.flowId)).match({
      state: 'failed',
      reason: 'the claude command is not installed on this machine, so there is nothing to sign in with',
    });
  });

  it('should end as itself when it recognised nothing it could publish, naming the host command', async () => {
    // Arrange — the outcome §4.5 rule 2 demands when a third party changes its output, or when an
    // undocumented flag such as `codex login --device-auth` disappears.
    const subject = fixture();
    const started = await subject.service.start({ credentialId: CODEX_CREDENTIAL }, HOST);
    const child = await subject.child();

    // Act
    child.emit('error: unexpected argument --device-auth found');
    child.exit(2);
    await subject.settle();
    const actual = await subject.service.status(started.flowId);

    // Assert
    should(actual).match({
      state: 'failed',
      reason: "this host's codex did not offer a sign-in that can be driven from a browser",
      remedy: `sign this login in on the host with \`fy credential signin ${CODEX_CREDENTIAL}\``,
    });
  });

  it('should say so even when the child exits cleanly having offered nothing', async () => {
    // Arrange
    const subject = fixture();
    const started = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);
    const child = await subject.child();

    // Act
    child.exit(0);
    await subject.settle();

    // Assert
    should(await subject.service.status(started.flowId)).match({
      state: 'failed',
      reason: "this host's claude did not offer a sign-in that can be driven from a browser",
    });
  });

  it('should fail with the exit code when the child exits badly after publishing', async () => {
    // Arrange
    const subject = fixture();
    const started = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);
    const child = await subject.child();
    child.emit(CLAUDE_URL_LINE);

    // Act
    child.exit(2);
    await subject.settle();

    // Assert
    should(await subject.service.status(started.flowId)).match({
      state: 'failed',
      reason: 'the sign-in exited with code 2',
      remedy: `sign this login in on the host with \`fy credential signin ${CLAUDE_CREDENTIAL}\``,
    });
  });

  it('should report a login that exits zero but leaves the store without a usable login as a failure', async () => {
    // Arrange — the provider approval was abandoned half way.
    const subject = fixture();
    const started = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);
    const child = await subject.child();
    child.emit(CLAUDE_URL_LINE);

    // Act
    child.exit(0);
    await subject.settle();

    // Assert — it says where it looked and what was there, and offers to look again.
    should(await subject.service.status(started.flowId)).match({
      state: 'failed',
      reason: `${NO_USABLE_LOGIN} ${MISSING_FINDING}`,
      recheck: true,
    });
  });

  describe('looking for the login again', () => {
    /** A Claude flow whose harness exited 0 with nothing in the store. */
    async function missingLogin(subject: Fixture): Promise<string> {
      const started = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);
      const child = await subject.child();
      child.emit(CLAUDE_URL_LINE);
      child.exit(0);
      await subject.settle();
      return started.flowId;
    }

    it('should complete the flow, launching nothing, when the login has landed since', async () => {
      // Arrange
      const subject = fixture();
      const flowId = await missingLogin(subject);
      subject.logins.add(CLAUDE_CREDENTIAL);

      // Act
      const actual = await subject.service.submit(flowId, { method: 'recheck' });

      // Assert
      should(actual).match({ outcome: 'accepted', flow: { state: 'complete' } });
      should(actual).not.have.propertyByPath('flow', 'recheck');
      should(subject.children).have.length(1);
      should(subject.signedIn).deepEqual([CLAUDE_CREDENTIAL]);
      should(await subject.service.status(flowId)).have.property('state', 'complete');
    });

    it('should refuse with what this read found, and keep offering, when the login is still not there', async () => {
      // Arrange
      let finding = MISSING_FINDING;
      const subject = fixture({
        target: () => storeTarget({ check: async () => ({ signedIn: false, finding }) }),
      });
      const flowId = await missingLogin(subject);
      finding = 'Checked the file /fy/fleet/credentials/work/.credentials.json — nothing there.';

      // Act
      const actual = await subject.service.submit(flowId, { method: 'recheck' });

      // Assert
      should(actual).deepEqual({ outcome: 'refused', reason: `${NO_USABLE_LOGIN} ${finding}` });
      should(await subject.service.status(flowId)).match({
        state: 'failed',
        reason: `${NO_USABLE_LOGIN} ${finding}`,
        remedy: `sign this login in on the host with \`fy credential signin ${CLAUDE_CREDENTIAL}\``,
        recheck: true,
      });
      should(subject.signedIn).be.empty();
    });

    it('should read a store that throws as not found, rather than fail the request', async () => {
      // Arrange
      let reads = 0;
      const subject = fixture({
        target: () =>
          storeTarget({
            check: async () => {
              reads += 1;
              if (reads > 1) throw new Error('the keychain went away');
              return checkOf(false);
            },
          }),
      });
      const flowId = await missingLogin(subject);

      // Act
      const actual = await subject.service.submit(flowId, { method: 'recheck' });

      // Assert
      should(actual).deepEqual({
        outcome: 'refused',
        reason: `${NO_USABLE_LOGIN} The store this login is kept in could not be read.`,
      });
    });

    it('should refuse a recheck on a flow that is still running', async () => {
      // Arrange
      const subject = fixture();
      const started = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);

      // Act
      const actual = await subject.service.submit(started.flowId, { method: 'recheck' });

      // Assert
      should(actual).deepEqual({
        outcome: 'conflict',
        reason: 'this sign-in is still running, so there is nothing to look for yet',
      });
    });

    it('should refuse a recheck on a flow that failed for another reason, and offer none', async () => {
      // Arrange
      const subject = fixture();
      const started = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);
      const child = await subject.child();
      child.emit(CLAUDE_URL_LINE);
      child.exit(2);
      await subject.settle();

      // Act
      const actual = await subject.service.submit(started.flowId, { method: 'recheck' });

      // Assert
      should(actual).deepEqual({
        outcome: 'conflict',
        reason: 'this sign-in did not end with a login to look for again; start a new sign-in instead',
      });
      should(await subject.service.status(started.flowId)).not.have.property('recheck');
    });

    it('should keep a Codex flow failed, with what this read found, when its login is still not there', async () => {
      // Arrange
      const finding = 'Checked the file /fy/fleet/credentials/work/auth.json — nothing there.';
      const subject = fixture({
        target: () =>
          storeTarget({
            credentialId: CODEX_CREDENTIAL,
            harness: 'codex',
            check: async () => ({ signedIn: false, finding }),
          }),
      });
      const started = await subject.service.start({ credentialId: CODEX_CREDENTIAL }, HOST);
      const child = await subject.child();
      child.emit(CODEX_URL_LINE, CODEX_CODE_LINE);
      child.exit(0);
      await subject.settle();

      // Act
      const actual = await subject.service.submit(started.flowId, { method: 'recheck' });

      // Assert
      should(actual).deepEqual({ outcome: 'refused', reason: `${NO_USABLE_LOGIN} ${finding}` });
      should(await subject.service.status(started.flowId)).match({
        harness: 'codex',
        state: 'failed',
        reason: `${NO_USABLE_LOGIN} ${finding}`,
        recheck: true,
      });
    });

    it('should look again for a Codex sign-in too', async () => {
      // Arrange
      const subject = fixture();
      const started = await subject.service.start({ credentialId: CODEX_CREDENTIAL }, HOST);
      const child = await subject.child();
      child.emit(CODEX_URL_LINE, CODEX_CODE_LINE);
      child.exit(0);
      await subject.settle();
      subject.logins.add(CODEX_CREDENTIAL);

      // Act
      const actual = await subject.service.submit(started.flowId, { method: 'recheck' });

      // Assert
      should(actual).match({ outcome: 'accepted', flow: { harness: 'codex', state: 'complete' } });
    });
  });

  it('should record a preparation failure on the flow rather than reject', async () => {
    // Arrange
    const subject = fixture({
      target: () =>
        storeTarget({
          prepare: async () => {
            throw new Error('the store directory could not be created');
          },
        }),
    });

    // Act
    const started = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);
    await subject.settle();

    // Assert
    should(subject.children).be.empty();
    should(await subject.service.status(started.flowId)).match({
      state: 'failed',
      reason: 'the store directory could not be created',
    });
  });

  it('should fall back to a plain sentence for a failure with no message', async () => {
    // Arrange
    const subject = fixture({
      target: () =>
        storeTarget({
          prepare: async () => {
            throw new Error('');
          },
        }),
    });

    // Act
    const started = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);
    await subject.settle();

    // Assert
    should(await subject.service.status(started.flowId)).match({ state: 'failed', reason: 'the sign-in failed' });
  });
});

// ─── lifetime ─────────────────────────────────────────────────────────────────────────────────────

describe('a login’s lifetime', () => {
  it('should be bounded in minutes rather than left open', async () => {
    // Arrange
    const subject = fixture({ windowMinutes: 3 });

    // Act
    const actual = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);

    // Assert
    should(actual.expiresAt).equal('2026-08-19T10:03:00.000Z');
    should(subject.timers[0]).have.property('milliseconds', 180_000);
  });

  it('should bound a flow to the declared default window when a caller names none', async () => {
    // Act
    const actual = await fixture().service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);

    // Assert
    should(Date.parse(actual.expiresAt) - Date.parse(actual.startedAt)).equal(HARNESS_LOGIN_WINDOW_MINUTES * 60_000);
  });

  it('should end a flow nobody polled, and kill its child', async () => {
    // Arrange
    const subject = fixture();
    const started = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);
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
    const started = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);
    await subject.child();

    // Act
    now = NOW + 600_001;
    const actual = await subject.service.status(started.flowId);

    // Assert
    should(actual).have.property('state', 'failed');
    should(actual).have.property('reason', 'this sign-in ran out of time before it finished');
  });

  it('should keep the first ending when a closed window is read again', async () => {
    // Arrange
    let now = NOW;
    const subject = fixture({ now: () => now });
    const started = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);
    await subject.child();
    await subject.service.cancel(started.flowId);

    // Act
    now = NOW + 600_001;
    const actual = await subject.service.status(started.flowId);

    // Assert
    should(actual).have.property('reason', 'this sign-in was cancelled');
  });

  it('should cancel on request, kill the child, and disarm the deadline', async () => {
    // Arrange
    const subject = fixture();
    const started = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);
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

  it('should keep a cancelled ending when the killed child exits afterwards', async () => {
    // Arrange
    const subject = fixture();
    const started = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);
    const child = await subject.child();
    child.emit(CLAUDE_URL_LINE);

    // Act
    await subject.service.cancel(started.flowId);
    await subject.settle();

    // Assert
    should(child.killed).be.true();
    should(await subject.service.status(started.flowId)).match({
      state: 'failed',
      reason: 'this sign-in was cancelled',
    });
  });

  it('should spawn nothing when the flow is cancelled while its store is being prepared', async () => {
    // Arrange — the preparation is held open, which is where a cancel can land between the
    // "has this ended" check and the spawn.
    const preparing = held(undefined);
    const subject = fixture({ target: () => storeTarget({ prepare: () => preparing.promise }) });
    const started = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);
    await subject.settle();

    // Act
    const actual = await subject.service.cancel(started.flowId);
    preparing.release();
    await subject.settle();

    // Assert — a child launched now would have nobody left to kill it.
    should(actual).have.property('reason', 'this sign-in was cancelled');
    should(subject.children).be.empty();
    should(await subject.service.status(started.flowId)).have.property('reason', 'this sign-in was cancelled');
  });

  it('should spawn nothing when the window closes while its store is being prepared', async () => {
    // Arrange
    const preparing = held(undefined);
    const subject = fixture({ target: () => storeTarget({ prepare: () => preparing.promise }) });
    const started = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);
    await subject.settle();

    // Act
    subject.timers[0]?.run();
    preparing.release();
    await subject.settle();

    // Assert
    should(subject.children).be.empty();
    should(await subject.service.status(started.flowId)).have.property('state', 'failed');
  });

  it('should keep a cancelled ending when the store is proved after the cancel', async () => {
    // Arrange — the child exited and the store is being read when the person cancels. A usable
    // login turning up afterwards must not overwrite the ending they chose.
    const proving = held<SignInCheck>({ signedIn: true });
    const subject = fixture({ target: () => storeTarget({ check: () => proving.promise }) });
    const started = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);
    const child = await subject.child();
    child.emit(CLAUDE_URL_LINE);
    child.exit(0);
    await subject.settle();

    // Act
    await subject.service.cancel(started.flowId);
    proving.release();
    await subject.settle();

    // Assert
    should(await subject.service.status(started.flowId)).match({
      state: 'failed',
      reason: 'this sign-in was cancelled',
    });
  });

  it('should not offer to look again on a flow cancelled while its store was being read', async () => {
    // Arrange — the same race, with a store that turns out empty: the ending is still the cancel.
    const proving = held<SignInCheck>({ signedIn: false, finding: MISSING_FINDING });
    const subject = fixture({ target: () => storeTarget({ check: () => proving.promise }) });
    const started = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);
    const child = await subject.child();
    child.emit(CLAUDE_URL_LINE);
    child.exit(0);
    await subject.settle();

    // Act
    await subject.service.cancel(started.flowId);
    proving.release();
    await subject.settle();

    // Assert
    const actual = await subject.service.status(started.flowId);
    should(actual).match({ state: 'failed', reason: 'this sign-in was cancelled' });
    should(actual).not.have.property('recheck');
  });

  it('should let a new sign-in start once the previous one is cancelled', async () => {
    // Arrange
    const subject = fixture();
    const first = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);
    await subject.service.cancel(first.flowId);
    await subject.settle();

    // Act
    const actual = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);

    // Assert
    should(actual).have.property('flowId', 'flow02');
  });

  it('should conflict rather than refuse when a cancelled flow is submitted to', async () => {
    // Arrange
    const subject = fixture();
    const started = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);
    const child = await subject.child();
    child.emit(CLAUDE_URL_LINE);
    await subject.service.cancel(started.flowId);

    // Act
    const actual: HarnessLoginSubmission = await subject.service.submit(started.flowId, { code: PASTED_CODE });

    // Assert
    should(actual).have.property('outcome', 'conflict');
  });

  it('should refuse a flow it never had, and say it may have finished', async () => {
    // Act
    const actual = await refusalOf(async () => fixture().service.status('flow-nobody-minted'));

    // Assert
    should(actual.code).equal('fleet_login_unknown');
    should(actual.message).equal(
      'that sign-in is no longer running on this machine; it may have finished or run out of time',
    );
    should(actual.message).not.containEql('flow-nobody-minted');
  });

  /** The idle deadline armed last and still live, which is the one that decides. */
  const idleTimer = (subject: Fixture) => {
    const armed = subject.timers.filter(
      timer => timer.milliseconds === HARNESS_LOGIN_IDLE_MINUTES * 60_000 && !timer.disarmed,
    );
    const last = armed.at(-1);
    if (last === undefined) throw new Error('no idle deadline is armed');
    return last;
  };

  it('should end a flow waiting for a code that nobody has read for the idle time', async () => {
    // Arrange — the link was shown, then the page went away.
    const subject = fixture();
    const started = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);
    const child = await subject.child();
    child.emit(CLAUDE_URL_LINE);

    // Act
    idleTimer(subject).run();
    await subject.settle();
    const actual = await subject.service.status(started.flowId);

    // Assert
    should(child.killed).be.true();
    should(actual).match({ state: 'failed', lastCode: 'expired' });
  });

  it('should keep a Codex device code running with nobody reading, because the provider can still approve it', async () => {
    // Arrange
    const subject = fixture();
    const started = await subject.service.start({ credentialId: CODEX_CREDENTIAL }, HOST);
    const child = await subject.child();
    child.emit(CODEX_URL_LINE, CODEX_CODE_LINE);

    // Act
    const first = idleTimer(subject);
    first.run();
    const rearmed = idleTimer(subject);
    child.exit(0);
    subject.logins.add(CODEX_CREDENTIAL);
    await subject.settle();

    // Assert — looked again later rather than ended, and finished on its own.
    should(rearmed).not.equal(first);
    should(child.killed).be.false();
    should(await subject.service.status(started.flowId)).have.property('state', 'complete');
  });

  it('should restart the idle clock on every read, and end a flow lazily once it went unread too long', async () => {
    // Arrange
    let now = NOW;
    const subject = fixture({ now: () => now });
    const started = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);
    (await subject.child()).emit(CLAUDE_URL_LINE);
    const idle = HARNESS_LOGIN_IDLE_MINUTES * 60_000;

    // Act — read just inside the idle time, then leave it a whole idle time unread.
    now = NOW + idle - 1;
    const kept = await subject.service.status(started.flowId);
    now += idle;
    const ended = await subject.service.status(started.flowId);

    // Assert
    should(kept).have.property('state', 'awaiting-code');
    should(ended).match({ state: 'failed', lastCode: 'expired' });
  });

  it('should leave the idle deadline alone once a flow has settled', async () => {
    // Arrange
    const subject = fixture();
    const started = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);
    await subject.child();
    const idle = idleTimer(subject);
    await subject.service.cancel(started.flowId);

    // Act — a timer that fired anyway, as a real one can after its disarm raced it.
    idle.run();

    // Assert
    should(await subject.service.status(started.flowId)).have.property('reason', 'this sign-in was cancelled');
  });

  /** Run one whole sign-in to a settled flow, the way a person would. */
  const settledFlow = async (subject: Fixture): Promise<string> => {
    const index = subject.children.length;
    const started = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);
    const child = await subject.child(index);
    child.emit(CLAUDE_URL_LINE);
    await subject.service.submit(started.flowId, { code: PASTED_CODE });
    subject.logins.add(CLAUDE_CREDENTIAL);
    child.exit(0);
    await subject.settle();
    return started.flowId;
  };

  it('should keep a finished flow readable so its own poller learns the outcome', async () => {
    // Arrange
    const subject = fixture();
    const started = await settledFlow(subject);

    // Act — several later flows, so retention is exercised rather than assumed.
    for (let index = 0; index < 3; index += 1) {
      should(await settledFlow(subject)).not.equal(started);
    }

    // Assert
    should(await subject.service.status(started)).have.property('state', 'complete');
  });

  it('should forget the oldest finished flows rather than growing without bound', async () => {
    // Arrange
    const subject = fixture();
    const first = await settledFlow(subject);

    // Act — ten more, all settling, which is more than the retention window.
    for (let index = 0; index < 10; index += 1) await settledFlow(subject);

    // Assert
    should((await refusalOf(async () => subject.service.status(first))).code).equal('fleet_login_unknown');
  });
});

// ─── the property the whole feature rests on ──────────────────────────────────────────────────────

describe('what the daemon holds', () => {
  it('should hold no token after a successful sign-in — asserted on what is answered, not on a log line', async () => {
    // Arrange
    const subject = fixture();
    const started = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);
    const child = await subject.child();

    // Act — the child prints something shaped exactly like the credential it writes, and the person
    // brings a code back. Both then have to be absent from everything a caller can read.
    child.emit(CLAUDE_URL_LINE, CREDENTIAL_SHAPED_LINE, 'Paste code here if prompted > ');
    const submitted = await subject.service.submit(started.flowId, { code: PASTED_CODE });
    subject.logins.add(CLAUDE_CREDENTIAL);
    child.exit(0);
    await subject.settle();

    // Assert
    const answers = JSON.stringify([submitted, await subject.service.status(started.flowId)]);
    should(answers).not.match(/sk-ant-oat01-TESTONLY/u);
    should(answers).not.match(/rt-TESTONLY/u);
    should(answers).not.match(/claudeAiOauth/u);
    should(answers).not.match(new RegExp(PASTED_CODE, 'u'));
  });

  it('should write nothing to disk while signing a credential in', async () => {
    // Arrange — a real state home, walked before and after. The service must add no cache, no copy and
    // no journal: if a future change starts storing anything, this is the test that says so.
    const root = await mkdtemp(join(tmpdir(), 'fy-harness-login-store-'));
    temporaryDirectories.push(root);
    await mkdir(join(root, 'fleet'), { recursive: true });
    await writeFile(join(root, 'fleet', 'marker'), 'before', 'utf8');
    const before = await tree(root);

    const subject = fixture();
    const started = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);
    const child = await subject.child();

    // Act
    child.emit(CLAUDE_URL_LINE, CREDENTIAL_SHAPED_LINE);
    await subject.service.submit(started.flowId, { code: PASTED_CODE });
    subject.logins.add(CLAUDE_CREDENTIAL);
    child.exit(0);
    await subject.settle();

    // Assert
    should(await tree(root)).deepEqual(before);
  });

  it('should publish no unrecognised output, even a line that looks like an answer', async () => {
    // Arrange
    const subject = fixture();
    const started = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);
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

// ─── the routes ───────────────────────────────────────────────────────────────────────────────────

describe('the harness login routes', () => {
  const dispatcherFor = (subject: Fixture, guard = GRANTED) =>
    new ApiDispatcher(new ApiRouter(harnessLoginRoutes(subject.service)), CREDENTIALS, guard);

  const startRequest = (
    body: Record<string, unknown>,
    headers: Record<string, string> = human,
    device?: { readonly deviceId: string; readonly appSession: string },
  ) =>
    request({
      method: 'POST',
      path: '/v1/fleet/login',
      headers: { ...headers, 'content-type': 'application/json' },
      ...(device === undefined ? {} : { device }),
      body: JSON.stringify(body),
    });

  it('should answer 409 with the domain’s own code for a credential that is not a login', async () => {
    // Arrange
    const subject = fixture();

    // Act
    const actual = await dispatcherFor(subject).dispatch(startRequest({ credentialId: ENVIRONMENT_CREDENTIAL }));

    // Assert
    should(actual.status).equal(409);
    should(jsonBody(actual)).match({ code: 'fleet_login_unavailable', error: ENVIRONMENT_REASON });
  });

  it('should let a failure that is not a login refusal through as a server error', async () => {
    // Arrange
    const subject = fixture({
      target: () => {
        throw new Error('the configuration could not be read');
      },
    });

    // Act
    const actual = await dispatcherFor(subject).dispatch(startRequest({ credentialId: CLAUDE_CREDENTIAL }));

    // Assert
    should(actual.status).equal(500);
  });

  it('should read one flow, forward one value, and end one flow', async () => {
    // Arrange
    const subject = fixture();
    const dispatcher = dispatcherFor(subject);
    const started = jsonBody(await dispatcher.dispatch(startRequest({ credentialId: CLAUDE_CREDENTIAL })));
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

  /**
   * The caller this whole feature exists for: a PAIRED BROWSER, which holds a device credential and
   * never the admin token.
   *
   * `minimum: 'operator'` is what admits a device — an `admin-token` minimum would 403 the browser on
   * every one of these paths, and a browser is always a paired device.
   */
  const paired = CREDENTIALS;
  /** The device a session proved, and the headers the browser sends — none of them a credential. */
  const pairedDevice = { deviceId: 'device-1', appSession: 'app-one' } as const;
  const browser = { 'x-ferretry-client': 'ui' } as const;
  const wardenCaller = { authorization: `Bearer ${CREDENTIALS.warden}`, 'x-ferretry-client': 'cli' } as const;
  const pairedDispatcher = (subject: Fixture, guard = GRANTED) =>
    new ApiDispatcher(new ApiRouter(harnessLoginRoutes(subject.service)), paired, guard);

  it('should let a paired browser reach every one of the four login paths', async () => {
    // Arrange
    const subject = fixture();
    const dispatcher = pairedDispatcher(subject);
    const start = await dispatcher.dispatch(startRequest({ credentialId: CLAUDE_CREDENTIAL }, browser, pairedDevice));
    const started = jsonBody(start);
    const child = await subject.child();
    child.emit(CLAUDE_URL_LINE);

    // Act
    const statuses = [
      start,
      await dispatcher.dispatch(
        request({ path: `/v1/fleet/login/${started.flowId}`, headers: browser, device: pairedDevice }),
      ),
      await dispatcher.dispatch(
        request({
          method: 'POST',
          path: `/v1/fleet/login/${started.flowId}`,
          headers: { ...browser, 'content-type': 'application/json' },
          device: pairedDevice,
          body: JSON.stringify({ code: PASTED_CODE }),
        }),
      ),
      await dispatcher.dispatch(
        request({
          method: 'DELETE',
          path: `/v1/fleet/login/${started.flowId}`,
          headers: browser,
          device: pairedDevice,
        }),
      ),
    ].map(response => response.status);

    // Assert
    should(started).have.property('state', 'starting');
    should(statuses).deepEqual([200, 200, 200, 200]);
  });

  it('should refuse a warden token on every login path, because a login is not a remedy', async () => {
    // A warden credential is scoped to what an assignment allows, and re-pointing a credential at
    // another provider account is not one of those things.
    // Arrange
    const subject = fixture();
    const dispatcher = pairedDispatcher(subject);

    // Act
    const statuses = [
      await dispatcher.dispatch(startRequest({ credentialId: CLAUDE_CREDENTIAL }, wardenCaller)),
      await dispatcher.dispatch(request({ path: '/v1/fleet/login/flow01', headers: wardenCaller })),
      await dispatcher.dispatch(
        request({
          method: 'POST',
          path: '/v1/fleet/login/flow01',
          headers: { ...wardenCaller, 'content-type': 'application/json' },
          body: JSON.stringify({ code: PASTED_CODE }),
        }),
      ),
      await dispatcher.dispatch(request({ method: 'DELETE', path: '/v1/fleet/login/flow01', headers: wardenCaller })),
    ].map(response => response.status);

    // Assert
    should(statuses).deepEqual([403, 403, 403, 403]);
    should(subject.children).be.empty();
  });

  it('should refuse an unauthenticated caller before it decides anything else', async () => {
    // Arrange
    const subject = fixture();

    // Act
    const actual = await pairedDispatcher(subject).dispatch(request({ path: '/v1/fleet/login/flow01' }));

    // Assert — 401, not 403: nothing presented a credential, so there is no caller to refuse.
    should(actual.status).equal(401);
  });

  it('should refuse a start from a caller whose configure axis the operator switched off', async () => {
    // Arrange
    const subject = fixture();

    // Act
    const actual = await pairedDispatcher(subject, NARROWED).dispatch(
      startRequest({ credentialId: CLAUDE_CREDENTIAL }, browser, pairedDevice),
    );

    // Assert
    should(actual.status).equal(403);
    should(jsonBody(actual)).have.property('code', 'grant_not_granted');
    should(subject.resolved).be.empty();
    should(subject.children).be.empty();
  });

  it('should refuse a flow id the path cannot carry', async () => {
    // Act
    const actual = await dispatcherFor(fixture()).dispatch(request({ path: '/v1/fleet/login/%2F', headers: human }));

    // Assert — 400 rather than 404: the route matched and the id in it is unusable as written.
    should(actual.status).equal(400);
  });

  it('should answer 409 with the domain’s own code for a flow nobody minted', async () => {
    // Act
    const actual = await dispatcherFor(fixture()).dispatch(request({ path: '/v1/fleet/login/flow99', headers: human }));

    // Assert
    should(actual.status).equal(409);
    should(jsonBody(actual)).have.property('code', 'fleet_login_unknown');
  });

  it('should refuse a start body that names anything but a credential', async () => {
    // Arrange
    const subject = fixture();
    const dispatcher = dispatcherFor(subject);

    // Act
    const statuses = [
      await dispatcher.dispatch(startRequest({ credentialId: CLAUDE_CREDENTIAL, wrapper: '/usr/local/bin/anything' })),
      // The retired account-scoped shape: there is no account to name any more.
      await dispatcher.dispatch(startRequest({ accountId: '00000000-0000-4000-8000-000000000001' })),
    ].map(response => response.status);

    // Assert
    should(statuses).deepEqual([400, 400]);
    should(subject.resolved).be.empty();
  });
});

// ─── a code the harness refuses, or that nobody approved ─────────────────────────────────────────

/** Claude's own refusal, quoted from `auth login` in claude-code 2.1.281 (and §6's 2.1.220 capture). */
const CLAUDE_INVALID_CODE_LINE = 'Invalid code. Please make sure the full code was copied.';

/** codex-cli 0.156.1's own words when it stops polling a device grant. */
const CODEX_TIMED_OUT_LINE = 'Error logging in with device code: device auth timed out after 15 minutes';

describe('a code the harness does not take', () => {
  it('should say the last code was rejected, instead of showing the same form as if nothing happened', async () => {
    // Arrange — the defect `docs/design/harness-login.md` §6 records: the write lands, Claude refuses the
    // code on its own output and keeps reading, and the flow used to look exactly as it did before.
    const subject = fixture();
    const started = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);
    const child = await subject.child();
    child.emit(CLAUDE_URL_LINE);
    const submitted = await subject.service.submit(started.flowId, { code: PASTED_CODE });

    // Act
    child.emit(CLAUDE_INVALID_CODE_LINE);
    const actual = await subject.service.status(started.flowId);

    // Assert
    should(submitted).have.property('outcome', 'accepted');
    should(actual).have.property('state', 'awaiting-code');
    should(actual).have.property('lastCode', 'rejected');
    should(child.killed).be.false();
  });

  it('should clear the refusal when the next code is sent, and take that code', async () => {
    // Arrange
    const subject = fixture();
    const started = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);
    const child = await subject.child();
    child.emit(CLAUDE_URL_LINE);
    await subject.service.submit(started.flowId, { code: 'first-TESTONLY' });
    child.emit(CLAUDE_INVALID_CODE_LINE);

    // Act
    const actual = await subject.service.submit(started.flowId, { code: PASTED_CODE });

    // Assert
    should(actual).have.property('outcome', 'accepted');
    should(actual).have.property('flow').not.have.property('lastCode');
    should(child.written).deepEqual(['first-TESTONLY\n', `${PASTED_CODE}\n`]);
  });

  it('should publish no child text and no code with the refusal', async () => {
    // Arrange
    const subject = fixture();
    const started = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);
    const child = await subject.child();
    child.emit(CLAUDE_URL_LINE);
    await subject.service.submit(started.flowId, { code: PASTED_CODE });
    child.emit(CLAUDE_INVALID_CODE_LINE);

    // Act
    const actual = JSON.stringify(await subject.service.status(started.flowId));

    // Assert
    should(actual).not.containEql('Invalid code');
    should(actual).not.containEql(PASTED_CODE);
  });

  it('should end as a rejected code, offering a fresh one, when Claude exits after taking a code', async () => {
    // Arrange
    const subject = fixture();
    const started = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);
    const child = await subject.child();
    child.emit(CLAUDE_URL_LINE);
    await subject.service.submit(started.flowId, { code: PASTED_CODE });

    // Act
    child.exit(1);
    await subject.settle();
    const actual = await subject.service.status(started.flowId);

    // Assert — not the host command: a fresh code is what this person needs, and they are holding a browser.
    should(actual).match({
      state: 'failed',
      reason: 'Claude could not sign in with that code',
      lastCode: 'rejected',
    });
    should(actual).have.property('remedy').not.containEql('credential signin');
  });

  it('should say the link expired when the window closes while a person holds it', async () => {
    // Arrange
    const subject = fixture();
    const started = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);
    const child = await subject.child();
    child.emit(CLAUDE_URL_LINE);

    // Act
    subject.timers[0]?.run();
    await subject.settle();
    const actual = await subject.service.status(started.flowId);

    // Assert
    should(child.killed).be.true();
    should(actual).match({ state: 'failed', lastCode: 'expired' });
  });

  it('should say a Codex code expired — never that it was rejected — when Codex stops waiting', async () => {
    // Arrange
    const subject = fixture();
    const started = await subject.service.start({ credentialId: CODEX_CREDENTIAL }, HOST);
    const child = await subject.child();
    child.emit(CODEX_URL_LINE, CODEX_CODE_LINE);

    // Act
    child.emit(CODEX_TIMED_OUT_LINE);
    child.exit(1);
    await subject.settle();
    const actual = await subject.service.status(started.flowId);

    // Assert
    should(actual).match({
      harness: 'codex',
      state: 'failed',
      reason: 'the one-time code expired before it was approved',
      lastCode: 'expired',
    });
  });

  it('should say a Codex code expired when the window closes on it, however the status is read', async () => {
    // Arrange — the lazy path, because a suspended host wakes up with no timer having fired.
    let now = NOW;
    const subject = fixture({ now: () => now });
    const started = await subject.service.start({ credentialId: CODEX_CREDENTIAL }, HOST);
    const child = await subject.child();
    child.emit(CODEX_URL_LINE, CODEX_CODE_LINE);

    // Act
    now = NOW + 600_001;
    const actual = await subject.service.status(started.flowId);

    // Assert
    should(actual).match({ state: 'failed', lastCode: 'expired' });
  });
});

/** Observed on stderr from `codex login` at codex-cli 0.145.0 (the URL's values replaced). */
const LINK_STATE = 'STATE-TESTONLY_abc';
const LINK_URL = `https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_TESTONLY&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&code_challenge=challenge&code_challenge_method=S256&state=${LINK_STATE}&originator=codex_cli_rs`;
const LINK_LINES = [
  'Starting local login server on http://localhost:1455.',
  'If your browser did not open, navigate to this URL to authenticate:',
  '',
  LINK_URL,
  '',
  'On a remote or headless machine? Use `codex login --device-auth` instead.',
];
/** The address a phone's browser is left on. Recognisable, so its absence from every answer is checkable. */
const CALLBACK_CODE = 'callback-code-TESTONLY';
const CALLBACK_ADDRESS = `http://localhost:1455/auth/callback?code=${CALLBACK_CODE}&scope=openid+profile&state=${LINK_STATE}`;
/** Quoted from the codex binary (0.145.0 and 0.156.1). */
const DEVICE_DISABLED_LINE =
  'Error logging in with device code: device code login is not enabled for this Codex server. Use the browser login or verify the server URL.';

/** A Codex link sign-in that has printed its link. */
async function linkAwaiting(options: FixtureOptions = {}) {
  const subject = fixture(options);
  const started = await subject.service.start({ credentialId: CODEX_CREDENTIAL, method: 'link' }, HOST);
  const child = await subject.child();
  child.emit(...LINK_LINES);
  return { subject, started, child };
}

describe('the Codex link sign-in', () => {
  it('should run Codex’s ordinary browser login and publish its link when a link is asked for', async () => {
    // Act
    const { subject, started, child } = await linkAwaiting();
    const actual = await subject.service.status(started.flowId);

    // Assert
    should(child.spec.command).deepEqual(['/usr/local/bin/codex', '-c', 'cli_auth_credentials_store="file"', 'login']);
    should(started).have.property('state', 'starting');
    should(actual).match({ harness: 'codex', state: 'awaiting-callback', verificationUrl: LINK_URL });
    should(actual).not.have.property('deviceCode');
  });

  it('should move to the link sign-in by itself when Codex says device codes are turned off', async () => {
    // Arrange
    const subject = fixture();
    const started = await subject.service.start({ credentialId: CODEX_CREDENTIAL }, HOST);
    const device = await subject.child();

    // Act
    device.emit(DEVICE_DISABLED_LINE);
    device.exit(1);
    const link = await subject.child(1);
    link.emit(...LINK_LINES);
    const actual = await subject.service.status(started.flowId);

    // Assert
    should(device.spec.command.at(-1)).equal('--device-auth');
    should(device.killed).be.true();
    should(link.spec.command.at(-1)).equal('login');
    should(actual).match({ flowId: started.flowId, state: 'awaiting-callback', deviceCode: 'unavailable' });
  });

  it('should not move to the link by itself on a host that shares its loopback ports', async () => {
    // Arrange
    const subject = fixture({ sharedHost: true });
    const started = await subject.service.start({ credentialId: CODEX_CREDENTIAL }, HOST);
    const device = await subject.child();

    // Act
    device.emit(DEVICE_DISABLED_LINE);
    const actual = await subject.service.status(started.flowId);
    await subject.settle();

    // Assert
    should(device.killed).be.true();
    should(subject.children).have.length(1);
    should(actual).match({ flowId: started.flowId, state: 'failed' });
    should(actual).have.property('reason', codexSharedHostEnding().reason);
    should(actual).have.property('remedy', codexSharedHostEnding().remedy);
  });

  it('should still move to the link when the person asks for it on a host that shares its loopback ports', async () => {
    // Arrange
    const subject = fixture({ sharedHost: true });
    const started = await subject.service.start({ credentialId: CODEX_CREDENTIAL }, HOST);
    const device = await subject.child();
    device.emit(CODEX_URL_LINE, CODEX_CODE_LINE);

    // Act
    await subject.service.submit(started.flowId, { method: 'link' });
    const link = await subject.child(1);
    link.emit(...LINK_LINES);

    // Assert
    should(link.spec.command.at(-1)).equal('login');
    should(await subject.service.status(started.flowId)).match({ state: 'awaiting-callback' });
  });

  it('should move to a link when the person says the device code did not work, in the same flow', async () => {
    // Arrange
    const subject = fixture();
    const started = await subject.service.start({ credentialId: CODEX_CREDENTIAL }, HOST);
    const device = await subject.child();
    device.emit(CODEX_URL_LINE, CODEX_CODE_LINE);

    // Act
    const actual = await subject.service.submit(started.flowId, { method: 'link' });
    const link = await subject.child(1);
    link.emit(...LINK_LINES);

    // Assert
    should(actual).match({ outcome: 'accepted', flow: { flowId: started.flowId, state: 'starting' } });
    should(device.killed).be.true();
    should(await subject.service.status(started.flowId)).match({ state: 'awaiting-callback' });
    should(await subject.service.status(started.flowId)).not.have.property('deviceCode');
  });

  it('should launch the link sign-in first when the switch arrives before any child ran', async () => {
    // Arrange
    const gate = held(undefined);
    const subject = fixture({
      target: (id, fallback) => {
        const target = fallback(id) as StoreTarget;
        return { ...target, prepare: async () => await gate.promise };
      },
    });
    const started = await subject.service.start({ credentialId: CODEX_CREDENTIAL }, HOST);

    // Act
    await subject.service.submit(started.flowId, { method: 'link' });
    gate.release();
    const child = await subject.child();

    // Assert
    should(subject.children).have.length(1);
    should(child.spec.command.at(-1)).equal('login');
  });

  it('should deliver the checked address to Codex’s listener, and finish when Codex signs in', async () => {
    // Arrange
    const { subject, started, child } = await linkAwaiting();

    // Act
    const submitted = await subject.service.submit(started.flowId, { code: `  ${CALLBACK_ADDRESS}\n` });
    const during = await subject.service.status(started.flowId);
    subject.logins.add(CODEX_CREDENTIAL);
    child.exit(0);
    await subject.settle();
    const actual = await subject.service.status(started.flowId);

    // Assert
    should(subject.deliveries).deepEqual([
      { port: 1455, path: '/auth/callback', query: `code=${CALLBACK_CODE}&scope=openid+profile&state=${LINK_STATE}` },
    ]);
    should(submitted).match({ outcome: 'accepted', flow: { state: 'finishing' } });
    should(during).have.property('state', 'finishing');
    should(actual).have.property('state', 'complete');
    should(child.written).be.empty();
    should(JSON.stringify([submitted, during, actual])).not.containEql(CALLBACK_CODE);
  });

  it('should refuse an address from another attempt without delivering it or repeating it', async () => {
    // Arrange
    const { subject, started } = await linkAwaiting();
    const stale = CALLBACK_ADDRESS.replace(LINK_STATE, 'other-attempt');

    // Act
    const actual = await subject.service.submit(started.flowId, { code: stale });

    // Assert
    should(actual).match({ outcome: 'refused', reason: /different sign-in attempt/u });
    should(subject.deliveries).be.empty();
    should(JSON.stringify(actual)).not.containEql(CALLBACK_CODE);
    should(await subject.service.status(started.flowId)).have.property('state', 'awaiting-callback');
  });

  it('should refuse a second address while Codex is finishing with the first', async () => {
    // Arrange
    const delivery = held<'delivered'>('delivered');
    const { subject, started } = await linkAwaiting({ deliver: async () => await delivery.promise });

    // Act
    const first = subject.service.submit(started.flowId, { code: CALLBACK_ADDRESS });
    const second = await subject.service.submit(started.flowId, { code: CALLBACK_ADDRESS });
    delivery.release();

    // Assert
    should(second).match({ outcome: 'conflict', reason: /already has the address/u });
    should(await first).have.property('outcome', 'accepted');
    should(subject.deliveries).have.length(1);
  });

  it('should go back to waiting when Codex says it was not waiting for that address', async () => {
    // Arrange
    const { subject, started } = await linkAwaiting({ deliver: async () => 'refused' });

    // Act
    const actual = await subject.service.submit(started.flowId, { code: CALLBACK_ADDRESS });

    // Assert
    should(actual).match({ outcome: 'refused', reason: /not waiting for that address/u });
    should(await subject.service.status(started.flowId)).have.property('state', 'awaiting-callback');
  });

  it('should keep a flow that ended during a refused delivery ended', async () => {
    // Arrange
    let flowId = '';
    const subject = fixture({
      deliver: async () => {
        await subject.service.cancel(flowId);
        return 'refused';
      },
    });
    const started = await subject.service.start({ credentialId: CODEX_CREDENTIAL, method: 'link' }, HOST);
    flowId = started.flowId;
    (await subject.child()).emit(...LINK_LINES);

    // Act
    await subject.service.submit(started.flowId, { code: CALLBACK_ADDRESS });

    // Assert
    should(await subject.service.status(started.flowId)).have.property('state', 'failed');
  });

  it('should say nobody knows whether the address arrived when Codex was not listening', async () => {
    // Arrange
    const { subject, started } = await linkAwaiting({ deliver: async () => 'unreachable' });

    // Act
    const actual = await subject.service.submit(started.flowId, { code: CALLBACK_ADDRESS });

    // Assert
    should(actual).match({ outcome: 'unconfirmed', reason: /no longer listening/u });
  });

  it('should say Codex could not use the address when it exits after the delivery', async () => {
    // Arrange
    const { subject, started, child } = await linkAwaiting();
    await subject.service.submit(started.flowId, { code: CALLBACK_ADDRESS });

    // Act
    child.emit('Error logging in: Token exchange failed: token endpoint returned status 401 Unauthorized');
    child.exit(1);
    await subject.settle();
    const actual = await subject.service.status(started.flowId);

    // Assert
    should(actual).match({ state: 'failed', lastCode: 'rejected', reason: /could not finish signing in/u });
    should(JSON.stringify(actual)).not.containEql('Token exchange');
  });

  it('should name the busy ports, not a missing sign-in, when Codex cannot listen', async () => {
    // Arrange
    const subject = fixture();
    const started = await subject.service.start({ credentialId: CODEX_CREDENTIAL, method: 'link' }, HOST);
    const child = await subject.child();

    // Act
    child.emit('Error logging in: Port 127.0.0.1:1457 is already in use');
    child.exit(1);
    await subject.settle();
    const actual = await subject.service.status(started.flowId);

    // Assert
    should(actual).match({ state: 'failed', reason: /ports 1455 and 1457 .* already in use/u, remedy: /device code/u });
  });

  it('should say the link expired when the window closes while it waits for the address', async () => {
    // Arrange
    const { subject, started } = await linkAwaiting();

    // Act
    subject.timers[0]?.run();
    const actual = await subject.service.status(started.flowId);

    // Assert
    should(actual).match({ state: 'failed', lastCode: 'expired', reason: /link expired/u });
  });

  it('should refuse a link for Claude, at the start and on a running flow', async () => {
    // Arrange
    const subject = fixture();

    // Act
    const atStart = subject.service.start({ credentialId: CLAUDE_CREDENTIAL, method: 'link' }, HOST);
    const started = await subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST);
    const running = await subject.service.submit(started.flowId, { method: 'link' });

    // Assert
    await should(atStart).be.rejectedWith({ name: 'HarnessLoginRefusal', code: 'fleet_login_unavailable' });
    should(running).match({ outcome: 'refused', reason: /one way to sign in/u });
  });

  it('should refuse a switch once the flow already uses a link, and an address before the link shows', async () => {
    // Arrange
    const subject = fixture();
    const started = await subject.service.start({ credentialId: CODEX_CREDENTIAL, method: 'link' }, HOST);
    await subject.child();

    // Act
    const switched = await subject.service.submit(started.flowId, { method: 'link' });
    const early = await subject.service.submit(started.flowId, { code: CALLBACK_ADDRESS });

    // Assert
    should(switched).match({ outcome: 'conflict', reason: /already using a link/u });
    should(early).match({ outcome: 'refused', reason: /has not shown its link yet/u });
  });
});

describe('a daemon that stops', () => {
  it('should end every running sign-in and wait for its child, without escalating one that exits', async () => {
    // Arrange — a pending Codex sign-in, the one that holds localhost:1455.
    const subject = fixture();
    const flow = await subject.service.start({ credentialId: CODEX_CREDENTIAL }, HOST);
    const child = await subject.child();

    // Act
    await subject.service.shutdown();

    // Assert
    should(child.killed).be.true();
    should(child.signals).not.containEql('SIGKILL');
    should(await subject.service.status(flow.flowId)).have.property('state', 'failed');
    should((await subject.service.status(flow.flowId)) as { reason?: string }).have.property(
      'reason',
      'the daemon stopped, so this sign-in ended with it',
    );
    // The grace timer was disarmed, so nothing fires after the daemon is gone.
    should(subject.timers.at(-1)).have.property('disarmed', true);
  });

  it('should kill a child outright when it has not exited by the end of the grace', async () => {
    // Arrange — a child whose exit never settles on SIGTERM: a launcher whose binary keeps the pipes.
    const subject = fixture();
    await subject.service.start({ credentialId: CODEX_CREDENTIAL }, HOST);
    const child = await subject.child();
    child.stubborn = true;

    // Act
    const stopping = subject.service.shutdown();
    await subject.settle();
    const grace = subject.timers.find(timer => timer.milliseconds === HARNESS_LOGIN_SHUTDOWN_GRACE_MS);
    if (grace === undefined) throw new Error('no grace timer was armed');
    grace.run();
    await stopping;

    // Assert
    should(child.signals[0]).equal('SIGTERM');
    should(child.signals.at(-1)).equal('SIGKILL');
  });

  it('should start no sign-in once it is stopping, and return at once with nothing running', async () => {
    // Arrange
    const subject = fixture();

    // Act
    await subject.service.shutdown();
    const refusal = await refusalOf(() => subject.service.start({ credentialId: CLAUDE_CREDENTIAL }, HOST));

    // Assert
    should(refusal.code).equal('fleet_login_unavailable');
    should(subject.children).be.empty();
  });
});

describe('starting a Codex sign-in over with its callback port taken', () => {
  /** A leftover `codex login` this daemon's user left behind, listening on one callback port. */
  const leftover = (port: number, pid: number): CallbackPortHolder => ({
    port,
    pid,
    name: 'codex',
    uid: OWN_UID,
    commandLine: `/opt/codex/bin/codex -c cli_auth_credentials_store="file" login`,
  });
  /** A local proxy the owner runs on a callback port. Never Ferretry's to stop. */
  const proxy = (port: number): CallbackPortHolder => ({
    port,
    pid: 4242,
    name: 'nginx',
    uid: OWN_UID,
    commandLine: 'nginx: master process /usr/sbin/nginx',
  });

  it('should stop a leftover Codex sign-in on the port, then launch the fresh one', async () => {
    // Arrange
    const subject = fixture({ holders: [leftover(1455, 777)] });

    // Act
    const actual = await subject.service.start({ credentialId: CODEX_CREDENTIAL, method: 'link', restart: true }, HOST);
    await subject.settle();

    // Assert
    should(subject.askedPorts).deepEqual([[1455, 1457]]);
    should(subject.stopped).deepEqual([777]);
    should(subject.children).have.length(1);
    should(await subject.service.status(actual.flowId)).have.property('state', 'starting');
  });

  it('should name, and never stop, a program that is not a Codex sign-in on every port', async () => {
    // Arrange
    const subject = fixture({ holders: [proxy(1455), proxy(1457)] });

    // Act
    const actual = await subject.service.start({ credentialId: CODEX_CREDENTIAL, method: 'link', restart: true }, HOST);
    await subject.settle();
    const flow = await subject.service.status(actual.flowId);

    // Assert
    should(subject.stopped).be.empty();
    should(subject.children).be.empty();
    should(flow).match({
      state: 'failed',
      reason:
        'Codex cannot listen for the sign-in: ports 1455 and 1457 are in use by "nginx" (pid 4242), which is not a Codex sign-in, so Ferretry will not stop it',
      remedy: /device code/u,
    });
  });

  it('should not stop a Codex login another user runs, or one whose command line nobody could read', async () => {
    // Arrange
    const subject = fixture({
      holders: [
        { ...leftover(1455, 778), uid: OWN_UID + 1 },
        { ...leftover(1457, 779), commandLine: undefined },
      ],
    });

    // Act
    const actual = await subject.service.start({ credentialId: CODEX_CREDENTIAL, method: 'link', restart: true }, HOST);
    await subject.settle();

    // Assert
    should(subject.stopped).be.empty();
    should(await subject.service.status(actual.flowId)).match({ state: 'failed', reason: /pid 778.*pid 779/u });
  });

  it('should say so when a leftover Codex sign-in could not be stopped', async () => {
    // Arrange
    const subject = fixture({ holders: [leftover(1455, 780), proxy(1457)], stops: false });

    // Act
    const actual = await subject.service.start({ credentialId: CODEX_CREDENTIAL, method: 'link', restart: true }, HOST);
    await subject.settle();

    // Assert
    should(subject.stopped).deepEqual([780]);
    should(await subject.service.status(actual.flowId)).match({
      state: 'failed',
      reason: /"codex" \(pid 780\), a leftover Codex sign-in Ferretry could not stop/u,
    });
  });

  it('should launch a link sign-in while one callback port is still free', async () => {
    // Arrange
    const subject = fixture({ holders: [proxy(1455)] });

    // Act
    await subject.service.start({ credentialId: CODEX_CREDENTIAL, method: 'link', restart: true }, HOST);
    await subject.settle();

    // Assert
    should(subject.children).have.length(1);
  });

  it('should launch a device code whoever holds the port, because a device code never listens', async () => {
    // Arrange
    const subject = fixture({ holders: [proxy(1455), proxy(1457), leftover(1455, 781)] });

    // Act
    await subject.service.start({ credentialId: CODEX_CREDENTIAL, restart: true }, HOST);
    await subject.settle();

    // Assert — the leftover is still cleared; the proxy is still left alone.
    should(subject.stopped).deepEqual([781]);
    should(subject.children).have.length(1);
  });

  it('should launch as before when this machine cannot say who holds the port', async () => {
    // Arrange
    const subject = fixture({ holders: undefined });

    // Act
    await subject.service.start({ credentialId: CODEX_CREDENTIAL, method: 'link', restart: true }, HOST);
    await subject.settle();

    // Assert
    should(subject.children).have.length(1);
  });

  it('should look at the port only when starting a Codex sign-in over', async () => {
    // Arrange
    const subject = fixture({ holders: [leftover(1455, 782)] });

    // Act
    await subject.service.start({ credentialId: CODEX_CREDENTIAL }, HOST);
    await subject.service.start({ credentialId: CLAUDE_CREDENTIAL, restart: true }, HOST);
    await subject.settle();

    // Assert
    should(subject.askedPorts).be.empty();
    should(subject.stopped).be.empty();
  });

  it('should clear nothing for a fresh start cancelled while its predecessor exits', async () => {
    // Arrange
    const subject = fixture({ holders: [leftover(1455, 783)] });
    await subject.service.start({ credentialId: CODEX_CREDENTIAL }, HOST);
    (await subject.child()).stubborn = true;
    const fresh = await subject.service.start({ credentialId: CODEX_CREDENTIAL, restart: true }, HOST);

    // Act
    await subject.service.cancel(fresh.flowId);
    subject.timers.find(timer => timer.milliseconds === HARNESS_LOGIN_SHUTDOWN_GRACE_MS)?.run();
    await subject.settle();

    // Assert
    should(subject.askedPorts).be.empty();
  });
});
