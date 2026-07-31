import { describe, it } from 'bun:test';
import { STT_MAX_PCM_BYTES } from '@ferretry/protocol';
import should from 'should';
import { INSTALL_POLL_INTERVAL_MS, INSTALL_WAIT_TIMEOUT_MS, SttController } from '../../../src/lib/stt/controller';
import {
  CapturingOutput,
  failedModel,
  installingModel,
  missingModel,
  modelList,
  readyModel,
  RecordingDelay,
  RecordingSttGateway,
  sttStatus,
  StubAudioFileReader,
  transcript,
} from './fixtures';

function controller(
  gateway = new RecordingSttGateway(),
  files = new StubAudioFileReader(),
): { subject: SttController; gateway: RecordingSttGateway; out: CapturingOutput; delay: RecordingDelay } {
  const out = new CapturingOutput();
  const delay = new RecordingDelay();
  return { subject: new SttController(gateway, out, files, delay), gateway, out, delay };
}

describe('dictation status and models', () => {
  it('should report whether dictation is available', async () => {
    // Arrange
    const { subject, out } = controller();

    // Act
    await subject.status({});

    // Assert
    should(out.text).startWith('dictation is available');
  });

  it('should list both models', async () => {
    // Arrange
    const { subject, out } = controller();

    // Act
    await subject.models({});

    // Assert
    should(out.text).containEql('parakeet-v3');
    should(out.text).containEql('whisper-tiny');
  });

  it('should emit the protocol payload under --json', async () => {
    // Arrange
    const { subject, out } = controller();

    // Act
    await subject.status({ json: true });
    await subject.models({ json: true });

    // Assert
    should(JSON.parse(out.lines[0] ?? '')).have.property('available', true);
    should(JSON.parse(out.lines[1] ?? '')).have.property('models');
  });
});

describe('model installation', () => {
  it('should return as soon as the daemon accepts the request', async () => {
    // Arrange
    const { subject, gateway, out, delay } = controller();

    // Act
    await subject.install(' parakeet-v3 ', {});

    // Assert
    should(gateway.installed).eql(['parakeet-v3']);
    should(delay.waited).be.empty();
    should(out.text).containEql('parakeet-v3: downloading 25%');
  });

  it('should refuse a blank model id instead of requesting an empty path segment', async () => {
    // Arrange
    const { subject } = controller();

    // Act + Assert
    await should(subject.install('  ', {})).be.rejectedWith('a model id is required');
  });

  it('should poll until the model is usable under --wait', async () => {
    // Arrange
    const gateway = new RecordingSttGateway({
      install: installingModel(),
      polls: [installingModel(256_000_000), readyModel()],
    });
    const { subject, out, delay } = controller(gateway);

    // Act
    await subject.install('parakeet-v3', { wait: true });

    // Assert
    should(gateway.polled).eql(['parakeet-v3', 'parakeet-v3']);
    should(delay.waited).eql([INSTALL_POLL_INTERVAL_MS, INSTALL_POLL_INTERVAL_MS]);
    should(out.text).containEql('installed 2026-07-30T09:00:00.000Z');
  });

  it('should not poll at all when the daemon already reports the model ready', async () => {
    // Arrange
    const gateway = new RecordingSttGateway({ install: readyModel() });
    const { subject, gateway: recorded, delay } = controller(gateway);

    // Act
    await subject.install('parakeet-v3', { wait: true });

    // Assert
    should(recorded.polled).be.empty();
    should(delay.waited).be.empty();
  });

  it('should fail loudly when the install ends in an error, rather than reporting success', async () => {
    // Arrange
    const gateway = new RecordingSttGateway({ install: installingModel(), polls: [failedModel()] });
    const { subject } = controller(gateway);

    // Act + Assert
    await should(subject.install('parakeet-v3', { wait: true })).be.rejectedWith(
      'parakeet-v3 failed to install: checksum mismatch',
    );
  });

  it('should give up waiting rather than hanging a terminal forever', async () => {
    // Arrange — the daemon never leaves the installing state
    const gateway = new RecordingSttGateway({ install: installingModel(), polls: [installingModel()] });
    const { subject, delay } = controller(gateway);

    // Act + Assert
    await should(subject.install('parakeet-v3', { wait: true })).be.rejectedWith(/still installing after 1800s/u);
    should(delay.waited).have.length(INSTALL_WAIT_TIMEOUT_MS / INSTALL_POLL_INTERVAL_MS);
  });
});

describe('transcription', () => {
  it('should send wav bytes with the wav content type', async () => {
    // Arrange
    const files = new StubAudioFileReader(new Uint8Array(64_000));
    const { subject, gateway, out } = controller(new RecordingSttGateway(), files);

    // Act
    await subject.transcribe('clip.wav', {});

    // Assert
    should(files.read_).eql(['clip.wav']);
    should(gateway.transcribed).eql([{ bytes: 64_000, contentType: 'audio/wav' }]);
    should(out.text).startWith('never install at the repository root');
  });

  it('should send raw samples with the L16 content type the daemon parses', async () => {
    // Arrange
    const { subject, gateway } = controller();

    // Act
    await subject.transcribe('notes.pcm', {});

    // Assert
    should(gateway.transcribed[0]?.contentType).equal('audio/L16; rate=16000; channels=1');
  });

  it('should refuse an over-long clip before uploading it', async () => {
    // Arrange
    const files = new StubAudioFileReader(new Uint8Array(STT_MAX_PCM_BYTES + 32_000));
    const { subject, gateway } = controller(new RecordingSttGateway(), files);

    // Act + Assert
    await should(subject.transcribe('long.pcm', {})).be.rejectedWith(/holds about 121s of audio/u);
    should(gateway.transcribed).be.empty();
  });

  it('should refuse a file whose encoding it cannot name, without reading it', async () => {
    // Arrange
    const files = new StubAudioFileReader();
    const { subject } = controller(new RecordingSttGateway(), files);

    // Act + Assert
    await should(subject.transcribe('clip.mp3', {})).be.rejectedWith(/cannot tell how/u);
    should(files.read_).be.empty();
  });

  it('should warn when the model heard nothing instead of printing a silent blank line', async () => {
    // Arrange
    const gateway = new RecordingSttGateway({ transcript: transcript({ text: '  ' }) });
    const { subject, out } = controller(gateway);

    // Act
    await subject.transcribe('clip.wav', {});

    // Assert
    should(out.warnings).eql(['clip.wav: the model heard nothing']);
  });

  it('should chain the transcript into the enhancer when asked', async () => {
    // Arrange
    const { subject, gateway, out } = controller();

    // Act
    await subject.transcribe('clip.wav', { enhance: true, term: ['Ferretry', '  '], context: ' release notes ' });

    // Assert
    should(gateway.enhanced).eql([
      {
        text: 'never install at the repository root',
        provider: 'groq',
        userContext: 'release notes',
        dictionary: [{ term: 'Ferretry' }],
      },
    ]);
    should(out.text).startWith('Never install at the repository root.');
  });

  it('should keep both the raw and the enhanced text in the --json payload', async () => {
    // Arrange
    const { subject, out } = controller();

    // Act
    await subject.transcribe('clip.wav', { enhance: true, json: true });

    // Assert
    const payload = JSON.parse(out.text) as { text: string; enhanced: { text: string } };
    should(payload.text).equal('never install at the repository root');
    should(payload.enhanced.text).equal('Never install at the repository root.');
  });
});

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

  it('should emit the enhancement payload under --json', async () => {
    // Arrange
    const { subject, out } = controller();

    // Act
    await subject.enhance(['hello'], { json: true });

    // Assert
    should(JSON.parse(out.text)).have.property('provider', 'groq');
  });
});

describe('an unavailable subsystem', () => {
  it('should still report status when no model is installed', async () => {
    // Arrange
    const gateway = new RecordingSttGateway({
      status: sttStatus({ models: modelList(missingModel()).models, worker: { phase: 'cold' } }),
    });
    const { subject, out } = controller(gateway);

    // Act
    await subject.status({});

    // Assert
    should(out.text).startWith('dictation is NOT available');
  });
});
