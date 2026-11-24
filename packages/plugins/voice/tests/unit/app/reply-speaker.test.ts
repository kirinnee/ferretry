import { describe, expect, test } from 'bun:test';
import type { ReplyState } from '../../../contract/index.ts';
import { createReplySpeaker, type ReplyVoiceSource } from '../../../app/lib/stream/reply-speaker.ts';
import type { SpeakerPort, SpeakRequest } from '../../../app/lib/voice-chat/ports.ts';

function rig(state: ReplyState | undefined, options: { stream?: boolean; sends?: boolean } = {}) {
  const device: SpeakRequest[] = [];
  const machine: string[] = [];
  const sources: ReplyVoiceSource[] = [];
  let ids = 0;
  const port: SpeakerPort = {
    supported: true,
    voices: () => [],
    unlock: () => undefined,
    speak: request => void device.push(request),
    stop: () => undefined,
  };
  const speaker = createReplySpeaker({
    stream: () =>
      options.stream === false
        ? undefined
        : {
            speak: text => {
              if (options.sends === false) return [];
              machine.push(text);
              return [{ id: ids++, text }];
            },
          },
    replyState: () => state,
    device: port,
    onSource: source => void sources.push(source),
    language: 'en-US',
  });
  return { speaker, device, machine, sources };
}

describe('the reply speaker', () => {
  test('uses the machine’s voice when it is ready, and the device’s own when it is not', () => {
    const ready = rig('ready');
    expect(ready.speaker.say('Hello.')).toBe('machine');
    expect(ready.machine).toEqual(['Hello.']);
    expect(ready.device).toEqual([]);
    for (const state of ['loading', 'absent', undefined] as const) {
      const other = rig(state);
      expect(other.speaker.say('Hello.')).toBe('device');
      expect(other.device).toEqual([{ segments: ['Hello.'], rate: 1, language: 'en-US' }]);
      expect(other.sources).toEqual(['device']);
    }
    expect(rig('ready', { stream: false }).speaker.say('Hi.')).toBe('device');
    expect(rig('ready', { sends: false }).speaker.say('Hi.')).toBe('device');
  });

  test('a line the machine could not begin is read by the device, in full', () => {
    const r = rig('ready');
    r.speaker.say('Let me check.');
    r.speaker.onSpeech({ id: 0, event: 'failed', code: 'reply_voice_failed' });
    expect(r.device.map(request => request.segments)).toEqual([['Let me check.']]);
    expect(r.sources).toEqual(['machine', 'device']);
  });

  test('a line the machine began and then failed is not read again, and a finished one is forgotten', () => {
    const r = rig('ready');
    r.speaker.say('First.');
    r.speaker.onSpeech({ id: 0, event: 'started', firstSoundMs: 100 });
    r.speaker.onSpeech({ id: 0, event: 'failed', code: 'reply_voice_failed' });
    expect(r.device).toEqual([]);
    r.speaker.say('Second.');
    r.speaker.onSpeech({ id: 1, event: 'started' });
    r.speaker.onSpeech({ id: 1, event: 'finished' });
    r.speaker.onSpeech({ id: 1, event: 'failed' });
    expect(r.device).toEqual([]);
    // An event for a line nobody asked for is ignored.
    r.speaker.onSpeech({ id: 99, event: 'failed' });
    expect(r.device).toEqual([]);
  });

  test('works without a language', () => {
    const device: SpeakRequest[] = [];
    const speaker = createReplySpeaker({
      stream: () => undefined,
      replyState: () => undefined,
      device: {
        supported: true,
        voices: () => [],
        unlock: () => undefined,
        speak: request => void device.push(request),
        stop: () => undefined,
      },
    });
    speaker.say('Hi.');
    expect(device).toEqual([{ segments: ['Hi.'], rate: 1 }]);
  });
});
