/**
 * ONE STOP FOR THE MACHINE'S VOICE. The reading of a whole reply (`machine-speaker.ts`) and the live lines (`live-lines.ts`) say
 * through the SAME stream, so one plain hush silences both. Each owner still stops and settles ITSELF (the reading is told it
 * stopped, each line is told it was hushed), but the hush frame is sent once: a plain hush is passed on only if something was
 * spoken since the last hush or stop (nothing else can be sounding), so two owners stopping together make one hush on the wire.
 * A person's stop is never held back: it carries where their ears were.
 */
import type { VoiceStreamHandle } from '../stream/voice-stream.ts';

type SharedHandle = Pick<VoiceStreamHandle, 'speak' | 'drop' | 'hush' | 'interrupt'>;

/** The stream both owners are given; `undefined` while there is none. */
export function shareStream(stream: () => SharedHandle | undefined): () => SharedHandle | undefined {
  let of: SharedHandle | undefined;
  let view: SharedHandle | undefined;
  /** Something was spoken since the last stop of any kind. */
  let sounding = false;
  return () => {
    const real = stream();
    if (real === undefined) return undefined;
    if (real !== of) {
      of = real;
      sounding = false;
      view = {
        speak: text => {
          const lines = real.speak(text);
          if (lines.length > 0) sounding = true;
          return lines;
        },
        drop: ids => real.drop(ids),
        hush: () => {
          if (!sounding) return;
          sounding = false;
          real.hush();
        },
        interrupt: () => {
          sounding = false;
          real.interrupt();
        },
      };
    }
    return view;
  };
}
