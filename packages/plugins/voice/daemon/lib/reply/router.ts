import type { ReplyProvider, ReplySpeakerApi } from '../../../contract/index.ts';

/**
 * The one reply voice a voice stream asks, chosen per use by `voice.yaml` (`replyVoice.provider`): Kokoro on this machine
 * (the default) or ElevenLabs. The choice is read at each call, so changing it in Settings is heard from the next line and
 * no stream has to be reopened. A stream sees one voice and never which it is: both answer `ready` or `absent`, and an
 * `absent` voice is what makes the device's own voice read.
 */
export function routeReplyVoice(parts: {
  readonly provider: () => ReplyProvider;
  readonly kokoro: ReplySpeakerApi;
  readonly elevenlabs: ReplySpeakerApi;
}): ReplySpeakerApi {
  const chosen = (): ReplySpeakerApi => (parts.provider() === 'elevenlabs' ? parts.elevenlabs : parts.kokoro);
  return {
    view: async () => await chosen().view(),
    warm: async () => await chosen().warm(),
    speak: async text => await chosen().speak(text),
  };
}
