import { describe, expect, test } from 'bun:test';
import {
  FileTranscriptChanges,
  type TranscriptFileStamp,
} from '../../../../../daemon/adapters/session/live/file-transcript-changes.ts';

const NOW = '2026-11-08T10:00:00.000Z';

describe('FileTranscriptChanges: one stat in flight', () => {
  test('U5 a stalled disk does not stack a pending stat for every tick', async () => {
    let tick: () => void = () => undefined;
    const release: Array<(stamp: TranscriptFileStamp | undefined) => void> = [];
    let stats = 0;
    const heard: string[] = [];
    const watch = new FileTranscriptChanges({
      file: async () => '/home/s1.jsonl',
      stat: () => {
        stats += 1;
        // The first stat (before subscribing) answers at once; every later one stalls until released.
        if (stats === 1) return Promise.resolve({ size: 1, mtimeMs: 1 });
        return new Promise(resolve => release.push(resolve));
      },
      files: {
        subscribe: (_path, listener) => {
          tick = () => listener('/home/s1.jsonl');
          return { close: () => undefined };
        },
      },
      clock: { now: () => NOW },
    }).watch('s1', at => heard.push(at));
    await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));

    tick();
    tick();
    tick();
    expect(stats).toBe(2);

    release[0]?.({ size: 2, mtimeMs: 2 });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(heard).toEqual([NOW]);

    tick();
    expect(stats).toBe(3);
    watch.close();
  });
});
