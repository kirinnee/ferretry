/**
 * Settings › Voice › Voice mode › Reply voice: Kokoro on the machine, the voice a ferret's spoken lines are read in. It is
 * installed on its own (about 164 MB; it needs the speech engine only to be HEARD in a chat), and without it a reply is
 * read by this device's own voice. "Hear it" speaks one sentence through the real path (stream, machine, sound) and says
 * how long the first sound took, so what the person hears and what it cost are the same test.
 */
import { AlertTriangle, Check, Download, Trash2, Volume2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReplyVoiceView } from '../../../contract/index.ts';
import type { ReplyState } from '../../../contract/index.ts';
import { silentMic } from '../../lib/stream/mic-source.ts';
import { createReplyPlayer } from '../../lib/stream/reply-player.ts';
import { createReplySpeaker, type ReplyVoiceSource } from '../../lib/stream/reply-speaker.ts';
import type { SpeakerPort } from '../../lib/voice-chat/ports.ts';
import { browserSpeaker } from '../../lib/voice-chat/speech-synthesis.ts';
import {
  type MicSource,
  openVoiceStream,
  type ReplyPlayer,
  type VoiceStreamHandle,
} from '../../lib/stream/voice-stream.ts';
import { SettingRow, useOptionalVoiceClient, type VoicePluginClient } from '../../shell-voice.ts';
import { installReplyVoice, readReplyVoice, removeReplyVoice, type VoiceEngineClient } from './voice-engine-api.ts';

const POLL_MS = 1_000;
const megabytes = (bytes: number): string => `${Math.round(bytes / 1_000_000).toLocaleString('en-US')} MB`;
const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
const reason = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** The sentence "Hear it" speaks: short, plain, and the kind of line a ferret says first. */
const SAMPLE_LINE = 'Let me check the failing test.';

export interface ReplyVoiceState {
  readonly view: ReplyVoiceView | null;
  readonly busy: boolean;
  readonly error: string | null;
  readonly install: () => void;
  readonly remove: () => void;
}

/** Reads the machine's reply voice, and again every second for as long as it is installing. */
export function useReplyVoice(client: VoiceEngineClient | null): ReplyVoiceState {
  const [view, setView] = useState<ReplyVoiceView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (client === null) return undefined;
    let current = true;
    void readReplyVoice(client)
      .then(read => current && setView(read))
      .catch(cause => current && setError(`This browser could not read the reply voice: ${reason(cause)}`));
    return () => {
      current = false;
    };
  }, [client]);

  const installing = view?.state === 'installing';
  useEffect(() => {
    if (!installing || client === null) return undefined;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = (): void => {
      timer = setTimeout(() => {
        void readReplyVoice(client)
          .then(read => {
            if (!current) return;
            setView(read);
            if (read.state === 'installing') poll();
          })
          .catch(cause => current && setError(reason(cause)));
      }, POLL_MS);
    };
    poll();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [installing, client]);

  const act = useCallback(
    async (work: (active: VoiceEngineClient) => Promise<ReplyVoiceView>) => {
      if (client === null) return;
      setBusy(true);
      setError(null);
      try {
        setView(await work(client));
      } catch (cause) {
        setError(reason(cause));
      } finally {
        setBusy(false);
      }
    },
    [client],
  );

  return {
    view,
    busy,
    error,
    install: () => void act(installReplyVoice),
    remove: () => void act(removeReplyVoice),
  };
}

export interface HearItProps {
  readonly machine: string;
  /** A suite supplies a client with a fake socket; the page uses the shell's. */
  readonly client?: Pick<VoicePluginClient, 'socket'>;
  /** A suite's own sound and clock; the page uses the browser's. */
  readonly createPlayer?: () => ReplyPlayer;
  readonly createMic?: () => MicSource;
  /** This device's own voice, the fallback; the page uses the browser's. */
  readonly device?: SpeakerPort;
}

type Hearing =
  | { readonly step: 'idle' }
  | { readonly step: 'waiting' }
  | { readonly step: 'speaking'; readonly firstSoundMs: number | null }
  | { readonly step: 'done'; readonly voice: ReplyVoiceSource; readonly firstSoundMs: number | null }
  | { readonly step: 'problem'; readonly sentence: string };

/**
 * Speaks one sentence the way a reply is spoken: in the machine's reply voice through the same stream a chat uses, or in
 * this device's own voice when the machine has none ready (and says which it was). It is the reply speaker's first real user.
 */
function HearIt({
  machine,
  client: injected,
  createPlayer = createReplyPlayer,
  createMic = silentMic,
  device,
}: HearItProps) {
  const routed = useOptionalVoiceClient();
  const client: Pick<VoicePluginClient, 'socket'> | null = injected ?? routed;
  const [hearing, setHearing] = useState<Hearing>({ step: 'idle' });
  const handle = useRef<VoiceStreamHandle | null>(null);
  const player = useRef<ReplyPlayer | null>(null);
  const drain = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = useCallback(() => {
    if (drain.current !== null) clearInterval(drain.current);
    drain.current = null;
    handle.current?.stop();
    handle.current = null;
    player.current?.close();
    player.current = null;
  }, []);
  useEffect(() => stop, [stop]);

  const start = useCallback(() => {
    if (client?.socket === undefined) {
      setHearing({ step: 'problem', sentence: 'This browser cannot open a voice stream to the machine.' });
      return;
    }
    stop();
    setHearing({ step: 'waiting' });
    // Created here, inside the tap: a browser lets sound start only from one.
    player.current = createPlayer();
    const own = device ?? browserSpeaker();
    own.unlock();
    let firstSoundMs: number | null = null;
    let reply: ReplyState | undefined;
    let began = false;
    const speaker = createReplySpeaker({
      stream: () => handle.current ?? undefined,
      replyState: () => reply,
      device: own,
    });
    /** The device's voice took the line: the stream has nothing more to do. */
    const handOver = (): void => {
      stop();
      setHearing({ step: 'done', voice: 'device', firstSoundMs: null });
    };
    handle.current = openVoiceStream(
      client,
      { t: 'start', v: 1, purpose: 'test', reply: 'machine' },
      createMic(),
      {
        onSnapshot: () => undefined,
        onWords: () => undefined,
        onMicFailed: () => undefined,
        onReply: state => {
          reply = state;
          if (state === 'loading') return;
          if (speaker.say(SAMPLE_LINE) === 'device') handOver();
        },
        onSpeech: line => {
          if (line.event === 'started') {
            began = true;
            firstSoundMs = line.firstSoundMs ?? null;
            setHearing({ step: 'speaking', firstSoundMs });
          }
          // The speaker reads a line the machine could not begin; one it began and lost is not read twice.
          speaker.onSpeech(line);
          if (line.event === 'failed') {
            if (began) {
              stop();
              setHearing({ step: 'done', voice: 'machine', firstSoundMs });
            } else handOver();
          }
          if (line.event === 'finished') {
            // All the sound is here; the stream ends when it has been heard.
            drain.current = setInterval(() => {
              if ((player.current?.remainingMs() ?? 0) > 0) return;
              stop();
              setHearing({ step: 'done', voice: 'machine', firstSoundMs });
            }, 200);
          }
        },
        onEnded: ended => {
          handle.current = null;
          if (ended.sentence !== undefined) setHearing({ step: 'problem', sentence: ended.sentence });
        },
      },
      { player: player.current },
    );
  }, [client, createMic, createPlayer, device, stop]);

  const running = hearing.step === 'waiting' || hearing.step === 'speaking';
  return (
    <div className="fy-vs-field">
      <button
        type="button"
        className="kt-btn"
        disabled={running || client === null}
        onClick={start}
        data-voice-hear-it=""
      >
        <Volume2 size={14} aria-hidden="true" /> {running ? 'Speaking…' : 'Hear it'}
      </button>
      {hearing.step === 'waiting' && (
        <p className="fy-vs-note" role="status">
          Asking {machine} to speak a sentence…
        </p>
      )}
      {(hearing.step === 'speaking' || (hearing.step === 'done' && hearing.voice === 'machine')) &&
        hearing.firstSoundMs !== null && (
          <p className="fy-vs-note" role="status" data-voice-first-sound={hearing.firstSoundMs}>
            {hearing.step === 'done' ? 'Spoken by ' + machine + '. ' : ''}The first sound came{' '}
            {seconds(hearing.firstSoundMs)} after the line was sent.
          </p>
        )}
      {hearing.step === 'done' && hearing.voice === 'device' && (
        <p className="fy-vs-note" role="status" data-voice-by-device="">
          {machine} has no reply voice ready, so this device&apos;s own voice read it. That is what a reply sounds like
          now.
        </p>
      )}
      {hearing.step === 'problem' && (
        <p role="alert" className="fy-vs-note" data-tone="warn">
          {hearing.sentence}
        </p>
      )}
    </div>
  );
}

export interface ReplyVoiceRowProps {
  readonly state: ReplyVoiceState;
  /** Whether speech to text is installed too: only then can a stream open to speak the sample. */
  readonly speechReady: boolean;
  readonly hear?: Omit<HearItProps, 'machine'> | undefined;
}

export function ReplyVoiceRow({ state, speechReady, hear }: ReplyVoiceRowProps) {
  const { view, busy, error } = state;
  if (view === null) return null;
  const percent = view.sizeBytes === 0 ? 0 : Math.min(100, Math.round((view.doneBytes / view.sizeBytes) * 100));
  return (
    <SettingRow
      name="Reply voice"
      hint={
        view.state === 'ready' ? (
          <span
            className="inline-flex items-center gap-1 rounded-control bg-accent-soft px-2 py-0.5 text-meta font-medium text-ok"
            data-voice-reply-state="ready"
          >
            <Check size={12} aria-hidden="true" /> Ready
          </span>
        ) : (
          <span
            className="rounded-control bg-surface-2 px-2 py-0.5 text-meta font-medium text-faint"
            data-voice-reply-state={view.state}
          >
            {view.state === 'installing' ? 'Installing' : view.state === 'failed' ? 'Needs attention' : 'Not installed'}
          </span>
        )
      }
      wide
      dataAttributes={{ 'data-voice-reply': view.state }}
      explanation={
        <div className="flex min-w-0 flex-col gap-1">
          <p className="m-0">
            The voice a ferret&apos;s spoken lines are read in during voice mode. It runs on {view.machine}; the text it
            reads is sent there over the same encrypted stream as your voice, and nothing is stored.
          </p>
          <p className="m-0">
            Without it, this device&apos;s own voice reads the replies. Installing downloads {megabytes(view.sizeBytes)}{' '}
            once; it uses about 0.5 GB of memory only while it is speaking.
          </p>
        </div>
      }
    >
      <div className="fy-vs-body">
        <p className="fy-vs-note text-fg">{view.label}</p>
        {view.state === 'installing' && (
          <>
            <div
              role="progressbar"
              aria-label={`Downloading the reply voice to ${view.machine}`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              className="h-2 w-full max-w-[36rem] overflow-hidden rounded-control border border-border bg-surface-2"
              data-voice-reply-progress=""
            >
              <div className="h-full bg-accent" style={{ width: `${percent}%` }} />
            </div>
            <p className="fy-vs-note" role="status">
              Downloading to {view.machine}: {megabytes(view.doneBytes)} of {megabytes(view.sizeBytes)}.
            </p>
          </>
        )}
        {view.state === 'ready' && (
          <p className="fy-vs-note" data-tone="ok" role="status" data-voice-reply-ready="">
            {view.selfTest === undefined
              ? `Installed on ${view.machine}.`
              : `Installed on ${view.machine}. On its last test it spoke ${seconds(view.selfTest.audioMs)} of speech in ${seconds(view.selfTest.speakMs)} (${view.selfTest.realTimeFactor.toFixed(1)}× the time it lasts).`}
          </p>
        )}
        {view.state === 'failed' && view.failure !== undefined && (
          <p role="alert" className="fy-vs-note" data-tone="warn" data-voice-reply-failure={view.failure.code}>
            <AlertTriangle size={14} aria-hidden="true" className="mr-1 inline align-text-bottom" />
            {view.failure.sentence}
          </p>
        )}
        <div className="fy-vs-field">
          {(view.state === 'not_installed' || view.state === 'failed') && (
            <button type="button" className="kt-btn" data-variant="primary" disabled={busy} onClick={state.install}>
              <Download size={14} aria-hidden="true" />{' '}
              {view.state === 'failed' ? 'Try again' : `Install on ${view.machine} (${megabytes(view.sizeBytes)})`}
            </button>
          )}
          {(view.state === 'ready' || (view.state === 'failed' && view.doneBytes > 0)) && (
            <button type="button" className="kt-btn" disabled={busy} onClick={state.remove}>
              <Trash2 size={14} aria-hidden="true" /> Remove from {view.machine}
            </button>
          )}
        </div>
        {view.state === 'ready' &&
          (speechReady ? (
            <HearIt machine={view.machine} {...hear} />
          ) : (
            <p className="fy-vs-note">Install speech on {view.machine} above to hear it.</p>
          ))}
        {error !== null && (
          <p role="alert" className="fy-vs-note" data-tone="warn">
            {error}
          </p>
        )}
      </div>
    </SettingRow>
  );
}
