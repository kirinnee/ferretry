import type { ReplyState } from '../../../contract/index.ts';
import type { SpeakerPort } from '../voice-chat/ports.ts';
import type { SpeechLineEvent, VoiceStreamHandle } from './voice-stream.ts';

export type ReplyVoiceSource = 'machine' | 'device';

export interface ReplySpeakerDeps {
  /** The open stream, once there is one. */
  readonly stream: () => Pick<VoiceStreamHandle, 'speak'> | undefined;
  /** Where the machine's reply voice is; `undefined` before the stream said. */
  readonly replyState: () => ReplyState | undefined;
  /** The device's own voice: the fallback, and the whole answer where the machine has no reply voice. */
  readonly device: SpeakerPort;
  /** Told which voice a line goes to, so the panel can say so out loud. */
  readonly onSource?: (source: ReplyVoiceSource) => void;
  readonly language?: string;
}

/**
 * Says a reply's spoken line in the best voice there is: the machine's Kokoro when it is installed and answering, the
 * device's own voice when it is not. Nothing is spoken twice: a line the machine began and then failed is not read again by
 * the device (a person would hear its start twice), and a line it could not begin at all is read by the device in full.
 */
export function createReplySpeaker(deps: ReplySpeakerDeps) {
  const lines = new Map<number, { text: string; heard: boolean }>();
  const onDevice = (text: string): void => {
    deps.onSource?.('device');
    deps.device.speak(
      { segments: [text], rate: 1, ...(deps.language === undefined ? {} : { language: deps.language }) },
      () => undefined,
    );
  };
  return {
    /** Speaks one spoken line. Returns which voice took it. */
    say(text: string): ReplyVoiceSource {
      const stream = deps.stream();
      if (stream !== undefined && deps.replyState() === 'ready') {
        const sent = stream.speak(text);
        if (sent.length > 0) {
          for (const line of sent) lines.set(line.id, { text: line.text, heard: false });
          deps.onSource?.('machine');
          return 'machine';
        }
      }
      onDevice(text);
      return 'device';
    },
    /** Feed every `onSpeech` event of the stream here. */
    onSpeech(event: SpeechLineEvent): void {
      const line = lines.get(event.id);
      if (line === undefined) return;
      if (event.event === 'started') line.heard = true;
      if (event.event === 'failed' && !line.heard) onDevice(line.text);
      if (event.event !== 'started') lines.delete(event.id);
    },
  };
}
