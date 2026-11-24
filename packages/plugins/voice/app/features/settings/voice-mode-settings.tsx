/**
 * Settings › Voice › Voice mode: the machine's own speech engine (speech to text and voice detection), installed on the
 * machine rather than in this browser, so a hands-free chat is transcribed there. One row with four states:
 *
 *   not installed → "Install on <machine> (699 MB)"      installing → a progress bar the machine reports
 *   ready         → what it measured, and Remove         failed     → the machine's own sentence, and Try again
 *
 * It names what leaves the browser (nothing now: Install only asks the machine to download public files) and what it
 * costs the machine (disk while installed, memory only while in use), because the person decides that.
 */
import { AlertTriangle, Check, Download, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { VoiceEngineView } from '../../../contract/index.ts';
import { useDeviceVoiceSettingsStore, useLiveVoiceSettings } from '../../hooks/use-live-voice-settings.ts';
import { type DaemonConnection, SettingGroup, SettingRow, SettingSwitch } from '../../shell-voice.ts';
import { useDaemonClient } from '../../lib/voice-store.tsx';
import { type HearItProps, ReplyVoiceRow, type ReplyVoiceState, useReplyVoice } from './reply-voice.tsx';
import { TalkToTest, type TalkToTestProps } from './talk-to-test.tsx';
import { installVoiceEngine, readVoiceEngine, removeVoiceEngine, type VoiceEngineClient } from './voice-engine-api.ts';
import './voice-settings.css';

const POLL_MS = 1_000;

/** Megabytes as people count them (1,000,000 bytes), the way the download size is quoted. */
const megabytes = (bytes: number): string => `${Math.round(bytes / 1_000_000).toLocaleString('en-US')} MB`;

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

function StateChip({ view }: { readonly view: VoiceEngineView }) {
  if (view.state === 'ready')
    return (
      <span
        className="inline-flex items-center gap-1 rounded-control bg-accent-soft px-2 py-0.5 text-meta font-medium text-ok"
        data-voice-engine-state="ready"
      >
        <Check size={12} aria-hidden="true" /> Ready
      </span>
    );
  if (view.state === 'failed')
    return (
      <span
        className="rounded-control bg-warn-bg px-2 py-0.5 text-meta font-medium text-warn"
        data-voice-engine-state="failed"
      >
        Needs attention
      </span>
    );
  return (
    <span
      className="rounded-control bg-surface-2 px-2 py-0.5 text-meta font-medium text-faint"
      data-voice-engine-state={view.state}
    >
      {view.state === 'installing' ? 'Installing' : 'Not installed'}
    </span>
  );
}

interface VoiceModePanelProps {
  readonly view: VoiceEngineView;
  readonly talk?: Pick<TalkToTestProps, 'client' | 'createMic'> | undefined;
  readonly hear?: Omit<HearItProps, 'machine'> | undefined;
  readonly busy: boolean;
  readonly error: string | null;
  readonly onInstall: () => void;
  readonly onRemove: () => void;
  readonly reply: ReplyVoiceState;
}

/**
 * "Keep voice mode's audio on this phone": this device's choice, so it lives in this browser and nowhere else. On, voice
 * mode runs on this device's own speech engine and voice and never asks the machine (the machine is the default, and the
 * phone is otherwise only the fallback when it cannot be reached).
 */
function KeepOnPhoneRow() {
  const { settings, update } = useLiveVoiceSettings(useDeviceVoiceSettingsStore());
  return (
    <SettingRow
      settingId="voice-mode-on-phone"
      name="Keep audio on this phone"
      hint="Voice mode uses this phone's own speech"
      explanation="Off, voice mode listens and speaks on your machine, which is faster and uses bigger models. On, your voice never leaves this phone: it is turned into words by the engine you chose for dictation (Settings › Voice), and replies are read by this phone's voice. Either way the words you say are sent to the ferret as messages."
      control={labelId => (
        <SettingSwitch
          checked={settings.voiceModeOnPhone}
          labelledBy={labelId}
          onChange={voiceModeOnPhone => update({ voiceModeOnPhone })}
        />
      )}
    />
  );
}

function VoiceModePanel({ view, talk, hear, reply, busy, error, onInstall, onRemove }: VoiceModePanelProps) {
  const percent = view.sizeBytes === 0 ? 0 : Math.min(100, Math.round((view.doneBytes / view.sizeBytes) * 100));
  return (
    <SettingGroup label="Voice mode">
      <SettingRow
        name="Speech on this machine"
        hint={<StateChip view={view} />}
        wide
        dataAttributes={{ 'data-voice-engine': view.state }}
        explanation={
          <div className="flex min-w-0 flex-col gap-1">
            <p className="m-0">
              Voice mode listens and replies hands-free. Your voice goes only to {view.machine}, encrypted end to end,
              and is turned into words there.
            </p>
            <p className="m-0">
              Installing downloads {megabytes(view.sizeBytes)} once, and uses about 1.8 GB of memory only while you are
              talking: it lets go of it after 10 idle minutes.
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
                aria-label={`Downloading speech to ${view.machine}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                className="h-2 w-full max-w-[36rem] overflow-hidden rounded-control border border-border bg-surface-2"
                data-voice-engine-progress=""
              >
                <div className="h-full bg-accent" style={{ width: `${percent}%` }} />
              </div>
              <p className="fy-vs-note" role="status">
                Downloading to {view.machine}: {megabytes(view.doneBytes)} of {megabytes(view.sizeBytes)}.
              </p>
            </>
          )}
          {view.state === 'ready' && (
            <p className="fy-vs-note" data-tone="ok" role="status" data-voice-engine-ready="">
              {view.selfTest === undefined
                ? `Installed on ${view.machine}.`
                : `Installed on ${view.machine}. It loaded in ${seconds(view.selfTest.loadMs)} on its last start.`}
            </p>
          )}
          {view.state === 'failed' && view.failure !== undefined && (
            <p role="alert" className="fy-vs-note" data-tone="warn" data-voice-engine-failure={view.failure.code}>
              <AlertTriangle size={14} aria-hidden="true" className="mr-1 inline align-text-bottom" />
              {view.failure.sentence}
            </p>
          )}
          <div className="fy-vs-field">
            {(view.state === 'not_installed' || view.state === 'failed') && (
              <button type="button" className="kt-btn" data-variant="primary" disabled={busy} onClick={onInstall}>
                <Download size={14} aria-hidden="true" />{' '}
                {view.state === 'failed' ? 'Try again' : `Install on ${view.machine} (${megabytes(view.sizeBytes)})`}
              </button>
            )}
            {(view.state === 'ready' || (view.state === 'failed' && view.doneBytes > 0)) && (
              <button type="button" className="kt-btn" disabled={busy} onClick={onRemove}>
                <Trash2 size={14} aria-hidden="true" /> Remove from {view.machine}
              </button>
            )}
          </div>
          {error !== null && (
            <p role="alert" className="fy-vs-note" data-tone="warn">
              {error}
            </p>
          )}
        </div>
      </SettingRow>
      {view.state === 'ready' && <TalkToTest machine={view.machine} {...talk} />}
      <ReplyVoiceRow state={reply} speechReady={view.state === 'ready'} hear={hear} />
      <KeepOnPhoneRow />
    </SettingGroup>
  );
}

const reason = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

export type VoiceEngineClientFactory = (connection: DaemonConnection) => Promise<VoiceEngineClient>;

/** The connected panel: reads the machine's state, and again every second for as long as it is installing. */
export function VoiceModeSettings({
  connection,
  createClient: injected,
  talk,
  hear,
}: {
  readonly connection: DaemonConnection;
  readonly createClient?: VoiceEngineClientFactory | undefined;
  /** A suite's own socket and microphone for Talk to test; the page uses the shell's client and the real microphone. */
  readonly talk?: Pick<TalkToTestProps, 'client' | 'createMic'> | undefined;
  /** A suite's own sound and socket for the reply voice's "Hear it". */
  readonly hear?: Omit<HearItProps, 'machine'> | undefined;
}) {
  const routed = useDaemonClient();
  const createClient = injected ?? routed;
  const [client, setClient] = useState<VoiceEngineClient | null>(null);
  const [view, setView] = useState<VoiceEngineView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reply = useReplyVoice(client);

  useEffect(() => {
    let current = true;
    setClient(null);
    setView(null);
    void createClient(connection)
      .then(async next => {
        const read = await readVoiceEngine(next);
        if (!current) return;
        setClient(next);
        setView(read);
      })
      .catch(cause => {
        if (current) setError(`This browser could not read the speech engine: ${reason(cause)}`);
      });
    return () => {
      current = false;
    };
  }, [connection, createClient]);

  const installing = view?.state === 'installing';
  useEffect(() => {
    if (!installing || client === null) return undefined;
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // One read a second until the machine stops saying "installing" (the effect ends then, with the state it set).
    const poll = (): void => {
      timer = setTimeout(() => {
        void readVoiceEngine(client)
          .then(read => {
            if (!current) return;
            setView(read);
            if (read.state === 'installing') poll();
          })
          .catch(cause => {
            if (current) setError(reason(cause));
          });
      }, POLL_MS);
    };
    poll();
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [installing, client]);

  const act = useCallback(
    async (work: (active: VoiceEngineClient) => Promise<VoiceEngineView>) => {
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

  if (view === null)
    return error === null ? null : (
      <SettingGroup label="Voice mode">
        <li className="fy-vs-body">
          <p role="alert" className="fy-vs-note" data-tone="warn">
            {error}
          </p>
        </li>
        <KeepOnPhoneRow />
      </SettingGroup>
    );
  return (
    <VoiceModePanel
      view={view}
      talk={talk}
      hear={hear}
      reply={reply}
      busy={busy}
      error={error}
      onInstall={() => void act(installVoiceEngine)}
      onRemove={() => void act(removeVoiceEngine)}
    />
  );
}
