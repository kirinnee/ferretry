import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerLearningCommands } from '../../../src/lib/learning/commands';
import { LearningController } from '../../../src/lib/learning/controller';
import { CapturingOutput, proposal, RecordingLearningGateway } from './fixtures';

function run(argv: string[], board = [proposal('p1'), proposal('p2', { state: 'accepted' })]) {
  const gateway = new RecordingLearningGateway(board);
  const out = new CapturingOutput();
  const program = new Command().name('fy').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerLearningCommands(program, new LearningController(gateway, out));
  return { parsed: program.parseAsync(['node', 'fy', ...argv]), gateway, out };
}

describe('learning command surface', () => {
  it('should list the pending board when no verb is given', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['learning']);
    await parsed;

    // Assert
    should(gateway.listed).eql(['pending']);
  });

  it('should accept the list alias', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['learning', 'list', '--all']);
    await parsed;

    // Assert
    should(gateway.listed).eql([undefined]);
  });

  it('should carry --state through to the controller', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['learning', 'ls', '--state', 'accepted']);
    await parsed;

    // Assert
    should(gateway.listed).eql(['accepted']);
  });

  it('should honour --json placed on the group rather than the verb', async () => {
    // Arrange + Act
    const { parsed, out } = run(['learning', '--json', 'ls']);
    await parsed;

    // Assert
    should(JSON.parse(out.text)).be.an.Array();
  });

  it('should show one proposal in full', async () => {
    // Arrange + Act
    const { parsed, out } = run(['learning', 'show', 'p2']);
    await parsed;

    // Assert
    should(out.text).startWith('p2  [accepted]');
  });

  it('should accept a proposal', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['learning', 'accept', 'p1']);
    await parsed;

    // Assert
    should(gateway.acted).eql([{ id: 'p1', request: { action: 'accept' } }]);
  });

  it('should reject a proposal with a note', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['learning', 'reject', 'p1', '--note', 'too narrow']);
    await parsed;

    // Assert
    should(gateway.acted[0]?.request).eql({ action: 'reject', note: 'too narrow' });
  });

  it('should join the reworded rule from the remaining words', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['learning', 'edit', 'p1', 'never', 'install', 'at', 'the', 'root']);
    await parsed;

    // Assert
    should(gateway.acted[0]?.request).eql({ action: 'edit', ruleText: 'never install at the root' });
  });

  it('should print the guidance patch', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['learning', 'patch', 'p1']);
    await parsed;

    // Assert
    should(gateway.patched).eql(['p1']);
  });

  it('should mine on demand, spawning miners only when asked', async () => {
    // Arrange + Act
    const plain = run(['learning', 'run']);
    await plain.parsed;
    const spawning = run(['learning', 'run', '--spawn']);
    await spawning.parsed;

    // Assert
    should(plain.gateway.ran).eql([false]);
    should(spawning.gateway.ran).eql([true]);
  });

  it('should report status and config', async () => {
    // Arrange + Act
    const status = run(['learning', 'status']);
    await status.parsed;
    const config = run(['learning', 'config']);
    await config.parsed;

    // Assert
    should(status.out.text).containEql('learning is enabled');
    should(config.out.text).containEql('miner: miner');
  });

  it('should refuse a verb that needs an id without one', async () => {
    // Arrange + Act + Assert
    const { parsed } = run(['learning', 'show']);
    await should(parsed).be.rejected();
  });
});
