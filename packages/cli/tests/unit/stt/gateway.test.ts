import { describe, it } from 'bun:test';
import should from 'should';
import type { z } from 'zod';
import { ProtocolSttGateway, STT_ENHANCE_PATH } from '../../../src/lib/stt/gateway';
import type { SttApiClient } from '../../../src/lib/stt/ports';
import { enhancement } from './fixtures';

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

describe('protocol dictation gateway', () => {
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
    await should(gateway.enhance({ text: 'hello', provider: 'groq' })).be.rejected();
  });
});
