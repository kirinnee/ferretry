import { describe, it } from 'bun:test';
import { MAX_STT_DICTIONARY_ENTRIES, SttEnhancementRequestSchema } from '@ferretry/protocol';
import should from 'should';
import { SttController } from '../../../src/lib/stt/controller';
import { CapturingOutput, RecordingSttGateway } from './fixtures';

/** `--term` repeated `count` times, each entry distinguishable by its index. */
function terms(count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => `term-${index}`);
}

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

  it('should carry a dictionary that exactly fills the wire bound', async () => {
    // Arrange
    const { subject, gateway } = controller();

    // Act
    await subject.enhance(['hello'], { term: terms(MAX_STT_DICTIONARY_ENTRIES) });

    // Assert
    const request = gateway.enhanced[0];
    should(request?.dictionary).have.length(MAX_STT_DICTIONARY_ENTRIES);
    should(request?.dictionary?.at(-1)).eql({ term: `term-${MAX_STT_DICTIONARY_ENTRIES - 1}` });
    should(() => SttEnhancementRequestSchema.parse(request)).not.throw();
  });

  it('should discard the term past the wire bound rather than lose the whole correction', async () => {
    // One extra `--term` used to fail schema validation before the daemon was called, throwing away
    // the enhancement over a term the reader would not have missed.
    // Arrange
    const { subject, gateway, out } = controller();

    // Act
    await subject.enhance(['hello'], { term: terms(MAX_STT_DICTIONARY_ENTRIES + 1) });

    // Assert
    const request = gateway.enhanced[0];
    should(request?.dictionary).have.length(MAX_STT_DICTIONARY_ENTRIES);
    should(request?.dictionary).not.containEql({ term: `term-${MAX_STT_DICTIONARY_ENTRIES}` });
    should(() => SttEnhancementRequestSchema.parse(request)).not.throw();
    should(out.text).startWith('Never install at the repository root.');
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
