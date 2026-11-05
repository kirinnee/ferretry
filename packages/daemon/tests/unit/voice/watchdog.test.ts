import { expect, test } from 'bun:test';
import { VoiceRssWatchdog } from '../../../src/lib/voice/watchdog.ts';
import { notInstalledVoiceDescription, voiceMemoryLimit } from '../../../src/lib/voice/policy.ts';

test('RSS watchdog stops over the declared cap, once, and preserves a worker at the cap', async () => {
  // Arrange
  const recognizer = { ...notInstalledVoiceDescription(2), peakResidentBytes: 2_000_000_000 };
  let rss = voiceMemoryLimit([recognizer]);
  const reasons: string[] = [];
  const subject = new VoiceRssWatchdog({
    recognizers: [recognizer],
    hardCapped: false,
    rss: async () => rss,
    stop: async reason => {
      reasons.push(reason);
    },
  });
  // Act / Assert
  await subject.check();
  expect(reasons).toEqual([]);
  rss++;
  await subject.check();
  await subject.check();
  expect(reasons).toEqual(['Speech worker exceeded its resident memory ceiling.']);
});
test('checks never overlap or stop a child that was closed while its RSS read was pending', async () => {
  // Arrange
  const reading = Promise.withResolvers<number>();
  let reads = 0;
  let stops = 0;
  const subject = new VoiceRssWatchdog({
    recognizers: [notInstalledVoiceDescription(1)],
    hardCapped: false,
    rss: async () => {
      reads++;
      return await reading.promise;
    },
    stop: async () => {
      stops++;
    },
  });
  // Act
  const first = subject.check();
  await subject.check();
  subject.close();
  reading.resolve(3_000_000_000);
  await first;
  // Assert
  expect(reads).toBe(1);
  expect(stops).toBe(0);
});
test('unreadable RSS fails closed on best-effort hosts; kernel-capped hosts retain their cap', async () => {
  // Arrange / Act / Assert
  for (const hardCapped of [true, false]) {
    const reasons: string[] = [];
    const subject = new VoiceRssWatchdog({
      recognizers: [notInstalledVoiceDescription(1)],
      hardCapped,
      rss: async () => {
        throw new Error('no process');
      },
      stop: async reason => {
        reasons.push(reason);
      },
    });
    await subject.check();
    expect(reasons).toEqual(hardCapped ? [] : ['Speech worker RSS watchdog could not read memory.']);
  }
});
