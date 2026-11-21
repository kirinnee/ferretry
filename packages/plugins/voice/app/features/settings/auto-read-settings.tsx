/**
 * Settings › This device › Voice › READ REPLIES ALOUD (F137 slice 2; `docs/voice.md` › Auto-read replies).
 *
 * The device's own choices for hearing a ferret's reply: whether a finished turn is read on its own
 * ("Auto-read replies", OFF until chosen), which voice, how fast, how long one reading may run, and
 * whether to read only the last message of the turn or every one. Everything is kept in this browser
 * (`fy:voice:live-settings`) and nothing here is sent anywhere: the voices are the ones built into the device.
 *
 * Same touch rules as the dictation section above it, a little stricter: no autofocus, every control at least
 * 44 px tall (48 px on a phone), every state said in words (never colour alone), nothing that moves.
 *
 * THE PICKER SAYS WHICH VOICES SEND TEXT AWAY. A voice the browser marks `localService` speaks on the
 * device; the others (Chrome's "Google …" voices) send the text to their maker, so they sit under their
 * own heading and say so on their own line under the name (`voice-picker.tsx` — never clipped). Browsers load their voices late, so the list is read
 * again a few times if it is empty at first.
 */

import { useEffect, useState } from 'react';
import { useDeviceVoiceSettingsStore, useLiveVoiceSettings } from '../../hooks/use-live-voice-settings.ts';
import { useReadAloudController } from '../../hooks/use-read-aloud.ts';
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
import { voiceNote } from '../../lib/voice-chat/voice-choice.ts';
import { Button, ChoiceCards, SelectBox, SettingGroup, SettingRow, SettingSwitch } from '../../shell-voice.ts';
import './voice-settings.css';
import { VoicePicker } from './voice-picker.tsx';

const AUTO_READ_EXPLANATION =
  'When a ferret finishes a turn, this device reads its reply aloud. It reads the last message of the turn, describes code, tables and pictures instead of reading them, and says “Done. No message.” for a turn that wrote nothing. If the ferret asks you something, it reads the question and its options — you still answer by tapping. Tap anywhere or press a key to stop. The microphone is never used.';

const AUTO_READ_OFF_EXPLANATION = 'Off by default. Nothing is read aloud on its own.';

const OLDER_MACHINE_NOTE =
  'Auto-read needs a newer Ferretry on your computer. Until you update the Ferretry app on your computer, nothing is read on its own, but Read aloud on a message still works.';

const READ_ALOUD_PRIVACY_NOTE =
  'Replies are spoken with the voices built into this device. Nothing is sent to your machine or stored. A voice marked “sends text away” hands the words to its maker to speak them.';

const PREVIEW_SENTENCE = 'This is how a reply will sound.';
const PREVIEW_KEY = 'preview:voice-settings';

/** The voices, again a few times: a browser lists them only after it has loaded them. */
function useSpeakerVoices(controller: ReadAloudController): readonly SpeakerVoice[] {
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

export interface AutoReadSettingsProps {
  /** Test and harness seam: the settings store, instead of the app's. */
  readonly store?: LiveVoiceSettingsStore | null;
  /** True only when the connected computer is known to run an older Ferretry that cannot date a turn: the one case the note below applies. */
  readonly olderMachine?: boolean;
  /** Harness seam: the voice list is open on arrival. */
  readonly startOpen?: boolean;
}

export function AutoReadSettings({ store: given, olderMachine = false, startOpen = false }: AutoReadSettingsProps) {
  const appStore = useDeviceVoiceSettingsStore();
  const store = given === undefined ? appStore : given;
  const { settings, update, persisted } = useLiveVoiceSettings(store);
  const controller = useReadAloudController();
  if (!controller.supported) {
    return (
      <div data-auto-read-settings="">
        <SettingGroup label="Read replies aloud">
          <li className="fy-vs-body">
            <p className="fy-vs-note">This browser has no built-in voice, so replies cannot be read aloud here.</p>
          </li>
        </SettingGroup>
      </div>
    );
  }
  return (
    <Supported
      controller={controller}
      olderMachine={olderMachine}
      startOpen={startOpen}
      persisted={persisted}
      settings={settings}
      update={update}
    />
  );
}

function Supported({
  controller,
  settings,
  update,
  persisted,
  olderMachine,
  startOpen,
}: {
  readonly olderMachine: boolean;
  readonly startOpen: boolean;
  readonly controller: ReadAloudController;
  readonly settings: LiveVoiceSettings;
  readonly update: (patch: LiveVoiceSettingsPatch) => void;
  readonly persisted: boolean;
}) {
  const voices = useSpeakerVoices(controller);
  const [previewing, setPreviewing] = useState(false);
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
    <div data-auto-read-settings="">
      <SettingGroup label="Read replies aloud">
        <SettingRow
          settingId="auto-read"
          name="Auto-read replies"
          hint="This device speaks a finished reply"
          explanation={
            <div className="flex flex-col gap-2" id="auto-read-explanation">
              <p className="m-0">{settings.autoRead ? AUTO_READ_EXPLANATION : AUTO_READ_OFF_EXPLANATION}</p>
              <p className="m-0">{READ_ALOUD_PRIVACY_NOTE}</p>
            </div>
          }
          control={labelId => (
            <SettingSwitch
              checked={settings.autoRead}
              labelledBy={labelId}
              onChange={autoRead => update({ autoRead })}
            />
          )}
        >
          {olderMachine ? (
            <div className="fy-vs-body">
              <p className="fy-vs-note" data-tone="warn" data-auto-read-needs-update="" role="status">
                {OLDER_MACHINE_NOTE}
              </p>
            </div>
          ) : null}
        </SettingRow>

        <SettingRow
          settingId="read-aloud-button"
          name="Show Read aloud on each reply"
          hint="Off by default."
          control={labelId => (
            <SettingSwitch
              checked={settings.readAloudButton}
              labelledBy={labelId}
              onChange={readAloudButton => update({ readAloudButton })}
            />
          )}
        />

        <SettingRow
          name="Voice"
          hint="Which voice on this device reads"
          control={() => (
            <Button className="fy-ar-target px-4" data-preview="" onClick={preview} type="button">
              {previewing ? 'Stop preview' : 'Preview voice'}
            </Button>
          )}
        >
          <div className="fy-vs-body">
            <span id="auto-read-voice-label" className="sr-only">
              Voice
            </span>
            <VoicePicker
              chosen={chosen}
              defaultOpen={startOpen}
              onChoose={voiceId => update({ voiceId })}
              voices={voices}
            />
            {voices.length === 0 ? (
              <p className="fy-vs-note" role="status">
                This device has not listed its voices yet. The best voice is used until it does.
              </p>
            ) : null}
            {chosen !== null && !chosen.local ? (
              <p className="fy-vs-note" data-tone="warn" role="status">
                {voiceNote(chosen)}
              </p>
            ) : null}
            {missing ? (
              <p className="fy-vs-note" role="status">
                The voice you chose is not on this device any more, so the best voice is used.
              </p>
            ) : null}
          </div>
        </SettingRow>

        <SettingRow
          name="Speed"
          hint="Slower to faster"
          wide
          control={labelId => (
            <div className="fy-vs-field fy-vs-wide">
              <input
                aria-labelledby={labelId}
                id="auto-read-rate"
                type="range"
                min={0.8}
                max={2}
                step={0.1}
                value={settings.rate}
                aria-valuetext={`${rateText} normal speed`}
                className="fy-ar-range min-w-0 flex-1"
                onChange={event => update({ rate: Number(event.target.value) })}
              />
              <output htmlFor="auto-read-rate" className="w-10 shrink-0 text-ui tabular-nums">
                {rateText}
              </output>
            </div>
          )}
        />

        <SettingRow
          name="Longest reading"
          hint="A longer reply stops at this length"
          wide
          explanation="A longer reply stops at this length and says “There’s more on screen.” Faster speech fits more words in the same time."
          control={() => (
            <SelectBox
              className="fy-ar-target fy-vs-wide"
              id="auto-read-length"
              label="Longest reading"
              onChange={chosen => update({ maxSeconds: chosen === 'none' ? null : Number(chosen) })}
              options={READING_LENGTH_OPTIONS.map(option => ({
                value: option.seconds === null ? 'none' : String(option.seconds),
                label: option.label,
              }))}
              value={settings.maxSeconds === null ? 'none' : String(settings.maxSeconds)}
            />
          )}
        />

        <SettingRow name="What to read" hint="The last message, or more">
          <div className="fy-vs-body">
            <ChoiceCards
              label="What to read"
              value={settings.whatToRead}
              onChange={id => update({ whatToRead: id as LiveVoiceSettings['whatToRead'] })}
              options={WHAT_TO_READ_OPTIONS.map(option => ({
                id: option.id,
                title: option.label,
                line: option.description,
              }))}
            />
          </div>
        </SettingRow>

        {!persisted && (
          <li className="fy-vs-body">
            <p className="fy-vs-note" data-tone="warn" role="status">
              These choices could not be saved — this browser is refusing storage — so they will reset when you reload.
            </p>
          </li>
        )}
      </SettingGroup>
    </div>
  );
}
