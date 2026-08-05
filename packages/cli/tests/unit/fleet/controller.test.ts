import { describe, it } from 'bun:test';
import should from 'should';
import { FleetController, type FleetControllerDeps } from '../../../src/lib/fleet/controller';
import {
  ACCOUNT_ID,
  approvalMint,
  CapturingOutput,
  FrozenClock,
  GENERATED_AT,
  IDENTITY_KEY,
  PROPOSAL_ID,
  RecordingApplier,
  RecordingAuthorizationGateway,
  RecordingHealthCollector,
  RecordingIdentitySource,
  RecordingLoginService,
  RecordingPlanner,
  RecordingRecommendationGateway,
  RecordingScaffolder,
  RecordingUsageCollector,
  StubConfigSource,
  StubManifestSource,
  usageRow,
  usageSnapshot,
} from './fixtures';

function controller(overrides: Partial<FleetControllerDeps> = {}): {
  subject: FleetController;
  deps: FleetControllerDeps;
  out: CapturingOutput;
} {
  const out = new CapturingOutput();
  const deps: FleetControllerDeps = {
    config: new StubConfigSource(),
    manifests: new StubManifestSource(),
    scaffolder: new RecordingScaffolder(),
    planner: new RecordingPlanner(),
    applier: new RecordingApplier(),
    usage: new RecordingUsageCollector(),
    identities: new RecordingIdentitySource(),
    logins: new RecordingLoginService(),
    clock: new FrozenClock(),
    recommendations: new RecordingRecommendationGateway(),
    authorizations: new RecordingAuthorizationGateway(),
    out,
    ...overrides,
  };
  return { subject: new FleetController(deps), deps, out };
}

describe('applying the fleet', () => {
  it('should build the plan and perform it', async () => {
    // Arrange
    const planner = new RecordingPlanner();
    const applier = new RecordingApplier();
    const { subject, out } = controller({ planner, applier });

    // Act
    await subject.apply({});

    // Assert
    should(planner.stamps).eql([GENERATED_AT]);
    should(applier.applied).have.length(1);
    should(out.text).containEql('applied 1 account in 2 operations');
  });

  it('should print the plan and write nothing under --dry-run', async () => {
    // Arrange
    const applier = new RecordingApplier();
    const { subject, out } = controller({ applier });

    // Act
    await subject.apply({ dryRun: true });

    // Assert
    should(applier.applied).be.empty();
    should(out.text).containEql('nothing has been written');
  });

  it('should build the plan the same way whether or not it is applied', async () => {
    // Arrange
    const planner = new RecordingPlanner();
    const { subject } = controller({ planner });

    // Act
    await subject.apply({ dryRun: true });
    await subject.apply({});

    // Assert — one code path, so the reviewed plan is the applied plan
    should(planner.stamps).eql([GENERATED_AT, GENERATED_AT]);
  });

  it('should emit the plan payload under --json', async () => {
    // Arrange
    const { subject, out } = controller();

    // Act
    await subject.apply({ dryRun: true, json: true });

    // Assert
    should(JSON.parse(out.text)).have.property('operations');
  });

  it('should let a planning failure surface instead of applying a half-built plan', async () => {
    // Arrange
    const planner = {
      build: (): never => {
        throw new Error('account "a" declares "skills", which the codex harness has no destination for');
      },
    };
    const applier = new RecordingApplier();
    const { subject } = controller({ planner, applier });

    // Act + Assert
    await should(subject.apply({})).be.rejectedWith(/has no destination for/u);
    should(applier.applied).be.empty();
  });
});

describe('listing the provisioned fleet', () => {
  it('should render the manifest', async () => {
    // Arrange
    const { subject, out } = controller();

    // Act
    await subject.list({});

    // Assert
    should(out.text).containEql('1 account provisioned');
  });

  it('should name the command that would create a manifest, on a host with none', async () => {
    // Arrange
    const { subject } = controller({ manifests: new StubManifestSource(null) });

    // Act + Assert
    await should(subject.list({})).be.rejectedWith('no fleet manifest on this host — run "fy fleet apply" first');
  });

  it('should emit the manifest under --json', async () => {
    // Arrange
    const { subject, out } = controller();

    // Act
    await subject.list({ json: true });

    // Assert
    should(JSON.parse(out.text)).have.property('accounts');
  });
});

describe('reporting quota', () => {
  it('should probe the accounts the manifest declares, not what is on disk', async () => {
    // Arrange
    const usage = new RecordingUsageCollector();
    const { subject, out } = controller({ usage });

    // Act
    await subject.usage({});

    // Assert
    should(usage.collected).have.length(1);
    should(usage.collected[0]?.accounts).have.length(1);
    should(out.text).containEql('short 42%');
  });

  it('should refuse to report usage before the fleet has ever been applied', async () => {
    // Arrange
    const { subject } = controller({ manifests: new StubManifestSource(null) });

    // Act + Assert
    await should(subject.usage({})).be.rejectedWith(/run "fy fleet apply" first/u);
  });

  it('should warn loudly when every account is exhausted', async () => {
    // Arrange
    const usage = new RecordingUsageCollector(usageSnapshot([usageRow({ atLimit: true })]));
    const { subject, out } = controller({ usage });

    // Act
    await subject.usage({});

    // Assert
    should(out.warnings[0]).containEql('Every account is at its limit');
  });

  it('should not warn while any account still has room', async () => {
    // Arrange
    const usage = new RecordingUsageCollector(
      usageSnapshot([usageRow({ atLimit: true }), usageRow({ accountId: 'b', atLimit: false })]),
    );
    const { subject, out } = controller({ usage });

    // Act
    await subject.usage({});

    // Assert
    should(out.warnings).be.empty();
  });

  it('should not warn when there are no accounts at all', async () => {
    // Arrange
    const { subject, out } = controller({ usage: new RecordingUsageCollector(usageSnapshot([])) });

    // Act
    await subject.usage({});

    // Assert
    should(out.warnings).be.empty();
  });

  it('should keep --json output clean of the warning', async () => {
    // Arrange
    const usage = new RecordingUsageCollector(usageSnapshot([usageRow({ atLimit: true })]));
    const { subject, out } = controller({ usage });

    // Act
    await subject.usage({ json: true });

    // Assert
    should(out.warnings).be.empty();
    should(JSON.parse(out.text)).have.property('accounts');
  });
});

describe('reporting health', () => {
  it('should probe the declared accounts and render the explicit result', async () => {
    // Arrange
    const health = new RecordingHealthCollector();
    const { subject, out } = controller({ health });

    // Act
    await subject.health({});

    // Assert
    should(health.collected).have.length(1);
    should(out.text).containEql('HEALTHY');
  });

  it('should refuse health probing when a transitional embedding did not configure it', async () => {
    // Arrange
    const { subject } = controller();

    // Act + Assert
    await should(subject.health({})).be.rejectedWith(/health probing is not configured/u);
  });
});

describe('recommending a team', () => {
  it('should join the task from the words given and probe quota by default', async () => {
    // Arrange
    const recommendations = new RecordingRecommendationGateway();
    const { subject, out } = controller({ recommendations });

    // Act
    await subject.recommend(['port', 'the', 'CLI', 'groups'], {});

    // Assert
    should(recommendations.requests).eql([{ task: 'port the CLI groups', usage: true }]);
    should(out.text).containEql('pick  sol');
  });

  it('should collapse the whitespace a shell leaves behind', async () => {
    // Arrange
    const recommendations = new RecordingRecommendationGateway();
    const { subject } = controller({ recommendations });

    // Act
    await subject.recommend(['  port ', ' the  CLI '], {});

    // Assert
    should(recommendations.requests[0]?.task).equal('port the CLI');
  });

  it('should skip the probe under --no-usage', async () => {
    // Arrange
    const recommendations = new RecordingRecommendationGateway();
    const { subject } = controller({ recommendations });

    // Act
    await subject.recommend(['anything'], { usage: false });

    // Assert
    should(recommendations.requests[0]?.usage).be.false();
  });

  it('should refuse an empty task rather than asking the daemon to guess', async () => {
    // Arrange
    const recommendations = new RecordingRecommendationGateway();
    const { subject } = controller({ recommendations });

    // Act + Assert
    await should(subject.recommend(['   '], {})).be.rejectedWith(/describe the task/u);
    should(recommendations.requests).be.empty();
  });

  it('should emit the recommendation under --json', async () => {
    // Arrange
    const { subject, out } = controller();

    // Act
    await subject.recommend(['anything'], { json: true });

    // Assert
    should(JSON.parse(out.text)).have.property('roles');
  });
});

describe('logging accounts in', () => {
  it('should log every account in when none is named', async () => {
    // Arrange
    const logins = new RecordingLoginService();
    const { subject, out } = controller({ logins });

    // Act
    await subject.login([], {});

    // Assert
    should(logins.requests).have.length(1);
    should(logins.requests[0]?.accountIds).be.undefined();
    should(logins.requests[0]?.mode).equal('full');
    should(out.text).containEql('logged in');
  });

  it('should pass only the named accounts through', async () => {
    // Arrange
    const logins = new RecordingLoginService();
    const { subject } = controller({ logins });

    // Act
    await subject.login([ACCOUNT_ID], {});

    // Assert
    should(logins.requests[0]?.accountIds).deepEqual([ACCOUNT_ID]);
  });

  it('should join the declared configuration to the published manifest before deciding anything', async () => {
    // Arrange — which accounts share a login is declared in configuration, not published in the manifest.
    const identities = new RecordingIdentitySource();
    const { subject } = controller({ identities });

    // Act
    await subject.login([], {});

    // Assert
    should(identities.joins).have.length(1);
    should(identities.joins[0]?.manifest.accounts).have.length(1);
  });

  it('should refuse to log in before the fleet has ever been applied', async () => {
    // Arrange
    const { subject } = controller({ manifests: new StubManifestSource(null) });

    // Act + Assert
    await should(subject.login([], {})).be.rejectedWith(/run "fy fleet apply" first/u);
  });

  it('should report a failure rather than letting it read as a quiet success', async () => {
    // Arrange
    const logins = new RecordingLoginService([
      { accountId: ACCOUNT_ID, identity: IDENTITY_KEY, status: 'failed', message: 'login process exited with code 7' },
    ]);
    const { subject, out } = controller({ logins });

    // Act
    await subject.login([], {});

    // Assert
    should(out.text).containEql('1 failed');
    should(out.text).containEql('FAILED');
  });

  it('should print the payload under --json', async () => {
    // Arrange
    const { subject, out } = controller({ logins: new RecordingLoginService() });

    // Act
    await subject.login([], { json: true });

    // Assert
    should(JSON.parse(out.text)).have.length(1);
  });

  it('should ask for a copy-only pass under --sync-only', async () => {
    // Arrange
    const logins = new RecordingLoginService();
    const { subject } = controller({ logins });

    // Act
    await subject.login([], { syncOnly: true });

    // Assert — the mode is what stops a browser approval, so it must reach the service.
    should(logins.requests[0]?.mode).equal('sync-only');
  });

  it('should change nothing under --status', async () => {
    // Arrange
    const logins = new RecordingLoginService();
    const identities = new RecordingIdentitySource();
    const { subject, out } = controller({ logins, identities });

    // Act
    await subject.login([], { status: true });

    // Assert — no login pass at all: a report must not be able to copy or approve anything.
    should(logins.requests).deepEqual([]);
    should(identities.surveyed).have.length(1);
    should(out.text).containEql(IDENTITY_KEY);
  });

  it('should narrow a status report to the identities the named accounts belong to', async () => {
    // Arrange
    const identities = new RecordingIdentitySource();
    const { subject } = controller({ identities });

    // Act
    await subject.login([ACCOUNT_ID], { status: true });

    // Assert
    should(identities.surveyed[0]).have.length(1);
  });

  it('should refuse a status report for an account no identity claims', async () => {
    // Arrange
    const { subject } = controller();

    // Act / Assert — an unknown id is an error, not an empty report.
    await should(subject.login(['00000000-0000-4000-8000-0000000000ff'], { status: true })).be.rejectedWith(
      /unknown fleet account/u,
    );
  });

  it('should print the survey payload under --status --json', async () => {
    // Arrange
    const { subject, out } = controller();

    // Act
    await subject.login([], { status: true, json: true });

    // Assert
    should(JSON.parse(out.text)).have.length(1);
  });
});

describe('honouring the configured usage thresholds', () => {
  it('should build the collector from the loaded configuration rather than a default', async () => {
    // Arrange — a declared atLimitPercent used to be parsed and dropped.
    const usage = new RecordingUsageCollector();
    const { subject } = controller({ usage });

    // Act
    await subject.usage({});

    // Assert
    should(usage.configs).have.length(1);
  });
});

describe('preparing a fresh host', () => {
  it('should scaffold and report what it created', async () => {
    // Arrange
    const scaffolder = new RecordingScaffolder();
    const { subject, out } = controller({ scaffolder });

    // Act
    await subject.init({});

    // Assert
    should(scaffolder.calls).equal(1);
    should(out.text).containEql('created  /state/fleet/config.yaml (Ferretry starter)');
  });

  it('should not need a configuration to run — there is none yet', async () => {
    // Arrange — every other verb loads one; init is what makes one exist.
    const { subject } = controller({
      config: {
        load: () => Promise.reject(new Error('no config on a fresh host')),
      },
    });

    // Act + Assert
    await should(subject.init({})).not.be.rejected();
  });

  it('should print the payload under --json', async () => {
    // Arrange
    const { subject, out } = controller({ scaffolder: new RecordingScaffolder() });

    // Act
    await subject.init({ json: true });

    // Assert
    should(JSON.parse(out.text)).have.property('pathEntry');
  });
});

describe('approving one proposed fleet change', () => {
  it('should ask the daemon about exactly the proposal it was given', async () => {
    // Arrange
    const authorizations = new RecordingAuthorizationGateway();
    const { subject } = controller({ authorizations });

    // Act
    await subject.authorize(PROPOSAL_ID, {});

    // Assert
    should(authorizations.proposalIds).eql([PROPOSAL_ID]);
  });

  it('should print the code, what it approves, and when it dies', async () => {
    // Arrange
    const { subject, out } = controller({ authorizations: new RecordingAuthorizationGateway() });

    // Act
    await subject.authorize(PROPOSAL_ID, {});

    // Assert
    should(out.text).containEql('7F3K-M9QW');
    should(out.text).containEql('create-account — add claude-auto-loge');
    should(out.text).containEql('2026-08-05T12:34:56.000Z');
    should(out.warnings).be.empty();
  });

  it('should refuse --json rather than serialize a live bearer secret', async () => {
    // Arrange — the flag is declared on the group, so it reaches this verb whether or not it wants it
    const authorizations = new RecordingAuthorizationGateway();
    const { subject, out } = controller({ authorizations });

    // Act + Assert
    await should(subject.authorize(PROPOSAL_ID, { json: true })).be.rejectedWith(/has no --json/u);
    // Refused BEFORE the mint: a code that was never minted is a code that cannot leak.
    should(authorizations.proposalIds).be.empty();
    should(out.lines).be.empty();
  });

  it('should let a daemon refusal reach the operator unchanged', async () => {
    // Arrange — the daemon says the proposal timed out; rounding that off to "unknown" would send
    // someone hunting for a typo in a correct id.
    const refusal = new Error('fleet proposal expired before it was authorized');
    const { subject, out } = controller({ authorizations: new RecordingAuthorizationGateway(refusal) });

    // Act + Assert
    await should(subject.authorize(PROPOSAL_ID, {})).be.rejectedWith(/expired/u);
    should(out.lines).be.empty();
  });

  it('should print a summary as text, never as something a terminal would act on', async () => {
    // Arrange — the account name is the attacker-influenced part of a server-derived line
    const summary = 'add claude-<b>ops</b> & co';
    const { subject, out } = controller({
      authorizations: new RecordingAuthorizationGateway(approvalMint({ summary })),
    });

    // Act
    await subject.authorize(PROPOSAL_ID, {});

    // Assert
    should(out.text).containEql(summary);
  });
});
