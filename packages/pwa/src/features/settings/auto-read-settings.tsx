/**
 * Settings › This device › Voice › READ REPLIES ALOUD (F137 slice 2; `docs/voice.md` › Auto-read replies).
 *
 * The device's own choices for hearing a ferret's reply: whether a finished turn is read on its own
 * ("Auto-read replies", OFF until chosen), which voice, how fast, how long one reading may run, and
 * whether to read only the last message of the turn or every one. Everything is kept in this browser
 * (`fy-live-voice-v1`) and nothing here is sent anywhere: the voices are the ones built into the device.
 *
 * Same touch rules as the dictation section above it: no autofocus, 44 px targets, every state said in
 * words (never colour alone), nothing that moves.
 *
 * THE PICKER SAYS WHICH VOICES SEND TEXT AWAY. A voice the browser marks `localService` speaks on the
 * device; the others (Chrome's "Google …" voices) send the text to their maker, so they sit under their
 * own heading and say so in the option's own label. Browsers load their voices late, so the list is read
 * again a few times if it is empty at first.
 */

import { useEffect, useState } from 'react';
import { useDeviceVoiceSettingsStore, useLiveVoiceSettings } from '../../hooks/use-live-voice-settings.ts';
import { useReadAloudController } from '../../hooks/use-read-aloud.ts';
import { cn } from '../../lib/class-names.ts';
import {
  type LiveVoiceSettings,
  type LiveVoiceSettingsPatch,
  type LiveVoiceSettingsStore,
  READING_LENGTH_OPTIONS,
  readOptionsOf,
  WHAT_TO_READ_OPTIONS,
} from '../../lib/voice-chat/live-settings.ts';
import type { SpeakerVoice } from '../../lib/voice-chat/ports.ts';
import type { ReadAloudController } from '../../lib/voice-chat/read-aloud.ts';
import { voiceLabel } from '../../lib/voice-chat/voice-choice.ts';
import { Badge, Button } from '../../shell/primitives.tsx';

const AUTO_READ_EXPLANATION =
  'When a ferret finishes a turn, this device reads its reply aloud. It reads the last message of the turn, describes code, tables and pictures instead of reading them, and says “Done. No message.” for a turn that wrote nothing. If the ferret asks you something, it reads the question and its options — you still answer by tapping. Tap anywhere or press a key to stop. The microphone is never used.';

const AUTO_READ_OFF_EXPLANATION = 'Off by default. Nothing is read aloud unless you press Read aloud on a message.';

const OLDER_DAEMON_NOTE =
  'Auto-read needs a newer Ferretry daemon on this machine. On an older one nothing is read on its own, but Read aloud on a message still works.';

const READ_ALOUD_PRIVACY_NOTE =
  'Replies are spoken with the voices built into this device. Nothing is sent to your machine or stored. A voice marked “sends text away” hands the words to its maker to speak them.';

const PREVIEW_SENTENCE = 'This is how a reply will sound.';
const PREVIEW_KEY = 'preview:voice-settings';

/** The voices, again a few times: a browser lists them only after it has loaded them. */
export function useSpeakerVoices(controller: ReadAloudController): readonly SpeakerVoice[] {
  const [voices, setVoices] = useState<readonly SpeakerVoice[]>(() => controller.voices());
  useEffect(() => {
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const look = (): void => {
      const found = controller.voices();
      setVoices(previous => (previous.length === found.length ? previous : found));
      tries += 1;
      if (found.length === 0 && tries < 10) timer = setTimeout(look, 300);
    };
    look();
    return () => {
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [controller]);
  return voices;
}

const BEST_VOICE = 'best';

/** The section's address: Live voice's "Change voice, speed and length" moves focus here. */
export const READ_REPLIES_ALOUD_ID = 'read-replies-aloud';

export interface AutoReadSettingsProps {
  /** Test and harness seam: the settings store, instead of the app's. */
  readonly store?: LiveVoiceSettingsStore | null;
}

export function AutoReadSettings({ store: given }: AutoReadSettingsProps) {
  const appStore = useDeviceVoiceSettingsStore();
  const store = given === undefined ? appStore : given;
  const { settings, update, persisted } = useLiveVoiceSettings(store);
  const controller = useReadAloudController();
  if (!controller.supported) {
    return (
      <section aria-label="Read replies aloud" className="flex flex-col gap-2" data-auto-read-settings="">
        <Header />
        <p className="rounded-control border border-border bg-surface-2 p-3 text-meta leading-base text-faint">
          This browser has no built-in voice, so replies cannot be read aloud here.
        </p>
      </section>
    );
  }
  return <Supported controller={controller} persisted={persisted} settings={settings} update={update} />;
}

function Header() {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <h4 className="m-0 text-ui font-semibold">Read replies aloud</h4>
      <Badge tone="pend">This device</Badge>
    </div>
  );
}

function Supported({
  controller,
  settings,
  update,
  persisted,
}: {
  readonly controller: ReadAloudController;
  readonly settings: LiveVoiceSettings;
  readonly update: (patch: LiveVoiceSettingsPatch) => void;
  readonly persisted: boolean;
}) {
  const voices = useSpeakerVoices(controller);
  const [previewing, setPreviewing] = useState(false);
  const local = voices.filter(voice => voice.local);
  const remote = voices.filter(voice => !voice.local);
  const chosen = voices.find(voice => voice.id === settings.voiceId) ?? null;
  // A stored voice this device no longer has falls back to the best one, and the picker says so.
  const missing = settings.voiceId !== null && chosen === null && voices.length > 0;
  const rateText = `${settings.rate.toFixed(1)}×`;

  const preview = (): void => {
    if (previewing) {
      controller.stop();
      setPreviewing(false);
      return;
    }
    setPreviewing(true);
    controller.read(PREVIEW_KEY, PREVIEW_SENTENCE, { ...readOptionsOf(settings), maxSeconds: 30 });
  };
  // The preview button follows the reading it started, so it flips back when the sentence ends or is stopped.
  useEffect(() => {
    if (!previewing) return;
    const sync = (): void => {
      const state = controller.getState();
      if (state.key !== PREVIEW_KEY || state.status !== 'reading') setPreviewing(false);
    };
    sync();
    return controller.subscribe(sync);
  }, [controller, previewing]);
  // Leaving the screen silences a preview still going.
  useEffect(
    () => () => {
      if (controller.getState().key === PREVIEW_KEY) controller.stop();
    },
    [controller],
  );

  return (
    <section
      aria-label="Read replies aloud"
      className="flex flex-col gap-3 outline-none focus-visible:ring-2 focus-visible:ring-accent"
      data-auto-read-settings=""
      id={READ_REPLIES_ALOUD_ID}
      tabIndex={-1}
    >
      <Header />
      <p className="text-meta leading-base text-muted">{READ_ALOUD_PRIVACY_NOTE}</p>

      {/* ---- the switch ---- */}
      <div className="flex flex-col gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={settings.autoRead}
          aria-describedby="auto-read-explanation"
          onClick={() => update({ autoRead: !settings.autoRead })}
          className={cn(
            'flex min-h-[44px] items-center justify-between gap-3 rounded-control border px-control-x py-2 text-left transition-colors',
            settings.autoRead ? 'border-accent bg-accent-soft text-accent' : 'border-border bg-surface-2 text-fg',
          )}
        >
          <span className="text-ui font-semibold">Auto-read replies</span>
          <span className="text-meta">{settings.autoRead ? 'On' : 'Off'}</span>
        </button>
        <p id="auto-read-explanation" className="text-meta leading-base text-muted">
          {settings.autoRead ? AUTO_READ_EXPLANATION : AUTO_READ_OFF_EXPLANATION}
        </p>
        <p className="text-meta leading-base text-faint" data-auto-read-needs-daemon="">
          {OLDER_DAEMON_NOTE}
        </p>
      </div>

      {/* ---- the voice, with a preview ---- */}
      <div className="flex flex-col gap-2">
        <label htmlFor="auto-read-voice" className="text-ui font-semibold">
          Voice
        </label>
        <div className="flex flex-wrap items-stretch gap-2">
          <select
            id="auto-read-voice"
            className="kt-input min-h-[44px] min-w-full sm:min-w-0 sm:flex-1"
            value={chosen === null ? BEST_VOICE : chosen.id}
            onChange={event => update({ voiceId: event.target.value === BEST_VOICE ? null : event.target.value })}
          >
            <option value={BEST_VOICE}>Best voice for this device</option>
            {local.length > 0 ? (
              <optgroup label="On this device">
                {local.map(voice => (
                  <option key={voice.id} value={voice.id}>
                    {voiceLabel(voice)} — {voice.lang}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {remote.length > 0 ? (
              <optgroup label="Sends text away">
                {remote.map(voice => (
                  <option key={voice.id} value={voice.id}>
                    {voiceLabel(voice)} — {voice.lang}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
          <Button className="min-h-[44px] px-4" data-preview="" onClick={preview} type="button">
            {previewing ? 'Stop preview' : 'Preview voice'}
          </Button>
        </div>
        {chosen === null ? null : (
          <p className="m-0 break-words text-meta leading-base text-muted" data-chosen-voice="">
            Chosen: {voiceLabel(chosen)} — {chosen.lang}
          </p>
        )}
        {voices.length === 0 ? (
          <p className="text-meta leading-base text-faint" role="status">
            This device has not listed its voices yet. The best voice is used until it does.
          </p>
        ) : null}
        {chosen !== null && !chosen.local ? (
          <p className="text-meta leading-base text-warn" role="status">
            {chosen.name} sends the text of each reply to its maker to be spoken.
          </p>
        ) : null}
        {missing ? (
          <p className="text-meta leading-base text-faint" role="status">
            The voice you chose is not on this device any more, so the best voice is used.
          </p>
        ) : null}
      </div>

      {/* ---- speed ---- */}
      <div className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-3">
          <label htmlFor="auto-read-rate" className="text-ui font-semibold">
            Speed
          </label>
          <output htmlFor="auto-read-rate" className="text-ui tabular-nums">
            {rateText}
          </output>
        </div>
        <input
          id="auto-read-rate"
          type="range"
          min={0.8}
          max={2}
          step={0.1}
          value={settings.rate}
          aria-valuetext={`${rateText} normal speed`}
          className="min-h-[44px] w-full accent-[var(--accent)]"
          onChange={event => update({ rate: Number(event.target.value) })}
        />
        <div className="flex justify-between text-meta text-faint">
          <span>Slower</span>
          <span>Faster</span>
        </div>
      </div>

      {/* ---- how long one reading may run ---- */}
      <div className="flex flex-col gap-2">
        <label htmlFor="auto-read-length" className="text-ui font-semibold">
          Longest reading
        </label>
        <select
          id="auto-read-length"
          className="kt-input min-h-[44px]"
          value={settings.maxSeconds === null ? 'none' : String(settings.maxSeconds)}
          onChange={event => update({ maxSeconds: event.target.value === 'none' ? null : Number(event.target.value) })}
        >
          {READING_LENGTH_OPTIONS.map(option => (
            <option key={String(option.seconds)} value={option.seconds === null ? 'none' : String(option.seconds)}>
              {option.label}
            </option>
          ))}
        </select>
        <p className="text-meta leading-base text-muted">
          A longer reply stops at this length and says “There’s more on screen.” Faster speech fits more words in the
          same time.
        </p>
      </div>

      {/* ---- what to read ---- */}
      <div className="flex flex-col gap-2">
        <span id="auto-read-what" className="text-ui font-semibold">
          What to read
        </span>
        <div role="radiogroup" aria-labelledby="auto-read-what" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {WHAT_TO_READ_OPTIONS.map(option => {
            const checked = settings.whatToRead === option.id;
            return (
              <label
                key={option.id}
                className={cn(
                  'flex min-h-[44px] min-w-0 cursor-pointer flex-col items-start justify-center rounded-control border px-control-x py-2 text-left transition-colors',
                  'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent',
                  checked
                    ? 'border-accent bg-accent-soft text-accent'
                    : 'border-border bg-surface-2 text-fg hover:border-accent',
                )}
              >
                <input
                  type="radio"
                  name="auto-read-what"
                  className="sr-only"
                  checked={checked}
                  onChange={() => update({ whatToRead: option.id })}
                />
                <span className="text-ui font-semibold">{option.label}</span>
                <span className="text-meta leading-base text-muted">{option.description}</span>
              </label>
            );
          })}
        </div>
      </div>

      {!persisted && (
        <p className="text-meta leading-base text-warn" role="status">
          These choices could not be saved — this browser is refusing storage — so they will reset when you reload.
        </p>
      )}
    </section>
  );
}
