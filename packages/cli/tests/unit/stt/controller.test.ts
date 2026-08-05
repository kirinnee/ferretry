import { describe, it } from 'bun:test';
import should from 'should';
import { SttController } from '../../../src/lib/stt/controller';
import { CapturingOutput, RecordingSttGateway } from './fixtures';

function controller(gateway = new RecordingSttGateway()): {
  subject: SttController;
  gateway: RecordingSttGateway;
  out: CapturingOutput;
} {
  const out = new CapturingOutput();
  return { subject: new SttController(gateway, out), gateway, out };
}

describe('enhancement', () => {
  it('should clean up text given on the command line', async () => {
    // Arrange
    const { subject, gateway, out } = controller();

    // Act
    await subject.enhance(['never', 'install', 'at', 'the', 'root'], { model: ' llama ' });

    // Assert
    should(gateway.enhanced).eql([{ text: 'never install at the root', provider: 'groq', model: 'llama' }]);
    should(out.text).startWith('Never install at the repository root.');
  });

  it('should refuse an empty request rather than paying a provider for nothing', async () => {
    // Arrange
    const { subject, gateway } = controller();

    // Act + Assert
    await should(subject.enhance(['  '], {})).be.rejectedWith('enhance needs the text to clean up');
    should(gateway.enhanced).be.empty();
  });

  it('should omit every optional field the caller did not supply', async () => {
    // Arrange
    const { subject, gateway } = controller();

    // Act
    await subject.enhance(['hello'], { model: '  ', context: '  ', term: [] });

    // Assert
    should(gateway.enhanced).eql([{ text: 'hello', provider: 'groq' }]);
  });

  it('should collect repeated terms and a trimmed context into the request', async () => {
    // Arrange
    const { subject, gateway } = controller();

    // Act
    await subject.enhance(['hello'], { term: ['Ferretry', '  '], context: ' release notes ' });

    // Assert
    should(gateway.enhanced).eql([
      { text: 'hello', provider: 'groq', userContext: 'release notes', dictionary: [{ term: 'Ferretry' }] },
    ]);
  });

  it('should emit the enhancement payload under --json', async () => {
    // Arrange
    const { subject, out } = controller();

    // Act
    await subject.enhance(['hello'], { json: true });

    // Assert
    should(JSON.parse(out.text)).have.property('provider', 'groq');
  });
});
