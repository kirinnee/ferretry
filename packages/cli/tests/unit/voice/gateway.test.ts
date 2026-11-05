import { describe, it } from 'bun:test';
import should from 'should';
import type { z } from 'zod';
import { ProtocolVoiceGateway, VOICE_ENGINE_PATH } from '../../../src/lib/voice/gateway';
import type { VoiceApiClient } from '../../../src/lib/voice/ports';
import { view } from './fixtures';

interface Call {
  path: string;
  init: RequestInit | undefined;
}

function fakeClient(payload: unknown, calls: Call[] = []): VoiceApiClient {
  return {
    request: <T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> => {
      calls.push({ path, init });
      return Promise.resolve(schema.parse(payload));
    },
  };
}

describe('protocol voice gateway', () => {
  it('should read the engine and post each act to its own route with the model id as JSON', async () => {
    // Arrange
    const calls: Call[] = [];
    const gateway = new ProtocolVoiceGateway(fakeClient(view(), calls));

    // Act
    await gateway.status();
    await gateway.install('parakeet');
    await gateway.cancel();
    await gateway.remove('whisper-turbo');
    await gateway.use('whisper-turbo');

    // Assert
    should(calls.map(call => [call.init?.method, call.path])).deepEqual([
      ['GET', VOICE_ENGINE_PATH],
      ['POST', `${VOICE_ENGINE_PATH}/install`],
      ['POST', `${VOICE_ENGINE_PATH}/cancel`],
      ['POST', `${VOICE_ENGINE_PATH}/remove`],
      ['POST', `${VOICE_ENGINE_PATH}/use`],
    ]);
    should(JSON.parse(String(calls[1]?.init?.body))).eql({ id: 'parakeet' });
    should(JSON.parse(String(calls[3]?.init?.body))).eql({ id: 'whisper-turbo' });
  });

  it('should refuse a response the protocol does not recognise', async () => {
    // Arrange
    const gateway = new ProtocolVoiceGateway(fakeClient({ target: 'linux-x64' }));

    // Act
    const failure = gateway.status();

    // Assert
    await failure.then(
      () => should.fail('resolved', 'rejected'),
      error => should(error).be.instanceOf(Error),
    );
  });
});
