/**
 * The browser's end of the voice stream (`GET /v1/voice/stream`, unit 4): the microphone goes up in constant 40 ms
 * units, and the machine's snapshots come down every 200 ms. Everything the person sees (live words, what the machine is
 * doing, how the last turn ended) is read from those snapshots; nothing is guessed here.
 *
 * Audio leaves the page only through the shell's own socket (`PluginClient.socket`), so it is sealed end to end on
 * every carrier. It is never stored.
 */
import {
  DOWNLINK_UNIT_BYTES,
  STREAM_CLOSES,
  StreamProtocolError,
  type StreamControl,
  type StreamSnapshot,
  type StreamStart,
  UNIT_SAMPLES,
  UnitAssembler,
  WordsAssembler,
  decodeDownlinkUnit,
  encodeUplinkUnit,
} from '../../../contract/index.ts';
import type { PluginClient } from '@ferretry/kernel/manifest';

export const VOICE_STREAM_ROUTE = 'GET /v1/voice/stream';

/** The microphone as 640-sample units, one every 40 ms for as long as it is open. */
export interface MicSource {
  /** Opens the microphone; each call of `onUnit` is exactly one 40 ms unit of 16 kHz PCM. Rejects if it is refused. */
  start(onUnit: (pcm: Int16Array) => void): Promise<void>;
  stop(): void;
}

export interface VoiceStreamEvents {
  /** Every snapshot, as it arrives. */
  readonly onSnapshot: (snapshot: StreamSnapshot) => void;
  /** A whole revision of the turn's words, once its last fragment is in. */
  readonly onWords: (words: { readonly turn: number; readonly text: string; readonly final: boolean }) => void;
  /** The stream is over. `refusal` is the machine's own sentence when it said why; `code` the close code. */
  readonly onEnded: (ended: {
    readonly code: number | undefined;
    readonly reason: string;
    readonly sentence?: string;
  }) => void;
  /** The microphone could not be opened (permission, no device). */
  readonly onMicFailed: (cause: unknown) => void;
}

export interface VoiceStreamHandle {
  /** Leaves on purpose: tells the machine, then closes. */
  stop(): void;
  setMuted(muted: boolean): void;
}

type SocketClient = Pick<PluginClient, 'socket'>;

/**
 * Opens the stream and starts the microphone once the machine has accepted it (a unit sent earlier would be dropped).
 * A downlink unit that does not parse ends the stream with a protocol error, as the machine does for the uplink.
 */
export function openVoiceStream(
  client: SocketClient,
  start: StreamStart,
  mic: MicSource,
  events: VoiceStreamEvents,
): VoiceStreamHandle {
  if (client.socket === undefined) throw new Error('this browser has no way to open a voice stream');
  const assembler = new UnitAssembler(DOWNLINK_UNIT_BYTES);
  const words = new WordsAssembler();
  let echo: string | undefined;
  let control: StreamControl = 'none';
  let ended = false;
  let sentence: string | undefined;

  const finish = (code: number | undefined, reason: string): void => {
    if (ended) return;
    ended = true;
    mic.stop();
    events.onEnded({ code, reason, ...(sentence === undefined ? {} : { sentence }) });
  };

  const socket = client.socket(
    VOICE_STREAM_ROUTE,
    {},
    {
      onOpen: () => {
        socket.send(JSON.stringify(start));
        mic
          .start(pcm => {
            if (ended || pcm.length !== UNIT_SAMPLES) return;
            socket.send(encodeUplinkUnit({ pcm, control, echo }));
            // A control rides ONE unit; the next is plain audio again.
            if (control === 'unmuted' || control === 'muted') control = 'none';
          })
          .catch((cause: unknown) => {
            events.onMicFailed(cause);
            handle.stop();
          });
      },
      onFrame: frame => {
        if (typeof frame === 'string' || ended) return;
        try {
          for (const unit of assembler.push(frame)) {
            const snapshot = decodeDownlinkUnit(unit);
            echo = snapshot.nonce;
            if (snapshot.error !== undefined) sentence = snapshot.error.message;
            events.onSnapshot(snapshot);
            if (snapshot.words !== undefined) {
              const whole = words.accept(snapshot.words);
              if (whole !== undefined) events.onWords({ turn: whole.turn, text: whole.text, final: whole.final });
            }
          }
        } catch (error) {
          if (!(error instanceof StreamProtocolError)) throw error;
          socket.close(STREAM_CLOSES.protocol.code, STREAM_CLOSES.protocol.reason);
          finish(STREAM_CLOSES.protocol.code, STREAM_CLOSES.protocol.reason);
        }
      },
      onClose: (reason, code) => finish(code, reason),
    },
  );

  const handle: VoiceStreamHandle = {
    stop: () => {
      if (ended) return;
      // The machine hears "end" in a unit of its own, then the close: it stops listening at once and frees its place.
      try {
        socket.send(encodeUplinkUnit({ pcm: new Int16Array(UNIT_SAMPLES), control: 'end', echo }));
      } catch {
        // The socket was already gone: closing is all that is left.
      }
      socket.close(STREAM_CLOSES.ended.code, STREAM_CLOSES.ended.reason);
      finish(STREAM_CLOSES.ended.code, STREAM_CLOSES.ended.reason);
    },
    setMuted: muted => {
      control = muted ? 'muted' : 'unmuted';
    },
  };
  return handle;
}
