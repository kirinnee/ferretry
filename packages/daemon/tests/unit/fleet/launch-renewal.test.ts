/**
 * The renewal a session start is allowed to ask for.
 *
 * The claims: an executable this daemon does not publish costs nothing and reads no credential; the
 * account that IS published is renewed through the identity it belongs to rather than on its own; every
 * failure is a sentence and never a throw, because a launch must not be refused by the thing trying to
 * make it work; and only the endings somebody has to act on are said out loud.
 *
 * NO CREDENTIAL MATERIAL APPEARS HERE. The store fake answers classifications, which is the only thing
 * anything on this path is allowed to see.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import {
  type CredentialCloneOutcome,
  type CredentialReading,
  type FleetConfig,
  FleetConfigSchema,
  type FleetCredentialStore,
  type FleetIdentity,
  type FleetIdentityMember,
  FleetIdentityService,
  type FleetIdentityMemberStatus,
  type FleetIdentityStatus,
  type FleetManifest,
  FleetManifestSchema,
  type FleetTokenRefreshResult,
  type FleetTokenRenewal,
  type HarnessKind,
} from '@ferretry/fleet';
import {
  FleetLaunchRenewal,
  type LaunchRenewalFleetReader,
  type LaunchRenewalNotices,
  type LaunchRenewalSurvey,
} from '../../../src/lib/fleet/launch-renewal.ts';

const INTERACTIVE_ID = '00000000-0000-4000-8000-000000000001';
const AUTO_ID = '00000000-0000-4000-8000-000000000002';
const KEYED_ID = '00000000-0000-4000-8000-000000000003';

const NOW = Date.parse('2026-08-19T10:00:00.000Z');

const route = (id: string, wrapper: string, mode: 'interactive' | 'auto') => ({
  id,
  wrapper,
  home: wrapper,
  mode,
  defaultModel: 'model-one',
  models: ['model-one'],
});

const parseConfig = (input: Record<string, unknown>): FleetConfig => {
  const parsed = FleetConfigSchema.safeParse(input);
  if (!parsed.success) throw new Error(`fixture config invalid: ${JSON.stringify(parsed.error.issues, null, 2)}`);
  return parsed.data;
};

/** One Claude login of two accounts, plus an account whose key comes from the secrets file. */
const CONFIG = parseConfig({
  secretsFile: '/etc/ferretry/secrets.sh',
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
    {
      name: 'proxy',
      kind: 'claude',
      auth: 'api-key',
      env: { ANTHROPIC_API_KEY: '$PROXY_KEY' },
      routes: { default: route(KEYED_ID, 'claude-proxy', 'interactive') },
    },
  ],
});

const manifestAccount = (id: string, wrapper: string, mode: 'interactive' | 'auto') => ({
  id,
  kind: 'claude' as const,
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
    manifestAccount(INTERACTIVE_ID, 'claude-kirin', 'interactive'),
    manifestAccount(AUTO_ID, 'claude-auto', 'auto'),
    manifestAccount(KEYED_ID, 'claude-proxy', 'interactive'),
  ],
});

const INTERACTIVE_WRAPPER = '/fleet/bin/claude-kirin';

const reader = (overrides: Partial<LaunchRenewalFleetReader> = {}): LaunchRenewalFleetReader => ({
  config: async () => CONFIG,
  accounts: async () => MANIFEST,
  ...overrides,
});

/** A store whose reads are counted, so "never opened" is a fact rather than an impression. */
class CountingStore implements FleetCredentialStore {
  readonly reads: string[] = [];

  constructor(private readonly reading: CredentialReading = { state: 'refreshable', expiresAt: NOW - 1_000 }) {}

  async read(kind: HarnessKind, member: FleetIdentityMember): Promise<CredentialReading> {
    this.reads.push(`${kind} ${member.accountId}`);
    return this.reading;
  }

  async clone(): Promise<CredentialCloneOutcome> {
    return { ok: true };
  }
}

/** Stands where `FleetTokenRefreshService` does. It owns the GATE; this records what it was handed. */
class RecordingRenewal implements FleetTokenRenewal {
  readonly asked: { identity: string; members: number }[] = [];

  constructor(private readonly result: Omit<FleetTokenRefreshResult, 'identity'>) {}

  async renew(
    identity: FleetIdentity,
    members: readonly FleetIdentityMemberStatus[],
  ): Promise<FleetTokenRefreshResult> {
    this.asked.push({ identity: identity.key, members: members.length });
    return { identity: identity.key, ...this.result };
  }
}

class ThrowingRenewal implements FleetTokenRenewal {
  constructor(private readonly error: unknown) {}

  async renew(): Promise<FleetTokenRefreshResult> {
    throw this.error;
  }
}

const journal = (): LaunchRenewalNotices & { steps: string[]; states: string[] } => {
  const lines = {
    steps: [] as string[],
    states: [] as string[],
    step: (name: string, detail?: string) => lines.steps.push(detail === undefined ? name : `${name} — ${detail}`),
    state: (message: string) => lines.states.push(message),
  };
  return lines;
};

const survey = (store: FleetCredentialStore): LaunchRenewalSurvey => new FleetIdentityService(store);

describe('FleetLaunchRenewal', () => {
  it('should renew the identity the launched wrapper belongs to, and hand over the readings it took', async () => {
    // Arrange — the wrapper is one account; the credential belongs to the LOGIN, so that is what is
    // renewed and both homes are the readings the gate chooses from.
    const store = new CountingStore();
    const renewal = new RecordingRenewal({ status: 'renewed', accountId: AUTO_ID, ran: true });
    const subject = new FleetLaunchRenewal({ fleet: reader(), identities: survey(store), renewal });

    // Act
    const actual = await subject.decide(INTERACTIVE_WRAPPER);

    // Assert
    should(renewal.asked).deepEqual([{ identity: 'claude:kirin', members: 2 }]);
    should(actual).deepEqual({
      kind: 'decided',
      result: { identity: 'claude:kirin', status: 'renewed', accountId: AUTO_ID, ran: true },
    });
  });

  it('should find the account by the name it publishes, not only by the path the caller holds', async () => {
    // Arrange — a session record written before a state home moved still names the same wrapper.
    const renewal = new RecordingRenewal({ status: 'renewed', ran: true });
    const subject = new FleetLaunchRenewal({
      fleet: reader(),
      identities: survey(new CountingStore()),
      renewal,
    });

    // Act
    await subject.decide('/somewhere/else/bin/claude-auto');

    // Assert
    should(renewal.asked).deepEqual([{ identity: 'claude:kirin', members: 2 }]);
  });

  it('should have no opinion about an executable this daemon does not publish, and read no credential', async () => {
    // Arrange — a session may legally run something that is not a fleet account. Refusing here would
    // turn "I have no opinion" into "you may not start", which is a different answer from the wrong
    // component.
    const store = new CountingStore();
    const renewal = new RecordingRenewal({ status: 'renewed', ran: true });
    const subject = new FleetLaunchRenewal({ fleet: reader(), identities: survey(store), renewal });

    // Act
    const actual = await subject.decide('/usr/local/bin/vim');

    // Assert
    should(actual).deepEqual({ kind: 'not-a-fleet-account' });
    should(store.reads).be.empty();
    should(renewal.asked).be.empty();
  });

  it('should never read a credential for an account that authenticates with a key', async () => {
    // Arrange — an API-key identity has no provider token to renew, and looking would be work invented
    // on every single launch of the commonest kind of proxy account.
    const store = new CountingStore();
    const renewal = new RecordingRenewal({ status: 'not-required', ran: false });
    const subject = new FleetLaunchRenewal({ fleet: reader(), identities: survey(store), renewal });

    // Act
    const actual = await subject.decide('/fleet/bin/claude-proxy');

    // Assert
    should(store.reads).be.empty();
    should(actual).match({ kind: 'decided' });
  });

  it('should answer a sentence rather than throwing when the fleet itself cannot be read', async () => {
    // Arrange — a configuration that will not parse is a broken fleet and not a broken session.
    const renewal = new RecordingRenewal({ status: 'renewed', ran: true });
    const subject = new FleetLaunchRenewal({
      fleet: reader({
        config: async () => {
          throw new Error('config/fleet.yaml is not valid YAML');
        },
      }),
      identities: survey(new CountingStore()),
      renewal,
    });

    // Act
    const actual = await subject.decide(INTERACTIVE_WRAPPER);

    // Assert
    should(actual).deepEqual({ kind: 'undecided', reason: 'config/fleet.yaml is not valid YAML' });
    should(renewal.asked).be.empty();
  });

  it('should answer a sentence rather than throwing when the renewal itself raises', async () => {
    // Arrange — the service is total, so this is the belt: nothing reaching a launch path may throw.
    const subject = new FleetLaunchRenewal({
      fleet: reader(),
      identities: survey(new CountingStore()),
      renewal: new ThrowingRenewal(new Error('the harness could not be started')),
    });

    // Act
    const actual = await subject.decide(INTERACTIVE_WRAPPER);

    // Assert
    should(actual).deepEqual({ kind: 'undecided', reason: 'the harness could not be started' });
  });

  it('should name the identity when the raised value carries no sentence of its own', async () => {
    // Arrange — a thrown non-Error, and an Error whose message is blank, both reach a person as
    // something they can act on rather than as the empty string.
    const blank = new FleetLaunchRenewal({
      fleet: reader(),
      identities: survey(new CountingStore()),
      renewal: new ThrowingRenewal(new Error('   ')),
    });
    const thrownString = new FleetLaunchRenewal({
      fleet: reader(),
      identities: survey(new CountingStore()),
      renewal: new ThrowingRenewal('tmux went away'),
    });

    // Act
    const withoutMessage = await blank.decide(INTERACTIVE_WRAPPER);
    const withAString = await thrownString.decide(INTERACTIVE_WRAPPER);

    // Assert
    should(withoutMessage).deepEqual({
      kind: 'undecided',
      reason: '“claude:kirin” could not be renewed before this launch',
    });
    should(withAString).deepEqual({ kind: 'undecided', reason: 'tmux went away' });
  });

  it('should survey through a port a caller supplies, so a damaged survey is a sentence too', async () => {
    // Arrange — the store's own failures are already readings; this is the survey itself failing.
    const subject = new FleetLaunchRenewal({
      fleet: reader(),
      identities: {
        surveyOne: async (): Promise<FleetIdentityStatus> => {
          throw new Error('this host’s keychain is locked');
        },
      },
      renewal: new RecordingRenewal({ status: 'renewed', ran: true }),
    });

    // Act
    const actual = await subject.decide(INTERACTIVE_WRAPPER);

    // Assert
    should(actual).deepEqual({ kind: 'undecided', reason: 'this host’s keychain is locked' });
  });
});

describe('what a launch-time renewal says out loud', () => {
  const renewing = (result: Omit<FleetTokenRefreshResult, 'identity'>) => {
    const notices = journal();
    const subject = new FleetLaunchRenewal({
      fleet: reader(),
      identities: survey(new CountingStore()),
      renewal: new RecordingRenewal(result),
      notices,
    });
    return { notices, subject };
  };

  it('should say a rotation happened, naming the home it happened to', async () => {
    // Arrange
    const { notices, subject } = renewing({
      status: 'renewed',
      accountId: AUTO_ID,
      reason: 'the harness renewed it, and no browser was opened',
      ran: true,
    });

    // Act
    await subject.beforeLaunch(INTERACTIVE_WRAPPER);

    // Assert — a milestone, because nothing needs doing about it.
    should(notices.states).be.empty();
    should(notices.steps).deepEqual([
      `credential renewed — claude:kirin (${AUTO_ID}): renewed — the harness renewed it, and no browser was opened`,
    ]);
  });

  it('should stay silent on every refusal the gate exists to produce', async () => {
    // The whole reason silence is the default: a renewal declining to spend a rotating refresh token is
    // the correct outcome, and a line for it on every session start would bury the one line that
    // matters under the ones that never do.
    for (const status of ['not-expired', 'not-renewable', 'not-required'] as const) {
      // Arrange
      const { notices, subject } = renewing({ status, reason: 'nothing to do here', ran: false });

      // Act
      await subject.beforeLaunch(INTERACTIVE_WRAPPER);

      // Assert
      should(notices.steps).be.empty();
      should(notices.states).be.empty();
    }
  });

  it('should raise the endings a person has to act on', async () => {
    for (const status of ['failed', 'unavailable', 'indeterminate'] as const) {
      // Arrange
      const { notices, subject } = renewing({ status, ran: status === 'failed' });

      // Act
      await subject.beforeLaunch(INTERACTIVE_WRAPPER);

      // Assert — no home was chosen in these fixtures, so no account is named and none is invented.
      should(notices.steps).be.empty();
      should(notices.states).deepEqual([`a session started on claude:kirin: ${status}`]);
    }
  });

  it('should say nothing at all about an executable that is not a fleet account', async () => {
    // Arrange
    const { notices, subject } = renewing({ status: 'renewed', ran: true });

    // Act
    await subject.beforeLaunch('/usr/local/bin/vim');

    // Assert
    should(notices.steps).be.empty();
    should(notices.states).be.empty();
  });

  it('should say a launch went ahead with nothing renewed when it could not decide', async () => {
    // Arrange
    const notices = journal();
    const subject = new FleetLaunchRenewal({
      fleet: reader({
        accounts: async () => {
          throw new Error('the fleet manifest has not been written yet');
        },
      }),
      identities: survey(new CountingStore()),
      renewal: new RecordingRenewal({ status: 'renewed', ran: true }),
      notices,
    });

    // Act
    await subject.beforeLaunch(INTERACTIVE_WRAPPER);

    // Assert
    should(notices.states).deepEqual([
      'no credential was renewed before this session started — the fleet manifest has not been written yet',
    ]);
  });

  it('should renew in silence for a daemon that gave it no journal', async () => {
    // Arrange — the shape a daemon with nowhere to write gets, and it must still renew.
    const renewal = new RecordingRenewal({ status: 'failed', ran: true });
    const subject = new FleetLaunchRenewal({
      fleet: reader(),
      identities: survey(new CountingStore()),
      renewal,
    });

    // Act
    await subject.beforeLaunch(INTERACTIVE_WRAPPER);

    // Assert
    should(renewal.asked).have.length(1);
  });
});
