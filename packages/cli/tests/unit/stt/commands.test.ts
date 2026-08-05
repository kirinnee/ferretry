import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerSttCommands } from '../../../src/lib/stt/commands';
import { SttController } from '../../../src/lib/stt/controller';
import { CapturingOutput, RecordingSttGateway } from './fixtures';

function run(argv: string[]) {
  const gateway = new RecordingSttGateway();
  const out = new CapturingOutput();
  const program = new Command().name('fy').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerSttCommands(program, new SttController(gateway, out));
  return { parsed: program.parseAsync(['node', 'fy', ...argv]), gateway, out };
}

describe('dictation command surface', () => {
  it('should enhance text given as trailing words, enhance being the default verb', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['stt', 'never', 'install', 'at', 'the', 'root']);
    await parsed;

    // Assert
    should(gateway.enhanced[0]?.text).equal('never install at the root');
  });

  it('should also accept the verb spelled out explicitly', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['stt', 'enhance', 'never', 'install', 'at', 'the', 'root']);
    await parsed;

    // Assert
    should(gateway.enhanced[0]?.text).equal('never install at the root');
  });

  it('should collect repeated --term into the enhancement dictionary', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['stt', 'enhance', 'clean', 'this', '--term', 'Ferretry', '--term', 'kagent']);
    await parsed;

    // Assert
    should(gateway.enhanced[0]?.dictionary).eql([{ term: 'Ferretry' }, { term: 'kagent' }]);
  });

  it('should honour --json placed on the group rather than the verb', async () => {
    // Arrange + Act
    const { parsed, out } = run(['stt', '--json', 'enhance', 'hello']);
    await parsed;

    // Assert
    should(JSON.parse(out.text)).have.property('provider', 'groq');
  });

  it('should refuse a verb that needs an argument without one', async () => {
    // Arrange + Act + Assert
    await should(run(['stt', 'enhance']).parsed).be.rejected();
  });
});
