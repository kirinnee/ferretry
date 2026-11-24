/**
 * Settings › Voice › Voice mode › Reply voice source: whether a ferret's spoken lines are read by Kokoro on the machine (the
 * default, free) or by an ElevenLabs voice on the owner's own account. ElevenLabs is optional and OFF until chosen here:
 *
 *   source → "On this machine" | "ElevenLabs"            (writes `replyVoice.provider` in voice.yaml; the daemon HOLDS the
 *                                                         move to ElevenLabs until the owner confirms it, and this says so)
 *   key    → the Speed-ups key row for `ELEVENLABS_API_KEY` (write-only: pasted once, never shown again, Test is free)
 *   voice  → "Load my voices" reads the account's list (one use of the key, nothing spoken, nothing billed); picking one
 *            writes its id and name
 *   today  → characters spoken so far against the day's limit, so a bill is never a surprise
 *
 * WHAT LEAVES THE MACHINE is said in the row: the text of each spoken line, to ElevenLabs. Never your voice, never the chat.
 */
import { AlertTriangle, ListMusic } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  ELEVENLABS_PATH,
  type ElevenLabsStatus,
  ElevenLabsStatusSchema,
  type ElevenLabsVoice,
  type ElevenLabsVoices,
  ElevenLabsVoicesSchema,
  type ReplyProvider,
} from '../../../contract/index.ts';
import {
  DEFAULT_REPLY_VOICE_CHOICE,
  readReplyVoice,
  type ReplyVoiceChoice,
  type ReplyVoicePatch,
  withReplyVoice,
} from '../../lib/reply-voice-config.ts';
import {
  changeRefusalSentence,
  type DaemonConnection,
  readConfigFile,
  Segmented,
  SelectBox,
  SettingRow,
  writeConfigFile,
} from '../../shell-voice.ts';
import { SpeedupKeyRow, type SpeedupClientFactory } from '../speedups/key-row.tsx';
import { HearIt, type HearItProps } from './reply-voice.tsx';
import type { VoiceEngineClient } from './voice-engine-api.ts';

const VOICE_FILE = 'voice.yaml';
const number = (value: number): string => value.toLocaleString('en-US');
const reason = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

type Saved = { readonly kind: 'applied' } | { readonly kind: 'pending'; readonly message: string };

export interface ReplyVoiceSourceState {
  readonly choice: ReplyVoiceChoice;
  readonly status: ElevenLabsStatus | null;
  readonly voices: ElevenLabsVoices | null;
  readonly busy: 'saving' | 'loading' | null;
  readonly error: string | null;
  /** Said when a change is saved but the machine holds it for the owner to confirm. */
  readonly pending: string | null;
  readonly save: (patch: ReplyVoicePatch) => Promise<void>;
  readonly loadVoices: () => Promise<void>;
}

/** What the machine's `voice.yaml` and ElevenLabs status say, and the three acts a person has here. */
export function useReplyVoiceSource(client: VoiceEngineClient | null): ReplyVoiceSourceState {
  const [choice, setChoice] = useState<ReplyVoiceChoice>(DEFAULT_REPLY_VOICE_CHOICE);
  const [status, setStatus] = useState<ElevenLabsStatus | null>(null);
  const [voices, setVoices] = useState<ElevenLabsVoices | null>(null);
  const [busy, setBusy] = useState<'saving' | 'loading' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    if (client === null) return undefined;
    let current = true;
    void readConfigFile(client, VOICE_FILE)
      .then(file => current && setChoice(readReplyVoice(file.text) ?? DEFAULT_REPLY_VOICE_CHOICE))
      .catch(() => undefined);
    void client
      .request(ELEVENLABS_PATH, ElevenLabsStatusSchema, { quiet: true })
      .then(read => current && setStatus(read))
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [client]);

  const save = useCallback(
    async (patch: ReplyVoicePatch): Promise<void> => {
      if (client === null) return;
      setBusy('saving');
      setError(null);
      try {
        const file = await readConfigFile(client, VOICE_FILE);
        const text = withReplyVoice(file.text, patch);
        if (text === null) {
          setError('voice.yaml has a problem; fix it in the Files panel first.');
          return;
        }
        const written = await writeConfigFile(client, VOICE_FILE, text, file.etag);
        setChoice(readReplyVoice(text) ?? DEFAULT_REPLY_VOICE_CHOICE);
        const saved: Saved =
          written.outcome === 'pending'
            ? {
                kind: 'pending',
                message: `Saved, but not in effect until you confirm it: ${(written.pending?.changes ?? []).join('; ')}.`,
              }
            : { kind: 'applied' };
        setPending(saved.kind === 'pending' ? saved.message : null);
        setStatus(await client.request(ELEVENLABS_PATH, ElevenLabsStatusSchema, { quiet: true }));
      } catch (cause) {
        setError(changeRefusalSentence(cause));
      } finally {
        setBusy(null);
      }
    },
    [client],
  );

  const loadVoices = useCallback(async (): Promise<void> => {
    if (client === null) return;
    setBusy('loading');
    setError(null);
    try {
      setVoices(await client.request(`${ELEVENLABS_PATH}/voices`, ElevenLabsVoicesSchema));
    } catch (cause) {
      setError(reason(cause));
    } finally {
      setBusy(null);
    }
  }, [client]);

  return { choice, status, voices, busy, error, pending, save, loadVoices };
}

const SOURCES: readonly { readonly id: ReplyProvider; readonly label: string }[] = [
  { id: 'kokoro', label: 'On this machine' },
  { id: 'elevenlabs', label: 'ElevenLabs' },
];

function VoicePicker({ state }: { readonly state: ReplyVoiceSourceState }) {
  const { choice, voices, busy } = state;
  const listed: readonly ElevenLabsVoice[] = voices?.voices ?? [];
  const chosen = choice.voiceId;
  // The saved voice is always an option, even before the list was loaded or when the account no longer lists it.
  const options = [
    ...(chosen !== undefined && !listed.some(voice => voice.id === chosen)
      ? [{ value: chosen, label: choice.voiceName ?? chosen }]
      : []),
    ...listed.map(voice => ({
      value: voice.id,
      label: voice.category === undefined ? voice.name : `${voice.name} · ${voice.category}`,
    })),
  ];
  return (
    <div className="fy-vs-field" data-voice-eleven-picker="">
      {options.length > 0 && (
        <SelectBox
          className="fy-vs-wide min-h-[44px]"
          id="reply-voice-elevenlabs-voice"
          label="ElevenLabs voice"
          value={chosen ?? ''}
          placeholder="Choose a voice…"
          options={options}
          onChange={id => {
            const picked = listed.find(voice => voice.id === id);
            if (picked !== undefined) void state.save({ voice: { id: picked.id, name: picked.name } });
          }}
        />
      )}
      <button
        type="button"
        className="kt-btn"
        disabled={busy !== null}
        onClick={() => void state.loadVoices()}
        data-voice-eleven-load=""
      >
        <ListMusic size={14} aria-hidden="true" /> {busy === 'loading' ? 'Loading…' : 'Load my voices'}
      </button>
    </div>
  );
}

export interface ReplyVoiceSourceRowProps {
  readonly state: ReplyVoiceSourceState;
  readonly machine: string;
  readonly connection: DaemonConnection;
  readonly createClient?: SpeedupClientFactory | undefined;
  /** Whether speech to text is installed too: only then can a stream open to speak the sample. */
  readonly speechReady: boolean;
  readonly hear?: Omit<HearItProps, 'machine'> | undefined;
}

export function ReplyVoiceSourceRow({
  state,
  machine,
  connection,
  createClient,
  speechReady,
  hear,
}: ReplyVoiceSourceRowProps) {
  const { choice, status, busy, error, pending } = state;
  const eleven = choice.provider === 'elevenlabs';
  const usage = status?.usage;
  // A move the machine is holding is not in effect, so the machine would still speak in Kokoro: there is nothing to hear yet.
  const ready = eleven && pending === null && status?.keySet === true && choice.voiceId !== undefined;
  return (
    <SettingRow
      name="Reply voice source"
      hint={eleven ? 'ElevenLabs' : 'On this machine'}
      wide
      dataAttributes={{ 'data-voice-reply-source': choice.provider }}
      explanation={
        <div className="flex min-w-0 flex-col gap-1">
          <p className="m-0">
            Who reads a ferret&apos;s spoken lines. The default is the free voice on {machine}. ElevenLabs is optional
            and uses your own account: the text of each spoken line goes to ElevenLabs to be turned into sound, and
            ElevenLabs bills you for it by the character. It never receives your voice or the rest of the chat.
          </p>
          <p className="m-0">
            If ElevenLabs is not ready or its limit for the day is reached, this device&apos;s own voice reads the line.
          </p>
        </div>
      }
    >
      <div className="fy-vs-body">
        <Segmented
          label="Reply voice source"
          value={choice.provider}
          disabled={busy === 'saving'}
          options={SOURCES.map(source => ({ id: source.id, label: source.label }))}
          onChange={next => void state.save({ provider: next })}
        />
        {pending !== null && (
          <p className="fy-vs-note" role="status" data-tone="warn" data-voice-reply-pending="">
            {pending}
          </p>
        )}
        {eleven && (
          <>
            <SpeedupKeyRow connection={connection} provider="elevenlabs" createClient={createClient} />
            <p className="fy-vs-note text-fg">
              {choice.voiceId === undefined ? 'No voice chosen yet.' : `Voice: ${choice.voiceName ?? choice.voiceId}.`}
            </p>
            <VoicePicker state={state} />
            {state.voices?.failure !== undefined && (
              <p
                role="alert"
                className="fy-vs-note"
                data-tone="warn"
                data-voice-eleven-failure={state.voices.failure.code}
              >
                <AlertTriangle size={14} aria-hidden="true" className="mr-1 inline align-text-bottom" />
                {state.voices.failure.sentence}
              </p>
            )}
            {usage !== undefined && (
              <p className="fy-vs-note" role="status" data-voice-eleven-usage={usage.usedChars}>
                Spoken today: {number(usage.usedChars)} of {number(usage.dailyChars)} characters. To change the limit,
                edit <code>replyVoice</code> in voice.yaml; raising it asks you to confirm.
              </p>
            )}
            {ready && speechReady && <HearIt machine={machine} maker="ElevenLabs" {...hear} />}
            {ready && !speechReady && <p className="fy-vs-note">Install speech on {machine} above to hear it.</p>}
          </>
        )}
        {error !== null && (
          <p role="alert" className="fy-vs-note" data-tone="warn">
            {error}
          </p>
        )}
      </div>
    </SettingRow>
  );
}
