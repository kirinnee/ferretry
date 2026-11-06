/**
 * Settings › Behaviour › LIVE VOICE (F137 slice 6; `docs/voice.md` › Live voice).
 *
 * The device's own choices for Live, the hands-free voice chat: how long a quiet ends your turn, the
 * countdown you can watch before a send, whether Live reads the reply, whether the screen stays on, and
 * its sounds and buzzes. Everything is kept in this browser (`fy-live-voice-v1` and `fy-live-voice-extras-v1`,
 * see `lib/voice-chat/live-settings.ts`) and nothing here is sent anywhere. The card says "This device" in the
 * same badge as Read replies aloud.
 *
 * THE VOICE IS NOT CHOSEN TWICE. Live reads with the voice, speed and length from "Read replies aloud"
 * (the picker next door); this card shows what they are now, in words, and moves you to that picker.
 *
 * SENDING WITHOUT A COUNTDOWN IS A DECISION. The countdown slider runs from half a second; "no countdown" is
 * its own stored choice (`sendWithoutCountdown`), off until the person switches it on, and while it is on the card
 * says in plain words that Live will send without one. A slider dragged to the end, or a damaged number in
 * storage, can therefore never do it by accident.
 *
 * Same touch rules as the sections around it, tightened: every control is at least 48 px, every switch is a
 * real `role="switch"` that says On or Off in words (never colour alone), nothing autofocuses, nothing moves.
 */

import { type ReactNode, useId } from 'react';
import { useDeviceVoiceSettingsStore, useLiveVoiceSettings } from '../../hooks/use-live-voice-settings.ts';
import { useReadAloudController } from '../../hooks/use-read-aloud.ts';
import { cn } from '../../lib/class-names.ts';
import {
  COUNTDOWN_MAX_MS,
  COUNTDOWN_STEP_MS,
  type LiveVoiceSettings,
  type LiveVoiceSettingsPatch,
  type LiveVoiceSettingsStore,
  PAUSE_OPTIONS,
  READING_LENGTH_OPTIONS,
} from '../../lib/voice-chat/live-settings.ts';
import type { SpeakerVoice } from '../../lib/voice-chat/ports.ts';
import { Badge, Button } from '../../shell/primitives.tsx';
import { READ_REPLIES_ALOUD_ID, useSpeakerVoices } from './auto-read-settings.tsx';
import { BestVoiceWhere, VoiceWhere } from './voice-picker.tsx';

const LIVE_VOICE_APPLIES_NOTE =
  'Pause, countdown, reading and screen-on apply the next time you press Live. Sounds and buzzes apply at once.';

const READ_ON_EXPLANATION =
  'After the ferret answers, Live reads the last message out loud (code, tables and pictures are described, not read), then listens again. The microphone is off while it reads.';
const READ_OFF_EXPLANATION = 'Live shows the reply on screen and listens again. Nothing is read out loud.';
const READ_NO_VOICE_NOTE = 'This browser has no built-in voice, so Live shows replies on screen and cannot read them.';

export const SCREEN_READER_HINT = 'Using a screen reader? Turn off Read replies aloud.';
const SCREEN_READER_WHY =
  'A screen reader and Live’s voice would talk over each other. Live still shows the reply and listens again.';

const COUNTDOWN_ZERO_WARNING = 'Live will send without a countdown';
const COUNTDOWN_ZERO_DETAIL =
  'The moment Live has your words, it sends them. You will not have time to press Hold. Turn this off to get a countdown back.';
const COUNTDOWN_EXPLANATION =
  'After you stop talking, your words wait in the message box for this long. Hold stops the send; Send now skips the wait.';

const COUNTDOWN_NONE_EXPLANATION =
  'There is no countdown. Live sends your words the moment it has them; Hold and Send now have nothing left to do.';

const AWAKE_ON_EXPLANATION =
  'Live asks the browser to keep the screen on while it is on. Some browsers and battery savers say no; Live then tells you the screen may turn off.';
const AWAKE_OFF_EXPLANATION =
  'The screen can turn off while Live is on. On a phone, Live may stop listening when it does.';

const SOUNDS_ON_EXPLANATION =
  'Short tones: rising when Live starts listening, a blip when your message is sent, a two-note chime when the reply is ready, falling when it stops.';
const SOUNDS_OFF_EXPLANATION = 'Live is silent: the words on the Live bar are the only signal.';

const BUZZ_ON_EXPLANATION =
  'On an Android phone, a short buzz when your message is sent and when the reply is ready. iPhones cannot buzz from a web page.';
const BUZZ_OFF_EXPLANATION = 'No buzzing.';

const CLEANUP_LINE = 'Live uses Fix-style clean-up; Polish is treated as Fix.';
const CLEANUP_DETAIL =
  'Fix repairs misheard words and punctuation. If it takes longer than 3 seconds, Live sends your words as you said them.';

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

export interface LiveVoiceSettingsSectionProps {
  /** Test and harness seam: the settings store, instead of the app's. */
  readonly store?: LiveVoiceSettingsStore | null;
}

export function LiveVoiceSettingsSection({ store: given }: LiveVoiceSettingsSectionProps) {
  const appStore = useDeviceVoiceSettingsStore();
  const store = given === undefined ? appStore : given;
  const { settings, update, persisted } = useLiveVoiceSettings(store);
  const controller = useReadAloudController();
  const voices = useSpeakerVoices(controller);
  const countdownId = useId();
  const noCountdown = settings.sendWithoutCountdown;
  const chosen = voices.find(voice => voice.id === settings.voiceId) ?? null;

  return (
    <section aria-label="Live voice" className="fy-live-settings fy-ar flex flex-col gap-4" data-live-voice-settings="">
      <div className="flex flex-col items-start gap-2">
        <Badge tone="pend">This device</Badge>
        <p className="m-0 text-meta leading-base text-faint">{LIVE_VOICE_APPLIES_NOTE}</p>
      </div>

      {/* ---- how long a quiet ends your turn ---- */}
      <Group id="live-pause" label="Pause before sending">
        <div role="radiogroup" aria-labelledby="live-pause-label" className="grid grid-cols-1 gap-2">
          {PAUSE_OPTIONS.map(option => {
            const checked = settings.pause === option.id;
            return (
              <label
                key={option.id}
                className={cn(
                  'flex min-h-[56px] min-w-0 cursor-pointer flex-col items-start justify-center rounded-control border px-control-x py-2 text-left transition-colors',
                  'has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-accent',
                  checked
                    ? 'border-accent bg-accent-soft text-accent'
                    : 'border-border bg-surface-2 text-fg hover:border-accent',
                )}
              >
                <input
                  type="radio"
                  name="live-pause"
                  className="sr-only"
                  checked={checked}
                  onChange={() => update({ pause: option.id })}
                />
                <span className="text-ui font-semibold">
                  {option.label} · {option.seconds.toFixed(1)} s{checked ? ' · chosen' : ''}
                </span>
                <span className="text-meta leading-base text-muted">{option.description}</span>
              </label>
            );
          })}
        </div>
        <p className="m-0 text-meta leading-base text-muted">
          How long you stay quiet before Live decides you have finished talking.
        </p>
      </Group>

      {/* ---- the countdown ---- */}
      <Group id="live-countdown" label="Countdown before send">
        <p className="m-0 text-meta leading-base text-muted">
          {noCountdown ? COUNTDOWN_NONE_EXPLANATION : COUNTDOWN_EXPLANATION}
        </p>
        {noCountdown ? null : (
          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between gap-3">
              <label htmlFor={countdownId} className="text-meta text-muted">
                Wait
              </label>
              <output htmlFor={countdownId} className="text-ui font-semibold tabular-nums">
                {seconds(settings.countdownMs)}
              </output>
            </div>
            <input
              id={countdownId}
              type="range"
              min={COUNTDOWN_STEP_MS}
              max={COUNTDOWN_MAX_MS}
              step={COUNTDOWN_STEP_MS}
              value={Math.max(COUNTDOWN_STEP_MS, settings.countdownMs)}
              aria-valuetext={`${seconds(settings.countdownMs)} before it sends`}
              className="min-h-[48px] w-full accent-[var(--accent)]"
              onChange={event => update({ countdownMs: Number(event.target.value) })}
            />
            <div className="flex justify-between text-meta text-faint">
              <span>Shorter</span>
              <span>Longer</span>
            </div>
          </div>
        )}
        <SwitchRow
          label="Send without a countdown"
          checked={noCountdown}
          onChange={on => update({ sendWithoutCountdown: on })}
          on=""
          off="Off by default. With it off, every message waits for the countdown."
          describedBy="live-countdown-zero"
          attribute="data-live-no-countdown"
          hideExplanation={noCountdown}
        />
        {noCountdown ? (
          <div
            id="live-countdown-zero"
            role="alert"
            data-live-countdown-warning=""
            className="flex flex-col gap-1 rounded-control border border-warn bg-surface-2 p-3"
          >
            <p className="m-0 text-ui font-semibold text-warn">{COUNTDOWN_ZERO_WARNING}</p>
            <p className="m-0 text-meta leading-base text-muted">{COUNTDOWN_ZERO_DETAIL}</p>
          </div>
        ) : null}
      </Group>

      {/* ---- reading the reply ---- */}
      <Group id="live-reading">
        <SwitchRow
          label="Read replies aloud in Live"
          checked={settings.liveRead}
          onChange={liveRead => update({ liveRead })}
          on={READ_ON_EXPLANATION}
          off={READ_OFF_EXPLANATION}
          describedBy="live-read-explanation"
          attribute="data-live-read"
        />
        {controller.supported ? null : (
          <p className="m-0 text-meta leading-base text-warn" role="status">
            {READ_NO_VOICE_NOTE}
          </p>
        )}
        {settings.liveRead && !settings.screenReaderHintSeen ? <ScreenReaderHint update={update} /> : null}
        <ReadingSummary reading={settings.liveRead} settings={settings} voice={chosen} />
      </Group>

      {/* ---- the screen ---- */}
      <Group id="live-awake">
        <SwitchRow
          label="Keep screen on"
          checked={settings.keepAwake}
          onChange={keepAwake => update({ keepAwake })}
          on={AWAKE_ON_EXPLANATION}
          off={AWAKE_OFF_EXPLANATION}
          describedBy="live-awake-explanation"
          attribute="data-live-awake"
        />
      </Group>

      {/* ---- sounds and buzzes ---- */}
      <Group id="live-sounds" label="Sounds and buzzes">
        <SwitchRow
          label="Sounds"
          checked={settings.earcons}
          onChange={earcons => update({ earcons })}
          on={SOUNDS_ON_EXPLANATION}
          off={SOUNDS_OFF_EXPLANATION}
          describedBy="live-sounds-explanation"
          attribute="data-live-sounds"
        />
        <SwitchRow
          label="Buzz on phones"
          checked={settings.haptics}
          onChange={haptics => update({ haptics })}
          on={BUZZ_ON_EXPLANATION}
          off={BUZZ_OFF_EXPLANATION}
          describedBy="live-buzz-explanation"
          attribute="data-live-buzz"
        />
      </Group>

      {/* ---- clean-up: read-only ---- */}
      <Group id="live-cleanup" label="Clean-up in Live">
        <p className="m-0 rounded-control border border-border bg-surface-2 p-3 text-ui font-semibold leading-base">
          {CLEANUP_LINE}
        </p>
        <p className="m-0 text-meta leading-base text-muted">{CLEANUP_DETAIL}</p>
      </Group>

      {persisted ? null : (
        <p className="m-0 text-meta leading-base text-warn" role="status">
          These choices could not be saved — this browser is refusing storage — so they will reset when you reload.
        </p>
      )}
    </section>
  );
}

/** One part of the card. A group that is a single switch has no heading: the switch is named by its own words. */
function Group({
  id,
  label,
  children,
}: {
  readonly id: string;
  readonly label?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2" data-live-group={id}>
      {label === undefined ? null : (
        <h4 id={`${id}-label`} className="m-0 text-ui font-semibold">
          {label}
        </h4>
      )}
      {children}
    </div>
  );
}

interface SwitchRowProps {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
  /** What On means, in words; shown while on. */
  readonly on: string;
  /** What Off means, in words; shown while off. */
  readonly off: string;
  /** The id the switch is described by: the explanation, or a warning that replaces it. */
  readonly describedBy: string;
  /** A `data-*` hook for tests and the screenshot harness. */
  readonly attribute: `data-${string}`;
  /** Another element carries the words; this row shows only its switch. */
  readonly hideExplanation?: boolean;
}

/**
 * A real switch, the same one as Auto-read replies (`fy-ar-switch` in `read-aloud.css`): the whole row is the target
 * (≥ 48 px), a visible track and thumb, and the state said in words, never colour alone.
 */
function SwitchRow({
  label,
  checked,
  onChange,
  on,
  off,
  describedBy,
  attribute,
  hideExplanation = false,
}: SwitchRowProps) {
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={describedBy}
        {...{ [attribute]: '' }}
        onClick={() => onChange(!checked)}
        className="fy-ar-switch fy-ar-switch-row min-h-[48px]"
      >
        <span className="fy-ar-switch-name min-w-0">{label}</span>
        <span className="fy-ar-switch-state">
          <span className="fy-ar-switch-word">{checked ? 'On' : 'Off'}</span>
          <span aria-hidden="true" className="fy-ar-track">
            <span className="fy-ar-thumb" />
          </span>
        </span>
      </button>
      {hideExplanation ? null : (
        <p id={describedBy} className="m-0 text-meta leading-base text-muted">
          {checked ? on : off}
        </p>
      )}
    </div>
  );
}

/** The one-time hint for people who use a screen reader: answered once, then gone. */
function ScreenReaderHint({ update }: { readonly update: (patch: LiveVoiceSettingsPatch) => void }) {
  return (
    <div
      role="note"
      data-live-screen-reader-hint=""
      className="flex flex-col gap-2 rounded-control border border-border bg-surface-2 p-3"
    >
      <p className="m-0 text-ui font-semibold leading-base">{SCREEN_READER_HINT}</p>
      <p className="m-0 text-meta leading-base text-muted">{SCREEN_READER_WHY}</p>
      <div className="flex flex-wrap gap-2">
        <Button
          className="min-h-[48px] px-4"
          data-turn-off=""
          onClick={() => update({ liveRead: false, screenReaderHintSeen: true })}
          type="button"
        >
          Turn it off
        </Button>
        <Button
          className="min-h-[48px] px-4"
          data-got-it=""
          onClick={() => update({ screenReaderHintSeen: true })}
          type="button"
          variant="ghost"
        >
          Got it
        </Button>
      </div>
    </div>
  );
}

const lengthWords = (maxSeconds: number | null): string => {
  const known = READING_LENGTH_OPTIONS.find(option => option.seconds === maxSeconds);
  if (known === undefined) return `${maxSeconds} seconds`;
  return known.label;
};

/** What Live reads with, in words, and the way to change it: the picker lives in "Read replies aloud". */
function ReadingSummary({
  reading,
  settings,
  voice,
}: {
  readonly reading: boolean;
  readonly settings: LiveVoiceSettings;
  readonly voice: SpeakerVoice | null;
}) {
  const move = (): void => {
    const target = document.getElementById(READ_REPLIES_ALOUD_ID);
    if (target === null) return;
    target.scrollIntoView({ block: 'start' });
    target.focus({ preventScroll: true });
  };
  const rows: readonly (readonly [string, ReactNode])[] = [
    ['Voice', <SummaryVoice key="voice" voice={voice} />],
    ['Speed', `${settings.rate.toFixed(1)}×`],
    ['Longest reading', lengthWords(settings.maxSeconds)],
  ];
  return (
    <div
      className="flex flex-col gap-3 rounded-control border border-border bg-surface-2 p-3"
      data-live-reading-summary=""
    >
      <p className="m-0 text-meta text-muted">
        {reading
          ? 'Live reads with the voice, speed and length you chose in Read replies aloud.'
          : 'If you turn reading on, Live will read with the voice, speed and length you chose in Read replies aloud.'}
      </p>
      <dl className="m-0 flex flex-col gap-1">
        {rows.map(([name, value]) => (
          <div key={name} className="flex flex-wrap gap-x-3">
            <dt className="w-full shrink-0 text-meta text-muted sm:w-36">{name}</dt>
            <dd className="m-0 min-w-0 flex-1 break-words text-ui font-semibold leading-base">{value}</dd>
          </div>
        ))}
      </dl>
      <Button className="min-h-[48px] self-start px-4" data-change-voice="" onClick={move} type="button">
        Change voice, speed and length
      </Button>
    </div>
  );
}

/**
 * The name AND who gets the text, each on its own line so neither is ever cut off: a voice that sends text away
 * says so here, where the choice is summarised, as well as in the picker.
 */
function SummaryVoice({ voice }: { readonly voice: SpeakerVoice | null }) {
  return (
    <span className="fy-live-summary-voice flex flex-col gap-1" data-live-summary-voice="">
      <span>{voice === null ? 'Best voice for this device' : voice.name}</span>
      <span className="text-meta font-normal text-muted">
        {voice === null ? <BestVoiceWhere /> : <VoiceWhere voice={voice} />}
      </span>
    </span>
  );
}
