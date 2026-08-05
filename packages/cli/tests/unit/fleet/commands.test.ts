import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerFleetCommands } from '../../../src/lib/fleet/commands';
import { FleetController } from '../../../src/lib/fleet/controller';
import {
  CapturingOutput,
  FrozenClock,
  RecordingApplier,
  RecordingLoginService,
  RecordingPlanner,
  RecordingRecommendationGateway,
  RecordingUsageCollector,
  StubConfigSource,
  StubManifestSource,
} from './fixtures';

function run(argv: string[]) {
  const applier = new RecordingApplier();
  const recommendations = new RecordingRecommendationGateway();
  const usage = new RecordingUsageCollector();
  const logins = new RecordingLoginService();
  const out = new CapturingOutput();
  const program = new Command().name('fy').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerFleetCommands(
    program,
    new FleetController({
      config: new StubConfigSource(),
      manifests: new StubManifestSource(),
      planner: new RecordingPlanner(),
      applier,
      usage,
      logins,
      clock: new FrozenClock(),
      recommendations,
      out,
    }),
  );
  return { parsed: program.parseAsync(['node', 'fy', ...argv]), applier, recommendations, usage, logins, out };
}

describe('fleet command surface', () => {
  it('should list, not apply, when no verb is given', async () => {
    // Arrange + Act
    const { parsed, applier, out } = run(['fleet']);
    await parsed;

    // Assert — a bare group name must never be the verb that writes to disk
    should(applier.applied).be.empty();
    should(out.text).containEql('1 account provisioned');
  });

  it('should accept the accounts alias', async () => {
    // Arrange + Act
    const { parsed, out } = run(['fleet', 'accounts']);
    await parsed;

    // Assert
    should(out.text).containEql('1 account provisioned');
  });

  it('should apply the configuration', async () => {
    // Arrange + Act
    const { parsed, applier } = run(['fleet', 'apply']);
    await parsed;

    // Assert
    should(applier.applied).have.length(1);
  });

  it('should write nothing under --dry-run', async () => {
    // Arrange + Act
    const { parsed, applier, out } = run(['fleet', 'apply', '--dry-run']);
    await parsed;

    // Assert
    should(applier.applied).be.empty();
    should(out.text).containEql('nothing has been written');
  });

  it('should report usage', async () => {
    // Arrange + Act
    const { parsed, usage } = run(['fleet', 'usage']);
    await parsed;

    // Assert
    should(usage.collected).have.length(1);
  });

  it('should recommend from the trailing words, probing quota by default', async () => {
    // Arrange + Act
    const { parsed, recommendations } = run(['fleet', 'recommend', 'port', 'the', 'CLI']);
    await parsed;

    // Assert
    should(recommendations.requests).eql([{ task: 'port the CLI', usage: true }]);
  });

  it('should turn the probe off with --no-usage', async () => {
    // Arrange + Act
    const { parsed, recommendations } = run(['fleet', 'recommend', 'anything', '--no-usage']);
    await parsed;

    // Assert
    should(recommendations.requests[0]?.usage).be.false();
  });

  it('should honour --json placed on the group rather than the verb', async () => {
    // Arrange + Act
    const { parsed, out } = run(['fleet', '--json', 'ls']);
    await parsed;

    // Assert
    should(JSON.parse(out.text)).have.property('accounts');
  });

  it('should refuse a recommendation with no task', async () => {
    // Arrange + Act + Assert
    await should(run(['fleet', 'recommend']).parsed).be.rejected();
  });
});

describe('fleet login', () => {
  it('should log every account in when no id is given', async () => {
    // Arrange + Act
    const { parsed, logins, out } = run(['fleet', 'login']);
    await parsed;

    // Assert
    should(logins.requests).have.length(1);
    should(logins.requests[0]?.accountIds).be.undefined();
    should(out.text).containEql('logged in');
  });

  it('should pass the named account ids through verbatim', async () => {
    // Arrange + Act
    const { parsed, logins } = run(['fleet', 'login', 'one', 'two']);
    await parsed;

    // Assert — ids are opaque; nothing here parses one.
    should(logins.requests[0]?.accountIds).deepEqual(['one', 'two']);
  });

  it('should honour --json', async () => {
    // Arrange + Act
    const { parsed, out } = run(['fleet', 'login', '--json']);
    await parsed;

    // Assert
    should(JSON.parse(out.text)).have.length(1);
  });
});
