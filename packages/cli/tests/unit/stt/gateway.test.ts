import { describe, it } from 'bun:test';
import should from 'should';
import type { z } from 'zod';
import {
  ProtocolSttGateway,
  STT_ENHANCE_PATH,
  STT_MODELS_PATH,
  STT_STATUS_PATH,
  STT_TRANSCRIBE_PATH,
  STT_TRANSCRIBE_TIMEOUT_MS,
  sttInstallPath,
} from '../../../src/lib/stt/gateway';
import type { SttApiClient } from '../../../src/lib/stt/ports';
import { enhancement, installingModel, modelList, sttStatus, transcript } from './fixtures';

interface Call {
  path: string;
  init: RequestInit | undefined;
  timeoutMs: number | undefined;
}

function fakeClient(payload: unknown, calls: Call[] = []): SttApiClient {
  return {
    request: <T>(path: string, schema: z.ZodType<T>, init?: RequestInit, timeoutMs?: number): Promise<T> => {
      calls.push({ path, init, timeoutMs });
      return Promise.resolve(schema.parse(payload));
    },
  };
}

describe('dictation routes', () => {
  it('should escape a model id that would otherwise break the route', () => {
    // Act + Assert
    should(sttInstallPath('a/b')).equal('/v1/stt/models/a%2Fb/install');
  });
});

describe('protocol dictation gateway', () => {
  it('should read the status and the model inventory with plain GETs', async () => {
    // Arrange
    const statusCalls: Call[] = [];
    const modelCalls: Call[] = [];

    // Act
    const status = await new ProtocolSttGateway(fakeClient(sttStatus(), statusCalls)).status();
    const models = await new ProtocolSttGateway(fakeClient(modelList(), modelCalls)).models();

    // Assert
    should(statusCalls[0]).match({ path: STT_STATUS_PATH, init: undefined });
    should(modelCalls[0]).match({ path: STT_MODELS_PATH, init: undefined });
    should(status.available).be.true();
    should(models.models.daemon.id).equal('parakeet-v3');
  });

  it('should read one model install with a GET and start it with a POST', async () => {
    // Arrange
    const calls: Call[] = [];
    const gateway = new ProtocolSttGateway(fakeClient(installingModel(), calls));

    // Act
    await gateway.modelStatus('parakeet-v3');
    await gateway.install('parakeet-v3');

    // Assert
    should(calls[0]?.init).be.undefined();
    should(calls[1]?.init?.method).equal('POST');
    should(calls[0]?.path).equal(calls[1]?.path);
  });

  it('should post audio with its encoding and a timeout that survives a cold worker', async () => {
    // Arrange
    const calls: Call[] = [];
    const gateway = new ProtocolSttGateway(fakeClient(transcript(), calls));
    const audio = new Uint8Array(3_200);

    // Act
    const actual = await gateway.transcribe(audio, 'audio/wav');

    // Assert
    should(calls[0]?.path).equal(STT_TRANSCRIBE_PATH);
    should(calls[0]?.timeoutMs).equal(STT_TRANSCRIBE_TIMEOUT_MS);
    should(new Headers(calls[0]?.init?.headers).get('content-length')).equal('3200');
    should(new Headers(calls[0]?.init?.headers).get('content-type')).equal('audio/wav');
    should(calls[0]?.init?.body).equal(audio);
    should(actual.modelId).equal('parakeet-v3');
  });

  it('should post an enhancement as validated protocol JSON', async () => {
    // Arrange
    const calls: Call[] = [];
    const gateway = new ProtocolSttGateway(fakeClient(enhancement(), calls));

    // Act
    const actual = await gateway.enhance({ text: 'hello', provider: 'groq' });

    // Assert
    should(calls[0]?.path).equal(STT_ENHANCE_PATH);
    should(JSON.parse(String(calls[0]?.init?.body))).eql({ text: 'hello', provider: 'groq' });
    should(actual.provider).equal('groq');
  });

  it('should refuse an enhancement the protocol rejects before it reaches the daemon', async () => {
    // Arrange
    const calls: Call[] = [];
    const gateway = new ProtocolSttGateway(fakeClient(enhancement(), calls));

    // Act + Assert — the protocol caps the payload at 8000 characters
    await should(gateway.enhance({ text: 'x'.repeat(8_001), provider: 'groq' })).be.rejected();
    should(calls).be.empty();
  });

  it('should fail loudly when the daemon answers with an error envelope', async () => {
    // Arrange
    const gateway = new ProtocolSttGateway(fakeClient({ error: 'model missing', code: 'model_missing' }));

    // Act + Assert
    await should(gateway.status()).be.rejected();
  });
});
