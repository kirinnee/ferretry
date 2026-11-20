/**
 * The voice plugin's surfaces: the Voice and Speed-ups settings tabs, the dictation control that sits in the
 * composer's tools slot and Read aloud in an assistant message's footer. Each is wrapped in a boundary that gives it the plugin client and this device's voice stores.
 */

import type { PanelProps, PluginClient } from '@ferretry/kernel/manifest';
import { type ReactNode, useEffect, useState } from 'react';
import type { ConversationAboveComposerProps, ConversationRowProps } from '@ferretry/plugin-conversation/contract';
import { AutoReadChip } from './components/auto-read-chip.tsx';
import { DictationControl } from './components/dictation-control.tsx';
import { ReadAloudControl } from './components/read-aloud.tsx';
import { DictationDebugSettings } from './features/settings/dictation-debug-settings.tsx';
import { DictationSettings } from './features/settings/dictation-settings.tsx';
import { SpeedupKeysSettings } from './features/settings/speedup-keys-settings.tsx';
import { VoiceCleanupSettings } from './features/settings/voice-cleanup-settings.tsx';
import { TranscriptionLogSettings } from './features/settings/transcription-log-settings.tsx';
import { SpeedupsStepContainer, VoiceStepContainer } from './features/onboarding/step-panels.tsx';
import { SpeedupsSurface } from './features/speedups/speedups-surface.tsx';
import { useAutoRead } from './hooks/use-auto-read.ts';
import { useSttSettings } from './hooks/use-stt-settings.ts';
import { needsInputOf } from './lib/voice-chat/reply-picker.ts';
import type { SpeechAssets } from './lib/stt/on-device-voices.ts';
import { createVoiceStore, StoreProvider, useSttSettingsStore, type VoiceStore } from './lib/voice-store.tsx';
import { useComposerDraft } from '@ferretry/app';
import { daemonConnection, SettingGroup, VoiceClientProvider } from './shell-voice.ts';

/** The daemon every call goes to is the one the shell's client is for; the connection only carries an identity. */
const THIS_DAEMON = daemonConnection({
  daemonId: 'this-daemon',
  baseUrl: 'https://this-daemon.invalid',
  deviceId: 'this-device',
});

/** What the build supplies to the page's one voice store. */
export interface VoiceSurfaceOptions {
  /** Where the build put each on-device engine's worker and binary; absent, every on-device engine reads "built without". */
  readonly speechAssets?: SpeechAssets | null;
  /**
   * The same, read from the bundler's module when the page first needs a voice. A dynamic import, because
   * `speech-assets.ts` names `?worker&url` queries only a bundler resolves: a plain import would stop every suite
   * that loads the real app halves. A load that fails leaves the engines reading "built without", with the reason logged.
   */
  readonly loadSpeechAssets?: () => Promise<SpeechAssets | null>;
}

/** Builds the surfaces over one plugin client and ONE voice store for the page. */
export function voiceSurfaces(client: PluginClient, options: VoiceSurfaceOptions = {}) {
  let held: VoiceStore | undefined;
  let loading: Promise<VoiceStore> | undefined;
  const build = (speechAssets: SpeechAssets | null | undefined): VoiceStore => {
    held ??= createVoiceStore(speechAssets === undefined ? {} : { speechAssets });
    return held;
  };
  /** The page's store at once when its assets are in hand; `undefined` while they are still being loaded. */
  const ready = (): VoiceStore | undefined => {
    if (held !== undefined) return held;
    return options.loadSpeechAssets === undefined ? build(options.speechAssets) : undefined;
  };
  const whenReady = (): Promise<VoiceStore> => {
    loading ??= (options.loadSpeechAssets?.() ?? Promise.resolve(options.speechAssets)).then(
      assets => build(assets),
      (failure: unknown) => {
        console.warn(`voice: the on-device speech assets could not be loaded: ${String(failure)}`);
        return build(null);
      },
    );
    return loading;
  };

  function Boundary({ children }: { readonly children?: ReactNode }) {
    const [created, setCreated] = useState<VoiceStore | undefined>(ready);
    useEffect(() => {
      if (created !== undefined) return undefined;
      let live = true;
      void whenReady().then(store => {
        if (live) setCreated(store);
      });
      return () => {
        live = false;
      };
    }, [created]);
    if (created === undefined) return null;
    return (
      <VoiceClientProvider client={client}>
        <StoreProvider store={created}>{children}</StoreProvider>
      </VoiceClientProvider>
    );
  }

  function VoiceSettingsBody() {
    const stt = useSttSettingsStore();
    if (stt === null) return null;
    return <VoiceSettingsSections store={stt} />;
  }

  function VoiceSettingsSections({
    store: sttStore,
  }: {
    readonly store: NonNullable<ReturnType<typeof useSttSettingsStore>>;
  }) {
    const dictation = useSttSettings(sttStore);
    return (
      <>
        <div className="fy-vs">
          <h3 className="m-0 mb-4 text-row font-semibold text-fg">Voice</h3>
          <DictationSettings {...dictation} />
          <SpeedupKeysSettings />
          <SettingGroup label="Privacy and debugging">
            <TranscriptionLogSettings />
            <DictationDebugSettings />
          </SettingGroup>
        </div>
      </>
    );
  }

  const VoiceTab = () => (
    <Boundary>
      <VoiceSettingsBody />
    </Boundary>
  );

  const VoiceCleanupTab = () => (
    <Boundary>
      <div className="fy-vs">
        <h3 className="m-0 mb-4 text-row font-semibold text-fg">Voice clean-up</h3>
        <VoiceCleanupSettings daemon={THIS_DAEMON} />
      </div>
    </Boundary>
  );

  const SpeedupsTab = () => (
    <Boundary>
      <SpeedupsSurface connection={THIS_DAEMON} />
    </Boundary>
  );

  function DictationPanelBody({ subject }: { readonly subject?: string }) {
    const stt = useSttSettingsStore();
    const binding = useComposerDraft();
    if (stt === null || binding === null) return null;
    return <DictationPanelControl store={stt} binding={binding} subject={subject} />;
  }

  function DictationPanelControl({
    store: sttStore,
    binding,
    subject,
  }: {
    readonly store: NonNullable<ReturnType<typeof useSttSettingsStore>>;
    readonly binding: NonNullable<ReturnType<typeof useComposerDraft>>;
    readonly subject?: string | undefined;
  }) {
    const { settings } = useSttSettings(sttStore);
    const sessionId = subject ?? binding.ferretId;
    return (
      <DictationControl
        daemon={THIS_DAEMON}
        {...(sessionId === undefined ? {} : { sessionId })}
        {...(binding.readConversation === undefined ? {} : { readConversation: binding.readConversation })}
        draft={binding.draft}
        {...(binding.selectionRef === undefined ? {} : { selectionRef: binding.selectionRef })}
        {...(binding.composerRef === undefined ? {} : { composerRef: binding.composerRef })}
        onDraftChange={binding.onDraftChange}
        settings={settings}
      />
    );
  }

  // First run's two client steps (Onboarding's steps screen hands each its host as `props.step`).
  const VoiceStepPanel = (props: PanelProps) => (
    <Boundary>
      <VoiceStepContainer step={props.step} />
    </Boundary>
  );
  const SpeedupsStepPanel = (props: PanelProps) => (
    <Boundary>
      <SpeedupsStepContainer step={props.step} />
    </Boundary>
  );

  const DictationPanel = (props: { readonly subject?: string }) => (
    <Boundary>
      <DictationPanelBody {...props} />
    </Boundary>
  );

  /**
   * "Read aloud" on an assistant message (`conversation.row-actions`): the chat hands the row, and only an assistant's own
   * words are read. The text is the daemon's redacted reading of the transcript, which is what the voice speaks.
   */
  const ReadAloudPanel = ({ entry }: { readonly subject?: string } & Partial<ConversationRowProps>) =>
    entry === undefined || entry.kind !== 'assistant' ? null : (
      <Boundary>
        <ReadAloudControl entryId={entry.id} text={entry.text} />
      </Boundary>
    );

  /**
   * "Read replies aloud" (`conversation.above-composer`): the chat hands the rows, whose turn it is, what the ferret waits
   * on and the send ledger's ids, and the auto-read hook reads a finished reply (or the question a ferret asks) aloud while
   * the device setting is on. It draws the "Reading the reply" chip only while a reading it started is going on.
   */
  function AutoReadPanelBody({
    subject,
    rows,
    turn,
    needsInput,
    sends,
  }: { readonly subject: string } & ConversationAboveComposerProps) {
    const handle = useAutoRead({
      scope: subject,
      entries: rows,
      authoritative: turn.live,
      turn: turn.state,
      turnStateAt: turn.at,
      question: needsInputOf(needsInput),
      sends,
    });
    return <AutoReadChip onStop={handle.stop} reading={handle.reading} />;
  }

  const AutoReadPanel = ({
    subject,
    rows,
    turn,
    needsInput,
    sends,
  }: { readonly subject?: string } & Partial<ConversationAboveComposerProps>) =>
    subject === undefined ||
    rows === undefined ||
    turn === undefined ||
    needsInput === undefined ||
    sends === undefined ? null : (
      <Boundary>
        <AutoReadPanelBody needsInput={needsInput} rows={rows} sends={sends} subject={subject} turn={turn} />
      </Boundary>
    );

  return {
    VoiceTab,
    VoiceCleanupTab,
    SpeedupsTab,
    DictationPanel,
    ReadAloudPanel,
    AutoReadPanel,
    VoiceStepPanel,
    SpeedupsStepPanel,
  };
}
