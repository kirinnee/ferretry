import { describe, it } from 'bun:test';
import { Command } from 'commander';
import should from 'should';
import { registerSttCommands } from '../../../src/lib/stt/commands';
import { SttController } from '../../../src/lib/stt/controller';
import { CapturingOutput, RecordingDelay, RecordingSttGateway, StubAudioFileReader } from './fixtures';

function run(argv: string[]) {
  const gateway = new RecordingSttGateway();
  const files = new StubAudioFileReader();
  const out = new CapturingOutput();
  const program = new Command().name('fy').exitOverride();
  program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  registerSttCommands(program, new SttController(gateway, out, files, new RecordingDelay()));
  return { parsed: program.parseAsync(['node', 'fy', ...argv]), gateway, files, out };
}

describe('dictation command surface', () => {
  it('should report status when no verb is given', async () => {
    // Arrange + Act
    const { parsed, out } = run(['stt']);
    await parsed;

    // Assert
    should(out.text).startWith('dictation is available');
  });

  it('should list models under either name', async () => {
    // Arrange + Act
    const models = run(['stt', 'models']);
    await models.parsed;
    const aliased = run(['stt', 'ls']);
    await aliased.parsed;

    // Assert
    should(models.out.text).containEql('parakeet-v3');
    should(aliased.out.text).containEql('parakeet-v3');
  });

  it('should install a model, waiting only when asked', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['stt', 'install', 'parakeet-v3']);
    await parsed;

    // Assert
    should(gateway.installed).eql(['parakeet-v3']);
    should(gateway.polled).be.empty();
  });

  it('should poll under --wait', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['stt', 'install', 'parakeet-v3', '--wait']);
    await parsed;

    // Assert
    should(gateway.polled).not.be.empty();
  });

  it('should transcribe a file', async () => {
    // Arrange + Act
    const { parsed, gateway, files } = run(['stt', 'transcribe', 'clip.wav']);
    await parsed;

    // Assert
    should(files.read_).eql(['clip.wav']);
    should(gateway.transcribed).have.length(1);
  });

  it('should collect repeated --term into the enhancement dictionary', async () => {
    // Arrange + Act
    const { parsed, gateway } = run([
      'stt',
      'transcribe',
      'clip.wav',
      '--enhance',
      '--term',
      'Ferretry',
      '--term',
      'kagent',
    ]);
    await parsed;

    // Assert
    should(gateway.enhanced[0]?.dictionary).eql([{ term: 'Ferretry' }, { term: 'kagent' }]);
  });

  it('should enhance text given as trailing words', async () => {
    // Arrange + Act
    const { parsed, gateway } = run(['stt', 'enhance', 'never', 'install', 'at', 'the', 'root']);
    await parsed;

    // Assert
    should(gateway.enhanced[0]?.text).equal('never install at the root');
  });

  it('should honour --json placed on the group rather than the verb', async () => {
    // Arrange + Act
    const { parsed, out } = run(['stt', '--json', 'models']);
    await parsed;

    // Assert
    should(JSON.parse(out.text)).have.property('models');
  });

  it('should refuse a verb that needs an argument without one', async () => {
    // Arrange + Act + Assert
    await should(run(['stt', 'transcribe']).parsed).be.rejected();
    await should(run(['stt', 'install']).parsed).be.rejected();
  });
});
