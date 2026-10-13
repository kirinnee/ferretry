import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerFleetCommands } from '../../../src/lib/fleet/commands';
import { FleetController } from '../../../src/lib/fleet/controller';
import { PLAIN_FLEET_PRESENTATION } from '../../../src/lib/fleet/presentation';
import {
  CapturingOutput,
  FrozenClock,
  RecordingApplier,
  RecordingHealthCollector,
  RecordingIdentitySource,
  RecordingLoginService,
  RecordingPlanner,
  RecordingRecommendationGateway,
  RecordingScaffolder,
  RecordingSharingGateway,
  RecordingUsageCollector,
  StubConfigSource,
  StubManifestSource,
} from './fixtures';

function run(argv: string[], binaryName = 'fy') {
  const applier = new RecordingApplier();
  const recommendations = new RecordingRecommendationGateway();
  const usage = new RecordingUsageCollector();
  const health = new RecordingHealthCollector();
  const logins = new RecordingLoginService();
  const identities = new RecordingIdentitySource();
  const scaffolder = new RecordingScaffolder();
  const sharing = new RecordingSharingGateway();
  const out = new CapturingOutput();
  const program = new Command().name(binaryName).exitOverride();
  const printed: string[] = [];
  program.configureOutput({ writeOut: text => printed.push(text), writeErr: () => {} });
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
      sharing,
      logins,
      clock: new FrozenClock(),
      recommendations,
      out,
      presentation: PLAIN_FLEET_PRESENTATION,
      binaryName,
    }),
  );
  return {
    parsed: program.parseAsync(['node', binaryName, ...argv]),
    printed,
    applier,
    recommendations,
    usage,
    health,
    logins,
    identities,
    scaffolder,
    sharing,
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

  it('should accept the obvious list alias', async () => {
    // Arrange + Act
    const { parsed, out } = run(['fleet', 'list']);
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

  it('should name the binary it runs as in the first-account refusal', async () => {
    // Arrange + Act — not the shipped name, so a spelled-out "fy" cannot pass.
    const { parsed } = run(['fleet', 'init', '--first-account=other'], 'foo');

    // Assert
    await should(parsed).be.rejectedWith(/: foo fleet init --first-account=claude$/u);
  });

  it('should name the binary it runs as in the health and login help', async () => {
    // Arrange + Act
    const health = run(['fleet', 'health', '--help'], 'foo');
    await should(health.parsed).be.rejected();
    const login = run(['fleet', 'login', '--help'], 'foo');
    await should(login.parsed).be.rejected();

    // Assert
    should(health.printed.join('')).containEql('`foo fleet login <accountId>` matches on the whole id');
    should(login.printed.join('')).containEql('That is why `foo fleet health` prints this command');
    should([...health.printed, ...login.printed].join('')).not.match(/\bfy fleet/u);
  });

  it('should not be the default verb — that must never be the one that writes', async () => {
    // Arrange + Act
    const { parsed, scaffolder } = run(['fleet']);
    await parsed;

    // Assert
    should(scaffolder.calls).equal(0);
  });
});

describe('the fleet sharing verb', () => {
  it('should read the report and accept the group-wide --json flag', async () => {
    // Act
    const { parsed, sharing, out } = run(['fleet', '--json', 'sharing']);
    await parsed;

    // Assert
    should(sharing.calls).equal(1);
    should(JSON.parse(out.text)).have.property('accounts');
  });
});

describe('old fleet verbs on the account model', () => {
  it('should name the command that replaces each one, and still run it', async () => {
    // Arrange
    const cases: [string[], RegExp][] = [
      [['fleet', 'ls'], /`fz runtimes` replaces `fz fleet ls`/],
      [['fleet', 'init'], /`fz setup` replaces `fz fleet init`/],
      [['fleet', 'apply', '--dry-run'], /apply by themselves/],
      [['fleet', 'usage'], /`fz credentials` shows each login's usage/],
      [['fleet', 'health'], /`fz credentials` shows whether each login works/],
      [['fleet', 'sharing'], /`fz component show <kind>\/<name>`/],
      [['fleet', 'login', '--status'], /`fz credentials` shows every login/],
      [['fleet', 'login', '--sync-only'], /nothing to sync/],
      [['fleet', 'login', 'acct-1'], /`fz credential signin <login>`/],
    ];

    for (const [argv, note] of cases) {
      // Act
      const { parsed, out } = run(argv, 'fz');
      await parsed.catch(() => undefined);

      // Assert
      should(out.warnings.join('\n')).match(note);
    }
  });

  it('should keep JSON clean of the note', async () => {
    const { parsed, out } = run(['fleet', 'ls', '--json'], 'fz');
    await parsed;
    should(out.warnings.join('\n')).not.match(/replaces/);
  });
});
