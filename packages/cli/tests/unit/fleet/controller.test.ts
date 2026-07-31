import { describe, it } from 'bun:test';
import should from 'should';
import { FleetController, type FleetControllerDeps } from '../../../src/lib/fleet/controller';
import {
  CapturingOutput,
  FrozenClock,
  GENERATED_AT,
  RecordingApplier,
  RecordingPlanner,
  RecordingRecommendationGateway,
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
    planner: new RecordingPlanner(),
    applier: new RecordingApplier(),
    usage: new RecordingUsageCollector(),
    clock: new FrozenClock(),
    recommendations: new RecordingRecommendationGateway(),
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
