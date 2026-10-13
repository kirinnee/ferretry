import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerFleetCommands } from '../../../src/lib/fleet/commands';
import { RecommendController } from '../../../src/lib/fleet/recommend';
import { CapturingOutput, RecordingRecommendationGateway } from './fixtures';

function run(argv: string[], binaryName = 'fy') {
  const recommendations = new RecordingRecommendationGateway();
  const out = new CapturingOutput();
  const program = new Command().name(binaryName).exitOverride();
  const printed: string[] = [];
  program.configureOutput({ writeOut: text => printed.push(text), writeErr: () => {} });
  registerFleetCommands(program, new RecommendController({ recommendations, out, binaryName }));
  return { parsed: program.parseAsync(['node', binaryName, ...argv]), printed, recommendations, out };
}

describe('fleet command surface', () => {
  it('should list only recommend under the fleet group', async () => {
    // Arrange + Act
    const { parsed, printed } = run(['fleet', '--help']);
    await parsed.catch(() => undefined);

    // Assert — the old verbs were deleted with the old account system, not hidden
    const help = printed.join('');
    should(help).containEql('recommend');
    for (const retired of ['ls', 'init', 'apply', 'usage', 'health', 'sharing', 'login', 'migrate']) {
      should(help).not.match(new RegExp(`^\\s+${retired}\\b`, 'mu'));
    }
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
    const { parsed, out } = run(['fleet', '--json', 'recommend', 'anything']);
    await parsed;

    // Assert
    should(JSON.parse(out.text)).have.property('roles');
  });

  it('should refuse a recommendation with no task', async () => {
    // Arrange + Act + Assert
    await should(run(['fleet', 'recommend']).parsed).be.rejected();
  });

  it('should refuse a retired verb', async () => {
    // Arrange + Act + Assert
    await should(run(['fleet', 'apply']).parsed).be.rejected();
  });
});
