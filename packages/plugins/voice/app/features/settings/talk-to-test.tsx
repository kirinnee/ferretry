/**
 * Settings › Voice › Voice mode › Talk to test: speak, and see the words the MACHINE hears, live. It sends nothing to any
 * ferret (the stream is opened for `purpose: 'test'`), so it is also the person's proof that the whole path works before
 * they trust it with a message: the microphone, the encrypted stream, the machine's speech engine, and the pause.
 */
import { Mic, Square } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { StreamSnapshot, StreamState } from '../../../contract/index.ts';
import { browserMic } from '../../lib/stream/mic-source.ts';
import { type MicSource, openVoiceStream, type VoiceStreamHandle } from '../../lib/stream/voice-stream.ts';
import { SettingRow, useOptionalVoiceClient, type VoicePluginClient } from '../../shell-voice.ts';

/** What each machine state says to the person. */
const STATE_SENTENCE: Record<StreamState, (machine: string) => string> = {
  loading: machine => `Loading speech on ${machine}…`,
  listening: () => 'Listening. Say something, then pause.',
  hearing: () => 'Hearing you…',
  working: machine => `${machine} is turning that into words…`,
  muted: () => 'Muted.',
};

const OUTCOME_SENTENCE: Record<string, string> = {
  heard: 'That is what the machine heard. Nothing was sent.',
  dropped: 'The machine heard no words that time.',
  failed: 'The machine could not turn that into words. Try again.',
  cancelled: 'The machine did not hear back from this device, so it stopped.',
};

interface Heard {
  readonly text: string;
  readonly final: boolean;
}

export interface TalkToTestProps {
  readonly machine: string;
  /** A suite supplies a client with a fake socket; the page uses the shell's. */
  readonly client?: Pick<VoicePluginClient, 'socket'>;
  readonly createMic?: () => MicSource;
}

export function TalkToTest({ machine, client: injected, createMic = browserMic }: TalkToTestProps) {
  const routed = useOptionalVoiceClient();
  const client: Pick<VoicePluginClient, 'socket'> | null = injected ?? routed;
  const [running, setRunning] = useState(false);
  const [state, setState] = useState<StreamState | null>(null);
  const [heard, setHeard] = useState<Heard | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const handle = useRef<VoiceStreamHandle | null>(null);

  const stop = useCallback(() => {
    handle.current?.stop();
    handle.current = null;
    setRunning(false);
    setState(null);
  }, []);

  useEffect(() => () => handle.current?.stop(), []);

  const start = useCallback(() => {
    if (client?.socket === undefined) {
      setProblem('This browser cannot open a voice stream to the machine.');
      return;
    }
    setProblem(null);
    setHeard(null);
    setOutcome(null);
    setRunning(true);
    let turn = 0;
    handle.current = openVoiceStream(client, { t: 'start', v: 1, purpose: 'test' }, createMic(), {
      onSnapshot: (snapshot: StreamSnapshot) => {
        setState(snapshot.state);
        if (snapshot.turn !== turn) {
          turn = snapshot.turn;
          setHeard(null);
          setOutcome(null);
        }
        if (snapshot.last !== undefined) setOutcome(OUTCOME_SENTENCE[snapshot.last.outcome] ?? null);
      },
      onWords: words => setHeard({ text: words.text, final: words.final }),
      onEnded: ended => {
        handle.current = null;
        setRunning(false);
        setState(null);
        if (ended.sentence !== undefined) setProblem(ended.sentence);
        else if (ended.code !== 1000 && ended.code !== undefined) setProblem(refusalSentence(ended.code, machine));
      },
      onMicFailed: () => setProblem('The microphone could not be opened. Allow it for this site and try again.'),
    });
  }, [client, createMic, machine]);

  return (
    <SettingRow
      name="Talk to test"
      hint={running && state !== null ? STATE_SENTENCE[state](machine) : 'Speech check'}
      wide
      dataAttributes={{ 'data-voice-talk-to-test': running ? 'on' : 'off' }}
      explanation={
        <p className="m-0">
          Your voice goes to {machine} only, encrypted end to end, and is never stored. Nothing is sent to a ferret.
        </p>
      }
    >
      <div className="fy-vs-body">
        <div className="fy-vs-field">
          {running ? (
            <button type="button" className="kt-btn" onClick={stop} data-voice-talk-stop="">
              <Square size={14} aria-hidden="true" /> Stop
            </button>
          ) : (
            <button type="button" className="kt-btn" data-variant="primary" onClick={start} data-voice-talk-start="">
              <Mic size={14} aria-hidden="true" /> Talk to test
            </button>
          )}
        </div>
        <p
          className="fy-vs-note text-fg"
          aria-live="polite"
          data-voice-heard={heard === null ? 'none' : heard.final ? 'final' : 'interim'}
          style={heard === null ? undefined : heard.final ? { fontWeight: 600 } : { fontStyle: 'italic', opacity: 0.6 }}
        >
          {heard?.text ?? ''}
        </p>
        {outcome !== null && (
          <p className="fy-vs-note" role="status" data-voice-outcome="">
            {outcome}
          </p>
        )}
        {problem !== null && (
          <p role="alert" className="fy-vs-note" data-tone="warn" data-voice-problem="">
            {problem}
          </p>
        )}
      </div>
    </SettingRow>
  );
}

/** A close the machine gave without a sentence of its own (the upgrade was refused, or the stream dropped). */
function refusalSentence(code: number, machine: string): string {
  if (code === 4408) return `${machine} stopped hearing this device.`;
  if (code === 4429) return `${machine} is already serving voice chats.`;
  if (code === 4450) return `${machine} could not keep up.`;
  if (code === 4401) return 'This device may no longer use voice on this machine.';
  return `Could not talk to ${machine} (closed ${code}).`;
}
