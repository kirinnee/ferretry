/**
 * FIRST RUN › THIS DEVICE › "Voice" › Voice mode: the part of the Voice step that sets up hands-free chat on the machine.
 *
 * It is Settings › Voice › Voice mode, drawn inside the step, so there is one implementation and nothing to keep in step:
 * install the machine's speech engine (the machine's own public install route; whatever the engine fetches or falls back to
 * is its business, not this page's), pick the reply voice (Kokoro on the machine, ElevenLabs only with the person's own key),
 * and a Talk to test that stops by itself after 10 seconds.
 *
 * It is OPTIONAL and says so: nothing here is needed to go on (the step's Next never waits for it, and the frame's Later
 * leaves it for Settings › Voice). It writes nothing to this device; each press is the machine's own install or setting.
 */
import type { ComponentProps } from 'react';
import type { DaemonConnection } from '../../shell-voice.ts';
import { VoiceModeSettings } from '../settings/voice-mode-settings.tsx';

/** The test is short on purpose: a first run only needs to know the words arrive. */
export const TALK_TEST_MS = 10_000;

const SETUP_LINE =
  'Talk to a ferret hands-free: your machine listens and replies out loud. Finish later in Settings › Voice.';

type SettingsProps = ComponentProps<typeof VoiceModeSettings>;

export interface VoiceModeSetupProps {
  readonly connection: DaemonConnection;
  /** A suite's own machine and sockets; the page uses the shell's client and the real microphone. */
  readonly createClient?: SettingsProps['createClient'];
  readonly talk?: Omit<NonNullable<SettingsProps['talk']>, 'limitMs'> | undefined;
  readonly hear?: SettingsProps['hear'];
}

export function VoiceModeSetup({ connection, createClient, talk, hear }: VoiceModeSetupProps) {
  return (
    <section className="fy-vm-setup fy-vs" aria-label="Voice mode" data-voice-mode-setup="">
      <h3 className="fy-vm-setup-head">
        Voice mode
        <span className="rounded-control bg-surface-2 px-2 py-0.5 text-meta font-medium text-faint">Optional</span>
      </h3>
      <p className="fy-voice-step-line">{SETUP_LINE}</p>
      <VoiceModeSettings
        connection={connection}
        {...(createClient === undefined ? {} : { createClient })}
        talk={{ ...talk, limitMs: TALK_TEST_MS }}
        hear={hear}
      />
    </section>
  );
}
