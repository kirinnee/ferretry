import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerFleetCommands } from '../../../src/lib/fleet/commands';
import { FleetController } from '../../../src/lib/fleet/controller';
import {
  CapturingOutput,
  FrozenClock,
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
} from './fixtures';

function run(argv: string[]) {
  const applier = new RecordingApplier();
  const recommendations = new RecordingRecommendationGateway();
  const authorizations = new RecordingAuthorizationGateway();
  const usage = new RecordingUsageCollector();
  const health = new RecordingHealthCollector();
  const logins = new RecordingLoginService();
  const identities = new RecordingIdentitySource();
  const scaffolder = new RecordingScaffolder();
  const out = new CapturingOutput();
  const program = new Command().name('fy').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerFleetCommands(
    program,
    new FleetController({
      config: new StubConfigSource(),
      manifests: new StubManifestSource(),
      scaffolder,
      planner: new RecordingPlanner(),
      applier,
      usage,
      health,
      identities,
      logins,
      clock: new FrozenClock(),
      recommendations,
      authorizations,
      out,
    }),
  );
  return {
    parsed: program.parseAsync(['node', 'fy', ...argv]),
    applier,
    recommendations,
    authorizations,
    usage,
    health,
    logins,
    identities,
    scaffolder,
    out,
  };
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

  it('should explicitly probe fleet health', async () => {
    // Arrange + Act
    const { parsed, health } = run(['fleet', 'health']);
    await parsed;

    // Assert
    should(health.collected).have.length(1);
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

  it('should carry --sync-only through as a copy-only pass', async () => {
    // Arrange + Act
    const { parsed, logins } = run(['fleet', 'login', '--sync-only']);
    await parsed;

    // Assert
    should(logins.requests[0]?.mode).equal('sync-only');
  });

  it('should report without logging anything in under --status', async () => {
    // Arrange + Act
    const { parsed, logins, identities } = run(['fleet', 'login', '--status']);
    await parsed;

    // Assert
    should(logins.requests).deepEqual([]);
    should(identities.surveyed).have.length(1);
  });
});

describe('fleet init', () => {
  it('should prepare the host', async () => {
    // Arrange + Act
    const { parsed, scaffolder, out } = run(['fleet', 'init']);
    await parsed;

    // Assert
    should(scaffolder.calls).equal(1);
    should(out.text).containEql('PATH');
  });

  it('should make a script-selected first account explicit to the scaffolder', async () => {
    // Arrange + Act
    const { parsed, scaffolder } = run(['fleet', 'init', '--first-account=codex']);
    await parsed;

    // Assert — no CLI-side defaulting means a script gets exactly the harness it named.
    should(scaffolder.options).deepEqual([{ firstAccount: 'codex' }]);
  });

  it('should ask the host to detect a harness when no first-account value is supplied', async () => {
    // Arrange + Act
    const { parsed, scaffolder } = run(['fleet', 'init', '--first-account']);
    await parsed;

    // Assert — production resolves this with defaultFleetHarness from positive PATH evidence.
    should(scaffolder.options).deepEqual([{ firstAccount: 'detected' }]);
  });

  it('should refuse an unknown first-account harness before it writes', async () => {
    // Arrange + Act
    const { parsed, scaffolder } = run(['fleet', 'init', '--first-account=other']);

    // Assert
    await should(parsed).be.rejectedWith(/must be "claude" or "codex"/u);
    should(scaffolder.calls).equal(0);
  });

  it('should not be the default verb — that must never be the one that writes', async () => {
    // Arrange + Act
    const { parsed, scaffolder } = run(['fleet']);
    await parsed;

    // Assert
    should(scaffolder.calls).equal(0);
  });
});

describe('fleet authorize', () => {
  it('should carry the proposal id through to the controller', async () => {
    // Arrange + Act
    const { parsed, authorizations } = run(['fleet', 'authorize', PROPOSAL_ID]);
    await parsed;

    // Assert
    should(authorizations.proposalIds).eql([PROPOSAL_ID]);
  });

  it('should print the code the browser is waiting for', async () => {
    // Arrange + Act
    const { parsed, out } = run(['fleet', 'authorize', PROPOSAL_ID]);
    await parsed;

    // Assert
    should(out.text).containEql('7F3K-M9QW');
    should(out.text).containEql('approves this one change and nothing else');
  });

  it('should refuse to run without naming a proposal', async () => {
    // Arrange + Act — approving "whatever is pending" is not a thing this may guess at
    const { parsed, authorizations } = run(['fleet', 'authorize']);

    // Assert
    await should(parsed).be.rejected();
    should(authorizations.proposalIds).be.empty();
  });

  it('should not offer --json on the verb itself', async () => {
    // Arrange + Act
    const { parsed, authorizations } = run(['fleet', 'authorize', '--json', PROPOSAL_ID]);

    // Assert — an unknown option, not a silently honoured one
    await should(parsed).be.rejected();
    should(authorizations.proposalIds).be.empty();
  });

  it('should refuse the group-level --json rather than inherit it', async () => {
    // Arrange + Act — `scoped()` puts --json on the group, and `merged()` spreads the group first,
    // so this reaches the verb whether or not the verb declared it.
    const { parsed, authorizations } = run(['fleet', '--json', 'authorize', PROPOSAL_ID]);

    // Assert
    await should(parsed).be.rejectedWith(/has no --json/u);
    should(authorizations.proposalIds).be.empty();
  });
});
