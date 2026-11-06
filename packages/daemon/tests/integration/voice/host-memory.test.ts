import { expect, test } from 'bun:test';
import { availableVoiceMemory } from '../../../src/adapters/voice/host-memory.ts';

test('host memory adapter reads Linux MemAvailable and the OS fallback', async () => {
  // Arrange / Act / Assert
  expect(Number.isInteger(await availableVoiceMemory('darwin'))).toBe(true);
  if (process.platform === 'linux') expect(Number.isInteger(await availableVoiceMemory('linux'))).toBe(true);
});
